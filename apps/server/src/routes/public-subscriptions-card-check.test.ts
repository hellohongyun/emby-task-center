import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { eq } from "drizzle-orm";

import { createDatabase, type DatabaseHandle } from "@emby-task-center/database/client";
import { cardKeys, submissionUsers, verificationCodes } from "@emby-task-center/database/schema";
import { createApp } from "../app";
import { staticCredentialVerifier } from "../auth/test-session";
import { createLibraryService } from "../library/service";
import type { TmdbClient } from "../tmdb/client";
import type { EmbyClient } from "../integrations/emby-client";
import type { EmailNotifier } from "../notifications/email-service";

/**
 * 卡密预检（`/card/check`）与「卡密 ↔ 验证码」绑定。
 *
 * 预检是页面上「先验证卡密 → 通过后发送验证码才可点」那一步的后端；它**只校验不消耗**，
 * 真正的核销仍然在开通时由 redeemCard 完成。绑定则保证：发码时验的是哪张卡，开通时就得
 * 交哪张卡——否则闸门可以被另一张卡绕过去。
 */
const sharedPassword = "family-password";
const sessionSecret = "session-signing-secret";

describe("public subscription card pre-check", () => {
  let directory: string;
  let database: DatabaseHandle;
  let server: Server;
  let baseUrl: string;
  let emailsSent: Array<{ to: string; subject: string; text: string }>;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "emby-cardcheck-"));
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

  /** 直接种一个验证码：绕过 `/code`（它要卡密、还有每 IP 限流），用于构造「已开通」的场景。 */
  function seedVerificationCode(email: string, code = "123456") {
    database.db
      .insert(verificationCodes)
      .values({
        email,
        code,
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
        consumed: false,
        createdAt: new Date().toISOString(),
      })
      .run();
  }

  function cardStatus(code: string): string | undefined {
    return database.db.select().from(cardKeys).where(eq(cardKeys.code, code)).get()?.status;
  }

  function latestCode(): string {
    const rows = database.db.select().from(verificationCodes).orderBy(verificationCodes.id).all();
    return rows[rows.length - 1]!.code;
  }

  async function postJson(path: string, body: Record<string, unknown>): Promise<Response> {
    return fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("预检只校验不消耗：有效 / 无效 / 他人已用 / 本人已用（幂等）", async () => {
    seedCard("CARDAAAA1111", 30);
    seedCard("CARDBBBB2222", 365);

    // ① 有效卡密：带上卡类型与天数，供页面直接告诉用户「月卡 · 30 天」
    const ok = await postJson("/api/public/subscriptions/card/check", {
      email: "new@example.com",
      cardCode: " cardaaaa1111 ",
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({
      ok: true,
      registered: false,
      needsCard: true,
      expired: false,
      card: { kind: "month", label: "月卡", days: 30, idempotent: false },
    });
    // 关键：预检不消耗卡密，真正的核销留给开通那一步
    expect(cardStatus("CARDAAAA1111")).toBe("unused");

    // ② 不存在的卡密
    const bad = await postJson("/api/public/subscriptions/card/check", {
      email: "new@example.com",
      cardCode: "NOSUCHCARD12",
    });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: "invalid_card" });

    // ③ 先把 CARDBBBB2222 给 owner@example.com 用掉（走开通接口，真核销）
    seedVerificationCode("owner@example.com");
    const activate = await postJson("/api/public/subscriptions/activate", {
      email: "owner@example.com",
      code: "123456",
      cardCode: "CARDBBBB2222",
    });
    expect(activate.status).toBe(200);

    // 别人再来验这张卡 → 拒绝
    const other = await postJson("/api/public/subscriptions/card/check", {
      email: "new@example.com",
      cardCode: "CARDBBBB2222",
    });
    expect(other.status).toBe(400);
    expect(await other.json()).toMatchObject({ error: "card_used" });

    // ④ 本人再验同一张卡 → 幂等放行（续期场景），页面据此显示「本邮箱已用过」
    const self = await postJson("/api/public/subscriptions/card/check", {
      email: "owner@example.com",
      cardCode: "CARDBBBB2222",
    });
    expect(self.status).toBe(200);
    expect(await self.json()).toMatchObject({ ok: true, card: { idempotent: true } });
  });

  it("预检对注册过的邮箱免卡密，对没注册过的则要求卡密", async () => {
    seedMember("active@example.com", new Date(Date.now() + 30 * 86_400_000));
    seedMember("expired@example.com", new Date(Date.now() - 86_400_000));

    const member = await postJson("/api/public/subscriptions/card/check", { email: "active@example.com" });
    expect(member.status).toBe(200);
    expect(await member.json()).toMatchObject({ ok: true, registered: true, needsCard: false, card: null });

    // 过期也算注册过：他要能正常登录，续费去「我的」页，不该被逼着买卡
    const lapsed = await postJson("/api/public/subscriptions/card/check", { email: "expired@example.com" });
    expect(lapsed.status).toBe(200);
    expect(await lapsed.json()).toMatchObject({
      ok: true,
      registered: true,
      needsCard: false,
      expired: true,
      card: null,
    });

    const fresh = await postJson("/api/public/subscriptions/card/check", { email: "fresh@example.com" });
    expect(fresh.status).toBe(400);
    expect(await fresh.json()).toMatchObject({ error: "card_required" });
  });

  it("过期会员免卡密就能拿验证码（登录不受影响），回执标记 expired", async () => {
    seedMember("expired@example.com", new Date(Date.now() - 86_400_000));

    const ok = await postJson("/api/public/subscriptions/code", { email: "expired@example.com" });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ sent: true, registered: true, needsCard: false, expired: true });
    expect(emailsSent.filter((mail) => mail.to === "expired@example.com")).toHaveLength(1);
  });

  it("开通必须用发码时验证的那张卡：换一张被拒，且不会顺手吃掉验证码", async () => {
    seedCard("CARDDDDD4444");
    seedCard("CARDEEEE5555");

    const sent = await postJson("/api/public/subscriptions/code", {
      email: "bind@example.com",
      cardCode: "CARDDDDD4444",
    });
    expect(sent.status).toBe(200);
    const code = latestCode();

    const wrong = await postJson("/api/public/subscriptions/activate", {
      email: "bind@example.com",
      code,
      cardCode: "CARDEEEE5555",
    });
    expect(wrong.status).toBe(400);
    expect(await wrong.json()).toMatchObject({ error: "card_mismatch" });
    expect(cardStatus("CARDEEEE5555")).toBe("unused");

    // 换回发码时那张卡：验证码没被前一次误消费，所以这次能开通
    const right = await postJson("/api/public/subscriptions/activate", {
      email: "bind@example.com",
      code,
      cardCode: "CARDDDDD4444",
    });
    expect(right.status).toBe(200);
    expect(await right.json()).toMatchObject({ status: "activated" });
    expect(cardStatus("CARDDDDD4444")).toBe("used");
  });
});
