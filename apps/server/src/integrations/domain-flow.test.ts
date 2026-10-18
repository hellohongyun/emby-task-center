import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { createDatabase, type DatabaseHandle } from "@emby-task-center/database/client";
import {
  auditLogs,
  contentArticles,
  contentProviders,
  mediaItems,
  mediaTasks,
  userNotifications,
} from "@emby-task-center/database/schema";
import { createManualTask } from "@emby-task-center/task-domain/task-service";
import { createApp } from "../app";
import { staticCredentialVerifier } from "../auth/test-session";
import { createLibraryService } from "../library/service";
import type { TmdbClient } from "../tmdb/client";
import type { EmailNotifier } from "../notifications/email-service";
import { refreshAirProgressCycle } from "../scheduling/progress-cycle";
import { writeSettings } from "../settings/store";
import { loginAsMemberAfterAdminCreate } from "../test-support/member-login";

const sharedPassword = "family-password";
const sessionSecret = "session-signing-secret";

/**
 * 跨模块深链：门户会员会话 ↔ 管理端内容/偏好接口。
 *
 * 投稿链路（公开投稿 → 转任务 → 入库通知 → 额度台账）已整体删除：
 * 投稿端点、subscriptions/submissions.ts 与 inlibrary-notify.ts 都不在了，
 * 所以这里只覆盖仍然存在的门户/管理端联动，以及任务已播进度刷新。
 */
