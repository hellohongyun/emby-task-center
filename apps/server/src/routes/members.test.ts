import { createPublicSessionManager } from "../subscriptions/public-session";
import { addSubmissionUser } from "../subscriptions/membership";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDatabase, type DatabaseHandle } from "@emby-task-center/database/client";
import { createApp } from "../app";
import { staticCredentialVerifier } from "../auth/test-session";
import { createLibraryService } from "../library/service";
import type { TmdbClient } from "../tmdb/client";
import type { EmailNotifier } from "../notifications/email-service";

const sharedPassword = "family-password";
const sessionSecret = "session-signing-secret";

describe("member (submission_users) admin API", () => {
  let directory: string;
  let database: DatabaseHandle;
  let server: Server;
  let baseUrl: string;
  let mail: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "emby-members-"));
    database = createDatabase(join(directory, "app.sqlite"));
    const tmdb: TmdbClient = {
      search: async () => [
        {
          id: 603,
          mediaType: "movie",
          title: "黑客帝国",
          originalTitle: "The Matrix",
          releaseYear: 1999,
          overview: "",
          posterUrl: "https://image.tmdb.org/p/matrix.jpg",
          backdropUrl: null,
        },
      ],
      details: async () => {
        throw new Error("unused");
      },
      seasonProgress: async () => ({
        seasonNumber: 1,
        airedEpisodes: 1,
        totalEpisodes: 1,
        lastAirDate: null,
        nextAirDate: null,
      }),
      airedEpisodeCount: async () => 1,
      seasonEpisodes: async () => [],
    };
    mail = vi.fn().mockResolvedValue(undefined);
    const email: EmailNotifier = {
      configured: true,
      sendTest: async () => undefined,
      retryPending: async () => undefined,
      sendNotification: mail,
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
    vi.unstubAllGlobals();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });

  async function login(): Promise<string> {
    const response = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: sharedPassword }),
    });
    expect(response.status).toBe(200);
    return (response.headers.get("set-cookie") ?? "").split(";")[0];
  }

  it("creates, lists, updates and removes a member", async () => {
    const cookie = await login();
    const created = await fetch(`${baseUrl}/api/submission-users`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ email: "member@example.com", processPerDay: 5, note: "朋友" }),
    });
    expect(created.status).toBe(201);
    const { user } = (await created.json()) as { user: { id: number; email: string } };
    expect(user.email).toBe("member@example.com");

    // 同邮箱重复添加被拒
    const again = await fetch(`${baseUrl}/api/submission-users`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ email: "member@example.com" }),
    });
    expect(again.status).toBe(409);

    const list = (await (await fetch(`${baseUrl}/api/submission-users`, { headers: { cookie } })).json()) as {
      users: Array<{ id: number; status: string; processPerDay: number | null }>;
    };
    expect(list.users).toHaveLength(1);
    expect(list.users[0]).toMatchObject({ id: user.id, status: "active", processPerDay: 5 });

    // 到期后状态变 expired（会员仍可登录，只是不能再投稿）
    const past = new Date(Date.now() - 86_400_000).toISOString();
    const updated = await fetch(`${baseUrl}/api/submission-users/${user.id}`, {
      method: "PUT",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ subscriptionExpiresAt: past }),
    });
    expect(updated.status).toBe(200);
    const after = (await (await fetch(`${baseUrl}/api/submission-users`, { headers: { cookie } })).json()) as {
      users: Array<{ status: string }>;
    };
    expect(after.users[0]?.status).toBe("expired");

    const removed = await fetch(`${baseUrl}/api/submission-users/${user.id}`, {
      method: "DELETE",
      headers: { cookie },
    });
    expect(removed.status).toBe(204);
    const empty = (await (await fetch(`${baseUrl}/api/submission-users`, { headers: { cookie } })).json()) as {
      users: unknown[];
    };
    expect(empty.users).toHaveLength(0);
  });

  it("syncs orphan Emby accounts on demand (no-op when Emby is not configured)", async () => {
    const cookie = await login();
    const response = await fetch(`${baseUrl}/api/submission-users/sync-emby`, { method: "POST", headers: { cookie } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ linked: [], adopted: [], skipped: [] });
  });

  it("exposes a scoped TMDB search to the public page", async () => {
    const anonymous = await fetch(`${baseUrl}/api/public/tmdb/search?q=matrix`);
    expect(anonymous.status).toBe(401);
    addSubmissionUser(database.db, { email: "search@example.invalid" });
    const memberCookie = createPublicSessionManager(sessionSecret).issueCookie("search@example.invalid");
    const search = await fetch(`${baseUrl}/api/public/tmdb/search?q=matrix`, { headers: { cookie: memberCookie } });
    expect(search.status).toBe(200);
    const body = (await search.json()) as { results: Array<{ tmdbId: number; title: string }> };
    expect(body.results[0]).toMatchObject({ tmdbId: 603, title: "黑客帝国" });
  });

  it("keeps the submission-only settings out of the registry", async () => {
    const cookie = await login();
    // 投稿审核设置（上映缓冲天数）已随投稿功能删除：路由不再存在
    const gone = await fetch(`${baseUrl}/api/settings/submission-release`, { headers: { cookie } });
    expect(gone.status).toBe(404);
    // 配置中心不再暴露 submission.* / mail.submission* 设置项
    const settings = (await (await fetch(`${baseUrl}/api/settings`, { headers: { cookie } })).json()) as {
      groups: Array<{ group: string; settings: Array<{ key: string }> }>;
    };
    const keys = settings.groups.flatMap((group) => group.settings.map((item) => item.key));
    expect(keys.some((key) => key.startsWith("submission."))).toBe(false);
    expect(keys.some((key) => key.startsWith("mail.submission"))).toBe(false);
    // 邮件默认开关只剩会员提醒：「默认发送：任务更新」随任务更新通知整条链下线（2026-09）
    expect(keys).toContain("mail.membershipReminder");
    expect(keys).not.toContain("mail.taskUpdate");
    // 会员组：Emby 账号自动绑定的默认天数
    expect(keys).toContain("member.autoLinkDays");
  });
});
