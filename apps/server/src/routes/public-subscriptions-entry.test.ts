import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDatabase, type DatabaseHandle } from "@emby-task-center/database/client";
import { submissionUsers, verificationCodes } from "@emby-task-center/database/schema";
import { createApp } from "../app";
import { staticCredentialVerifier } from "../auth/test-session";
import { createLibraryService } from "../library/service";
import type { TmdbClient } from "../tmdb/client";
import type { EmbyClient } from "../integrations/emby-client";
import type { EmailNotifier } from "../notifications/email-service";

/**
 * 登录页「下一步」的分流判断（`/entry`）。
 *
 * 页面第一步只有一个邮箱输入框，点「下一步」时由这里回答：该进登录，还是该进注册页（卡密）。
 * 判定只看**注册过没有**——过期也算注册过，他要能正常登录，续费走「我的」页。
 *
 * 这个接口零副作用（不发信、不签发验证码），但它的回答会暴露"某邮箱是否注册过"，所以单独
 * 限流；本文件最后一个用例守的就是那条限流。
 */
const sharedPassword = "family-password";
const sessionSecret = "session-signing-secret";

describe("public subscription entry routing", () => {
  let directory: string;
  let database: DatabaseHandle;
  let server: Server;
  let baseUrl: string;
  let emailsSent: Array<{ to: string; subject: string; text: string }>;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "emby-entry-"));
    database = createDatabase(join(directory, "app.sqlite"));
    emailsSent = [];
    const email: EmailNotifier = {
      configured: true,
      sendTest: async () => undefined,
      retryPending: async () => undefined,
      sendNotification: async (to, subject, text) => {
        emailsSent.push({ to, subject, text });
      },
    };
    const tmdb: TmdbClient = {
      search: async () => [],
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
    const app = createApp({
      database: database.db,
      auth: { sessionSecret, verifyCredentials: staticCredentialVerifier(sharedPassword) },
      tmdb,
      library: createLibraryService([]),
      integrationServices: { email, emby: { configured: false } as EmbyClient },
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

  function seedMember(email: string, expiresAt: Date) {
    const timestamp = new Date().toISOString();
    database.db
      .insert(submissionUsers)
      .values({
        email,
        enabled: true,
        subscriptionExpiresAt: expiresAt.toISOString(),
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .run();
  }

  async function postEntry(email: string): Promise<Response> {
    return fetch(`${baseUrl}/api/public/subscriptions/entry`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email }),
    });
  }

  it("没注册过的邮箱 → 走注册页（needsCard），且不发信、不签发验证码", async () => {
    const res = await postEntry("stranger@example.com");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ registered: false, needsCard: true, expired: false });
    expect(emailsSent).toHaveLength(0);
    expect(database.db.select().from(verificationCodes).all()).toHaveLength(0);
  });

  it("注册过的邮箱 → 走登录（免卡密）", async () => {
    seedMember("member@example.com", new Date(Date.now() + 30 * 86_400_000));
    const res = await postEntry("member@example.com");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ registered: true, needsCard: false, expired: false });
  });

  it("过期会员同样算注册过 → 走登录，只在回执里标记 expired", async () => {
    seedMember("lapsed@example.com", new Date(Date.now() - 86_400_000));
    const res = await postEntry("lapsed@example.com");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ registered: true, needsCard: false, expired: true });
  });

  it("分流接口会限流：连着问也会被挡住（不能让脚本拿它批量扫邮箱）", async () => {
    let sawRateLimit = false;
    for (let i = 0; i < 15 && !sawRateLimit; i++) {
      const res = await postEntry(`probe-${i}@example.com`);
      if (res.status === 429) sawRateLimit = true;
    }
    expect(sawRateLimit).toBe(true);
  });
});