describe("domain deep flow (门户会话 + 管理端内容/偏好)", () => {
  let directory: string;
  let database: DatabaseHandle;
  let server: Server;
  let baseUrl: string;
  let sentMails: Array<{ to: string; subject: string }>;
  let tmdbDetailStatus = "Returning Series";

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "emby-domain-flow-"));
    database = createDatabase(join(directory, "app.sqlite"));
    tmdbDetailStatus = "Returning Series";
    sentMails = [];
    const tmdb: TmdbClient = {
      search: async () => [],
      details: async (mediaType) =>
        ({
          status: mediaType === "movie" ? "Released" : tmdbDetailStatus,
          mediaType: mediaType as "movie" | "tv",
        }) as never,
      seasonProgress: async () => ({
        seasonNumber: 1,
        airedEpisodes: 10,
        totalEpisodes: 20,
        lastAirDate: null,
        nextAirDate: null,
      }),
      airedEpisodeCount: async () => 20,
      seasonEpisodes: async () => [],
    };
    const email: EmailNotifier = {
      configured: true,
      sendTest: async () => undefined,
      retryPending: async () => undefined,
      sendNotification: async (to, subject) => {
        sentMails.push({ to, subject });
      },
    };
    const app = createApp({
      database: database.db,
      auth: { sessionSecret, verifyCredentials: staticCredentialVerifier(sharedPassword) },
      tmdb,
      library: createLibraryService([]),
      integrationServices: {
        emby: {
          configured: false,
          systemInfo: async () => {
            throw new Error("unused");
          },
          verify: async () => true,
        },
        email,
      },
    });
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });

  async function adminCookie(): Promise<string> {
    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: sharedPassword }),
    });
    expect(login.status).toBe(200);
    return (login.headers.get("set-cookie") ?? "").split(";")[0];
  }

  async function memberCookie(): Promise<string> {
    const admin = await adminCookie();
    return loginAsMemberAfterAdminCreate(baseUrl, database.db, admin, "member@example.com");
  }

  it("member session → portal read-only endpoints → admin content/preferences all respond", async () => {
    const member = await memberCookie();

    // ---------- 门户会员摘要（原 /api/public/submissions/mine 的位置） ----------
    const me = await fetch(`${baseUrl}/api/public/subscriptions/member`, { headers: { cookie: member } });
    expect(me.status).toBe(200);
    const meBody = (await me.json()) as { email: string; member: { status: string } };
    expect(meBody.email).toBe("member@example.com");
    expect(meBody.member.status).toBe("active");
    // 未登录读不到
    expect((await fetch(`${baseUrl}/api/public/subscriptions/member`)).status).toBe(401);

    // ---------- 站内通知中心与额度台账已整体删除（投稿链路没了，没有写入方） ----------
    // 路由一旦不存在，请求就落到管理端会话门之后，所以是 401 而不是 404。
    expect((await fetch(`${baseUrl}/api/public/notifications`, { headers: { cookie: member } })).status).toBe(401);
    expect((await fetch(`${baseUrl}/api/public/quota/ledger`, { headers: { cookie: member } })).status).toBe(401);
    expect(database.db.select().from(userNotifications).all()).toHaveLength(0);

    // ---------- 门户只读内容 ----------
    // 平台须知正文里用占位符引用服务器地址：对外返回时应替换成当前配置的 Emby 地址，
    // 而不是把部署地址写死在文章里。
    database.db
      .update(contentArticles)
      .set({ content: "2. 服务器地址：{{embyServerAddress}}（端口 443）；" })
      .where(eq(contentArticles.code, "emby-setup"))
      .run();
    writeSettings(database.db, { "emby.baseUrl": "https://emby.example.test" });
    const articles = (await (
      await fetch(`${baseUrl}/api/public/articles`, { headers: { cookie: member } })
    ).json()) as { articles: Array<{ code: string; content: string }> };
    expect(Array.isArray(articles.articles)).toBe(true);
    const setup = articles.articles.find((item) => item.code === "emby-setup");
    expect(setup?.content).toContain("https://emby.example.test");
    expect(setup?.content).not.toContain("{{embyServerAddress}}");
    const platforms = (await (
      await fetch(`${baseUrl}/api/public/platforms`, { headers: { cookie: member } })
    ).json()) as { platforms: unknown[] };
    expect(Array.isArray(platforms.platforms)).toBe(true);
    const mailPrefs = await fetch(`${baseUrl}/api/public/mail-preferences`, {
      method: "PUT",
      headers: { cookie: member, "content-type": "application/json" },
      body: JSON.stringify({ mailType: "membership_reminder", enabled: false }),
    });
    expect(mailPrefs.status).toBe(200);
    // 已下线的类型必须被拒：「任务更新通知」整条链删除（2026-09）后，
    // 接口若还收下它，前端就会显示一个不存在的开关。
    const retiredMailType = await fetch(`${baseUrl}/api/public/mail-preferences`, {
      method: "PUT",
      headers: { cookie: member, "content-type": "application/json" },
      body: JSON.stringify({ mailType: "task_update", enabled: false }),
    });
    expect(retiredMailType.status).toBe(400);

    // ---------- 管理端：内容源 / 审计 ----------
    // 日报（/api/metrics/daily）已随追更指标下线（2026-09）整条删除：它的唯一写入方是被删的
    // follow-admin 路由，两个派生指标也都是追更口径。
    const admin = await adminCookie();

    const providers = (await (
      await fetch(`${baseUrl}/api/content-providers`, { headers: { cookie: admin } })
    ).json()) as { providers: Array<{ code: string; enabled: boolean }> };
    expect(providers.providers.find((p) => p.code === "tmdb")?.enabled).toBe(true);
    const putRes = await fetch(`${baseUrl}/api/content-providers/tmdb`, {
      method: "PUT",
      headers: { cookie: admin, "content-type": "application/json" },
      body: JSON.stringify({ enabled: false, priority: 5 }),
    });
    expect(putRes.status).toBe(200);
    expect(database.db.select().from(contentProviders).where(eq(contentProviders.code, "tmdb")).get()?.enabled).toBe(
      false,
    );
    expect(
      database.db
        .select()
        .from(auditLogs)
        .all()
        .some((a) => a.action === "provider.updated"),
    ).toBe(true);
  });

  it("refreshes the aired episode count of an unfinished task on the air progress cycle", async () => {
    const task = createManualTask(database.db, {
      mediaType: "tv",
      taskType: "ingest",
      title: "仙逆2",
    });
    // 未绑定 TMDB 的任务不参与已播进度刷新（没有 tmdbId 就无从查询）——这里直接补上关联。
    const mediaItemId = database.db
      .select({ id: mediaTasks.mediaItemId })
      .from(mediaTasks)
      .where(eq(mediaTasks.id, task.id))
      .get()!.id;
    database.db.update(mediaItems).set({ tmdbId: 70523 }).where(eq(mediaItems.id, mediaItemId)).run();

    const tmdb: TmdbClient = {
      search: async () => [],
      details: async () => ({ status: "Returning Series", mediaType: "tv" }) as never,
      seasonProgress: async () => ({
        seasonNumber: 1,
        airedEpisodes: 12,
        totalEpisodes: 24,
        lastAirDate: null,
        nextAirDate: null,
      }),
      airedEpisodeCount: async () => 12,
      seasonEpisodes: async () => [],
    };
    await refreshAirProgressCycle(database.db, tmdb);
    const row = database.db.select().from(mediaTasks).where(eq(mediaTasks.id, task.id)).get()!;
    expect(row.airProgress).toBe(12);
  });
});
