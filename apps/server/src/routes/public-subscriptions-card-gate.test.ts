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
import { writeSettings } from "../settings/store";
import { postSubscription } from "../test-support/card-activation";

/**
 * 卡密闸门：**发验证码之前必须先验证卡密**。
 *
 * 改造前 `/code` 只要给个邮箱就发信，卡密是到最后开通那一步才校验的——等于任何人都能拿
 * 别人的邮箱刷我们的发信量。这组用例守的就是「闸门不过 → 一封邮件都不发」。
 *
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
    const res = await postCode({ email: "100001031@qq.com" });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "card_required" });
    expect(emailsSent).toHaveLength(0);
    expect(verificationCodeCount()).toBe(0);
  });

  it("卡密不对同样不发信（invalid_card），也不留下验证码", async () => {
    seedCard("CARDAAAA1111");
    const res = await postCode({ email: "100001031@qq.com", cardCode: "WRONGCARD99" });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_card" });
    expect(emailsSent).toHaveLength(0);
    expect(verificationCodeCount()).toBe(0);
  });

  it("卡密正确才发信，并回执 needsCard 告诉前端提交要走「开通」", async () => {
    seedCard("CARDAAAA1111");
    // 卡密大小写与空格不敏感：用户手抄容易带上
    const res = await postCode({ email: "100001031@qq.com", cardCode: " cardaaaa1111 " });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ sent: true, registered: false, needsCard: true, expired: false });
    expect(emailsSent.filter((mail) => mail.to === "100001031@qq.com")).toHaveLength(1);
    expect(verificationCodeCount()).toBe(1);
  });

  it("注册过的邮箱免卡密：不填卡密也能拿到验证码", async () => {
    seedMember("active@example.com", new Date(Date.now() + 30 * 86_400_000));
    const res = await postCode({ email: "active@example.com" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ sent: true, registered: true, needsCard: false });
    expect(emailsSent.filter((mail) => mail.to === "active@example.com")).toHaveLength(1);
  });

  it("只接受数字 QQ 邮箱用于首次注册，绕过发码接口也不能开通", async () => {
    const cardCode = "CARDAAAA1111";
    seedCard(cardCode);
    const alias = await postCode({ email: "alias@qq.com", cardCode });
    expect(await alias.json()).toEqual({ error: "qq_email_required" });
    const activation = await postSubscription(baseUrl, "activate", {
      email: "100001031@qq.com",
      cardCode,
      code: "123456",
    });
    expect(await activation.json()).toEqual({ error: "registration_verification_required" });
    expect(emailsSent).toHaveLength(0);
    expect(verificationCodeCount()).toBe(0);
  });

  it("群邀请码仅公开群号，校验通过才发码，更换邀请码会让已验证的凭证失效", async () => {
    const email = "100001031@qq.com";
    const cardCode = "CARDAAAA1111";
    const inviteCode = "group-notice-code";
    seedCard(cardCode);
    writeSettings(database.db, {
      "member.groupInviteEnabled": true,
      "member.groupNumber": "123456789",
      "member.groupInviteCode": inviteCode,
    });

    const entry = await postSubscription(baseUrl, "entry", { email });
    const publicEntry = await entry.json();
    expect(publicEntry).toMatchObject({ groupInvite: { groupNumber: "123456789" } });
    expect(JSON.stringify(publicEntry)).not.toContain(inviteCode);
    expect(await (await postCode({ email, cardCode })).json()).toEqual({ error: "group_invite_required" });
    expect(await (await postCode({ email, cardCode, inviteCode: "wrong-code" })).json()).toEqual({
      error: "invalid_group_invite",
    });
    expect(emailsSent).toHaveLength(0);
    expect(verificationCodeCount()).toBe(0);

    expect((await postCode({ email, cardCode, inviteCode })).status).toBe(200);
    const code = emailsSent[0]?.text.match(/验证码：(\d{6})/)?.[1];
    const verified = await postSubscription(baseUrl, "register/verify", { email, code, cardCode, inviteCode });
    expect(verified.status).toBe(200);
    const { registrationToken } = (await verified.json()) as { registrationToken: string };
    writeSettings(database.db, { "member.groupInviteCode": "new-group-code" });
    const activation = await postSubscription(baseUrl, "activate", { email, cardCode, registrationToken });
    expect(await activation.json()).toEqual({ error: "registration_verification_required" });
    expect(database.db.select().from(submissionUsers).all()).toEqual([]);
    expect(database.db.select().from(cardKeys).get()?.status).toBe("unused");
  });
});
