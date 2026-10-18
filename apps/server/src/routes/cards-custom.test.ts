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
import { cardDisplayName, expiryDisplay, formatExpiryDate, normalizeExpiryDate } from "../subscriptions/cards";
import { writeSettings } from "../settings/store";

const sharedPassword = "family-password";
const sessionSecret = "session-signing-secret";

/** 用例统一用一个"两年后"的日期当固定到期日，避免踩到过期闸门。 */
function futureDate(daysFromNow: number): string {
  const target = new Date(Date.now() + daysFromNow * 86_400_000);
  const pad = (count: number) => String(count).padStart(2, "0");
  return `${target.getFullYear()}-${pad(target.getMonth() + 1)}-${pad(target.getDate())}`;
}

describe("自定义卡密：固定到期日、名称与彩蛋文案", () => {
  let directory: string;
  let database: DatabaseHandle;
  let server: Server;
  let baseUrl: string;
  let adminCookie: string;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "emby-cards-custom-"));
    database = createDatabase(join(directory, "app.sqlite"));
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
      integrationServices: {
        email: { configured: false } as EmailNotifier,
        emby: { configured: false } as EmbyClient,
      },
    });
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: sharedPassword }),
    });
    adminCookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });

  async function createCards(
    payload: Record<string, unknown>,
  ): Promise<{ status: number; codes: string[]; error?: string }> {
    const response = await fetch(`${baseUrl}/api/cards`, {
      method: "POST",
      headers: { cookie: adminCookie, "content-type": "application/json" },
      body: JSON.stringify({ count: 1, ...payload }),
    });
    const body = (await response.json()) as { codes?: string[]; error?: string };
    return { status: response.status, codes: body.codes ?? [], error: body.error };
  }

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

  async function activate(email: string, cardCode: string) {
    seedVerificationCode(email);
    const response = await fetch(`${baseUrl}/api/public/subscriptions/activate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, code: "123456", cardCode }),
    });
    return {
      status: response.status,
      body: (await response.json()) as {
        error?: string;
        member?: { subscriptionExpiresAt: string | null; membershipExpiryLabel: string | null };
        card?: { name: string | null; expiryLabel: string | null; expiresAt: string | null };
      },
    };
  }

  async function checkCard(email: string, cardCode: string) {
    const response = await fetch(`${baseUrl}/api/public/subscriptions/card/check`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, cardCode }),
    });
    return {
      status: response.status,
      body: (await response.json()) as {
        error?: string;
        card?: {
          name: string;
          expiresAt: string | null;
          expiryLabel: string | null;
          expiryText: string;
          expiryDetail: string | null;
          blessing: string | null;
        } | null;
      },
    };
  }

  it("固定到期日卡：不同时间兑换的两个用户，会员统一到期于同一天", async () => {
    const date = futureDate(400);
    const created = await createCards({
      kind: "custom",
      expiresAt: date,
      name: "国庆节卡密",
      expiryLabel: "2027 年春节结束到期",
      blessing: "国庆快乐，愿你看片愉快！",
      count: 2,
    });
    expect(created.status).toBe(201);
    expect(created.codes).toHaveLength(2);

    const expected = normalizeExpiryDate(date)!;
    const first = await activate("early@example.com", created.codes[0]!);
    const second = await activate("late@example.com", created.codes[1]!);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    // 这就是"固定到期日"的全部意义：谁什么时候兑换，都在同一天到期
    expect(first.body.member?.subscriptionExpiresAt).toBe(expected);
    expect(second.body.member?.subscriptionExpiresAt).toBe(expected);
  });

  it("固定到期日落在当日 23:59:59.999：8 号到期 = 8 号这天还能看", async () => {
    const date = futureDate(200);
    const normalized = normalizeExpiryDate(date)!;
    const local = new Date(normalized);
    expect(local.getHours()).toBe(23);
    expect(local.getMinutes()).toBe(59);
    expect(formatExpiryDate(normalized)).toBe(date);
  });

  it("已有会员的原到期更晚时，固定到期日卡不会把会员期缩短", async () => {
    const longCard = await createCards({ kind: "year" });
    const first = await activate("vip@example.com", longCard.codes[0]!);
    expect(first.status).toBe(200);
    const originalExpiry = first.body.member?.subscriptionExpiresAt;
    expect(originalExpiry).toBeTruthy();

    // 一张 30 天后到期的卡，给一个还有 365 天的会员兑换：只可能"不缩短"
    const shortCard = await createCards({ kind: "custom", expiresAt: futureDate(30), name: "短期卡" });
    const second = await activate("vip@example.com", shortCard.codes[0]!);
    expect(second.status).toBe(200);
    expect(second.body.member?.subscriptionExpiresAt).toBe(originalExpiry);
  });

  it("到期日已过的固定到期日卡：预检与核销都拒绝 card_expired，且不消耗卡", async () => {
    // 直接写库造一张"昨天到期"的卡：生成接口不给过（那是给管理员的正常入口）
    const date = futureDate(-1);
    const code = "EXPIREDCARD1";
    const timestamp = new Date().toISOString();
    database.db
      .insert(cardKeys)
      .values({
        code,
        kind: "custom",
        days: 1,
        name: "过期卡",
        expiresAt: normalizeExpiryDate(date)!,
        status: "unused",
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .run();

    const check = await checkCard("newbie@example.com", code);
    expect(check.status).toBe(400);
    expect(check.body.error).toBe("card_expired");

    const redeem = await activate("newbie@example.com", code);
    expect(redeem.status).toBe(400);
    expect(redeem.body.error).toBe("card_expired");

    // 关键：拒绝不能顺手把卡烧掉，否则用户白白损失一张卡
    const row = database.db.select().from(cardKeys).where(eq(cardKeys.code, code)).get()!;
    expect(row.status).toBe("unused");
    expect(row.usedByEmail).toBeNull();
  });

  it("老卡（不带 expiresAt）行为一行不变：仍是 兑换日 + days", async () => {
    const before = Date.now();
    const created = await createCards({ kind: "month" });
    const result = await activate("legacy@example.com", created.codes[0]!);
    expect(result.status).toBe(200);
    const expiry = Date.parse(result.body.member?.subscriptionExpiresAt ?? "");
    expect(Number.isFinite(expiry)).toBe(true);
    const thirtyDays = 30 * 86_400_000;
    expect(expiry - before).toBeGreaterThan(thirtyDays - 60_000);
    expect(expiry - before).toBeLessThan(thirtyDays + 60_000);
    // 老卡没有名称与到期名称，会员侧也不该被塞进任何 label
    expect(result.body.member?.membershipExpiryLabel).toBeNull();
  });

  it("兑换把「到期时间名称」写到会员行上，用户侧所有页面共用这一个口径", async () => {
    const created = await createCards({
      kind: "custom",
      expiresAt: futureDate(300),
      name: "生日快乐卡密",
      expiryLabel: "2027 年春节结束到期",
    });
    const result = await activate("birthday@example.com", created.codes[0]!);
    expect(result.status).toBe(200);
    expect(result.body.member?.membershipExpiryLabel).toBe("2027 年春节结束到期");
    // 开通响应也要告诉前端"用的是哪张卡"
    expect(result.body.card?.name).toBe("生日快乐卡密");
    expect(result.body.card?.expiryLabel).toBe("2027 年春节结束到期");
  });

  it("续期换成不带名称的卡：旧的到期时间名称必须被清空，不能粘在新的到期时间上", async () => {
    const labeled = await createCards({ kind: "custom", expiresAt: futureDate(300), expiryLabel: "国庆假期结束到期" });
    const first = await activate("switch@example.com", labeled.codes[0]!);
    expect(first.body.member?.membershipExpiryLabel).toBe("国庆假期结束到期");

    const plain = await createCards({ kind: "year" });
    const second = await activate("switch@example.com", plain.codes[0]!);
    expect(second.status).toBe(200);
    expect(second.body.member?.membershipExpiryLabel).toBeNull();
  });

  it("幂等兑换（同邮箱重复提交同卡）：到期时间与到期时间名称都不动", async () => {
    const created = await createCards({
      kind: "custom",
      expiresAt: futureDate(300),
      expiryLabel: "2027 年春节结束到期",
    });
    const first = await activate("repeat@example.com", created.codes[0]!);
    const second = await activate("repeat@example.com", created.codes[0]!);
    expect(second.status).toBe(200);
    expect(second.body.member?.subscriptionExpiresAt).toBe(first.body.member?.subscriptionExpiresAt);
    expect(second.body.member?.membershipExpiryLabel).toBe("2027 年春节结束到期");
  });

  it("预检把名称、到期口径与彩蛋文案一起给到前端", async () => {
    const created = await createCards({
      kind: "custom",
      expiresAt: futureDate(120),
      name: "国庆节卡密",
      expiryLabel: "国庆假期结束到期",
      blessing: "祝你国庆快乐，追剧愉快！",
    });
    const check = await checkCard("newbie@example.com", created.codes[0]!);
    expect(check.status).toBe(200);
    // 名称优先：主文案是管理员写的名称，真实日期退到 detail 小字
    expect(check.body.card?.expiryText).toBe("国庆假期结束到期");
    expect(check.body.card?.expiryDetail).toBe(formatExpiryDate(normalizeExpiryDate(futureDate(120))!));
    expect(check.body.card?.name).toBe("国庆节卡密");
    expect(check.body.card?.blessing).toBe("祝你国庆快乐，追剧愉快！");
  });

  it("非法到期日与非法天数都被挡在生成入口外", async () => {
    // 2027-02-31 会被 JS 顺延成 3 月 3 日，绝不能悄悄换个日子
    const bad = await createCards({ kind: "custom", expiresAt: "2027-02-31" });
    expect(bad.status).toBe(400);
    expect(bad.error).toBe("invalid_expires_at");

    const noDays = await createCards({ kind: "custom" });
    expect(noDays.status).toBe(400);
    expect(noDays.error).toBe("invalid_days");
  });

  it("PATCH 可以事后改名称/到期名称/彩蛋文案，但不改到期日", async () => {
    const created = await createCards({ kind: "custom", expiresAt: futureDate(90), name: "旧名字" });
    const row = database.db.select().from(cardKeys).where(eq(cardKeys.code, created.codes[0]!)).get()!;

    const patched = await fetch(`${baseUrl}/api/cards`, {
      method: "PATCH",
      headers: { cookie: adminCookie, "content-type": "application/json" },
      body: JSON.stringify({ ids: [row.id], name: "国庆节卡密", blessing: "国庆快乐！" }),
    });
    expect(patched.status).toBe(200);

    const after = database.db.select().from(cardKeys).where(eq(cardKeys.id, row.id)).get()!;
    expect(after.name).toBe("国庆节卡密");
    expect(after.blessing).toBe("国庆快乐！");
    expect(after.expiresAt).toBe(row.expiresAt);
  });

  it("列表把展示名与到期文案算好给前端（含过期标记）", async () => {
    await createCards({ kind: "custom", expiresAt: futureDate(60), name: "国庆节卡密", expiryLabel: "国庆结束到期" });
    const response = await fetch(`${baseUrl}/api/cards`, { headers: { cookie: adminCookie } });
    const body = (await response.json()) as {
      cards: Array<{ displayName: string; expiryText: string; expiryDate: string | null; expired: boolean }>;
    };
    const card = body.cards[0]!;
    expect(card.displayName).toBe("国庆节卡密");
    expect(card.expiryText).toBe("国庆结束到期");
    expect(card.expiryDate).toBe(formatExpiryDate(normalizeExpiryDate(futureDate(60))!));
    expect(card.expired).toBe(false);
  });

  it("展示口径的纯函数：名称优先；相对卡不撒谎说日期", () => {
    expect(cardDisplayName({ name: null, kind: "month" })).toBe("月卡");
    expect(cardDisplayName({ name: "  ", kind: "month" })).toBe("月卡");
    expect(cardDisplayName({ name: "国庆节卡密", kind: "custom" })).toBe("国庆节卡密");

    const fixed = expiryDisplay({ expiryLabel: "2027 年春节结束到期", expiresAt: futureDate(100), days: 100 });
    expect(fixed.text).toBe("2027 年春节结束到期");
    expect(fixed.detail).toBe(formatExpiryDate(normalizeExpiryDate(futureDate(100))!));

    const plainFixed = expiryDisplay({ expiryLabel: null, expiresAt: futureDate(100), days: 100 });
    expect(plainFixed.text).toBe(formatExpiryDate(normalizeExpiryDate(futureDate(100))!));

    // 相对天数卡在兑换前根本没有确定日期，只能说规则
    const relative = expiryDisplay({ expiryLabel: null, expiresAt: null, days: 30 });
    expect(relative.text).toBe("兑换后 30 天");
    expect(relative.detail).toBeNull();

    expect(normalizeExpiryDate("2027-02-31")).toBeNull();
    expect(normalizeExpiryDate("不是日期")).toBeNull();
    expect(normalizeExpiryDate("")).toBeNull();
  });

  it("会员摘要把到期时间名称下发给门户", async () => {
    const created = await createCards({
      kind: "custom",
      expiresAt: futureDate(300),
      expiryLabel: "2027 年春节结束到期",
    });
    const activated = await activate("portal@example.com", created.codes[0]!);
    expect(activated.status).toBe(200);
    const cookie = "x";
    void cookie;
    const row = database.db
      .select()
      .from(submissionUsers)
      .where(eq(submissionUsers.email, "portal@example.com"))
      .get()!;
    expect(row.membershipExpiryLabel).toBe("2027 年春节结束到期");
  });

  describe("AI 帮写接口", () => {
    it("未登录被管理端会话闸门挡住，未配置时给出 ai_not_configured 而不是笼统失败", async () => {
      const anonymous = await fetch(`${baseUrl}/api/cards/blessing/draft`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ occasion: "国庆节卡密" }),
      });
      expect(anonymous.status).toBe(401);

      const notConfigured = await fetch(`${baseUrl}/api/cards/blessing/draft`, {
        method: "POST",
        headers: { cookie: adminCookie, "content-type": "application/json" },
        body: JSON.stringify({ occasion: "国庆节卡密" }),
      });
      expect(notConfigured.status).toBe(409);
      expect((await notConfigured.json()).error).toBe("ai_not_configured");
    });

    it("配好之后返回清洗过的文案；上游 401 时映射成 ai_unauthorized", async () => {
      writeSettings(database.db, { "ai.enabled": true, "ai.apiKey": "sk-test" });
      const realFetch = globalThis.fetch;
      const draft = (body: unknown) =>
        realFetch(`${baseUrl}/api/cards/blessing/draft`, {
          method: "POST",
          headers: { cookie: adminCookie, "content-type": "application/json" },
          body: JSON.stringify(body),
        });

      try {
        let stubStatus = 200;
        let stubContent = '"国庆快乐，追剧愉快！"';
        globalThis.fetch = (async () =>
          new Response(JSON.stringify({ choices: [{ message: { content: stubContent } }] }), {
            status: stubStatus,
          })) as unknown as typeof fetch;

        const ok = await draft({ occasion: "国庆节卡密" });
        expect(ok.status).toBe(200);
        // 成对引号被脱掉，管理员拿到的是可直接落库的文案
        expect((await ok.json()).text).toBe("国庆快乐，追剧愉快！");

        stubStatus = 401;
        stubContent = "unauthorized";
        const bad = await draft({ occasion: "国庆节卡密" });
        expect(bad.status).toBe(502);
        expect((await bad.json()).error).toBe("ai_unauthorized");
      } finally {
        globalThis.fetch = realFetch;
      }
    });
  });
});
