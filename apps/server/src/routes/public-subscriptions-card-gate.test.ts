import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDatabase, type DatabaseHandle } from "@emby-task-center/database/client";
import { cardKeys, submissionUsers, verificationCodes } from "@emby-task-center/database/schema";
import { createApp } from "../app";
import { staticCredentialVerifier } from "../auth/test-session";
import { createLibraryService } from "../library/service";
import type { TmdbClient } from "../tmdb/client";
import type { EmbyClient } from "../integrations/emby-client";
import type { EmailNotifier } from "../notifications/email-service";

/**
 * 卡密闸门：**发验证码之前必须先验证卡密**。
 *
 * 改造前 `/code` 只要给个邮箱就发信，卡密是到最后开通那一步才校验的——等于任何人都能拿
 * 别人的邮箱刷我们的发信量。这组用例守的就是「闸门不过 → 一封邮件都不发」。
 *
 * 单独成一个文件还有个现实原因：`/code` 有每 IP 5 次/分钟的限流，而限流器是模块级单例
 * （同文件所有用例共享预算）。给它自己的文件，预算才够用。
 */
const sharedPassword = "family-password";
const sessionSecret = "session-signing-secret";

describe("public subscription card gate (no card → no email)", () => {
  let directory: string;
  let database: DatabaseHandle;
  let server: Server;
  let baseUrl: string;
  let emailsSent: Array<{ to: string; subject: string; text: string }>;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "emby-cardgate-"));
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

  function seedCard(code: string, days = 30) {
    const timestamp = new Date().toISOString();
    database.db
      .insert(cardKeys)
      .values({ code, kind: "month", days, status: "unused", createdAt: timestamp, updatedAt: timestamp })
      .run();
  }

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

  function verificationCodeCount(): number {
    return database.db.select().from(verificationCodes).all().length;
  }

  async function postCode(body: Record<string, unknown>): Promise<Response> {
    return fetch(`${baseUrl}/api/public/subscriptions/code`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("新用户不给卡密就要验证码：拒绝，且不签发、不发送任何邮件", async () => {
    const res = await postCode({ email: "gate@example.com" });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "card_required" });
    expect(emailsSent).toHaveLength(0);
    expect(verificationCodeCount()).toBe(0);
  });

  it("卡密不对同样不发信（invalid_card），也不留下验证码", async () => {
    seedCard("CARDAAAA1111");
    const res = await postCode({ email: "gate@example.com", cardCode: "WRONGCARD99" });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_card" });
    expect(emailsSent).toHaveLength(0);
    expect(verificationCodeCount()).toBe(0);
  });

  it("卡密正确才发信，并回执 needsCard 告诉前端提交要走「开通」", async () => {
    seedCard("CARDAAAA1111");
    // 卡密大小写与空格不敏感：用户手抄容易带上
    const res = await postCode({ email: "gate@example.com", cardCode: " cardaaaa1111 " });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ sent: true, registered: false, needsCard: true, expired: false });
    expect(emailsSent.filter((mail) => mail.to === "gate@example.com")).toHaveLength(1);
    expect(verificationCodeCount()).toBe(1);
  });

  it("注册过的邮箱免卡密：不填卡密也能拿到验证码", async () => {
    seedMember("active@example.com", new Date(Date.now() + 30 * 86_400_000));
    const res = await postCode({ email: "active@example.com" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ sent: true, registered: true, needsCard: false });
    expect(emailsSent.filter((mail) => mail.to === "active@example.com")).toHaveLength(1);
  });
});
