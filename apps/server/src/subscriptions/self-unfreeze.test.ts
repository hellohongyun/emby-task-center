import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDatabase, type DatabaseHandle } from "@emby-task-center/database/client";
import { concurrencyEscalationState, memberUnfreezeEvents, submissionUsers } from "@emby-task-center/database/schema";
import type { EmbyClient } from "../integrations/emby-client";
import { saveConcurrencyPolicy } from "../integrations/concurrency-policy-config";
import type { EmailNotifier } from "../notifications/email-service";
import { confirmUnfreeze, memberUnfreezeView, requestUnfreeze, unfreezeMonthKey } from "./self-unfreeze";

/**
 * 会员自助解冻（门户「我的」→「申请解冻」）。
 *
 * 为什么值得测：这条路径允许会员**绕过系统刚下的处置**，所以三件事必须钉死：
 *  ① 等待是真的等——没等满等待秒数，服务端一律不放行（只看前端倒计时等于没等）；
 *  ② 每月次数上限真的拦得住，且只在"确实解冻成功"时才记账；
 *  ③ 解冻没生效（Emby 没确认恢复）时不算解冻：不记次数、不发"已解冻"邮件、状态不动。
 */

const T0 = new Date("2026-01-01T00:00:00.000Z");

/** Emby 假客户端：applyWrites=false 模拟"请求发出去了但策略没生效"。 */
function makeEmby(options: { applyWrites?: boolean } = {}) {
  const applyWrites = options.applyWrites ?? true;
  const disabled: Record<string, boolean> = { u1: true };
  const client = {
    configured: true,
    listUsers: async () => [{ Id: "u1", Name: "u1", Policy: { IsDisabled: Boolean(disabled["u1"]) } }],
    createUser: async () => ({ Id: "x", Name: "x" }),
    setUserPassword: async () => undefined,
    updateUserPolicy: async (id: string, policy: { IsDisabled?: boolean }) => {
      if (policy.IsDisabled === undefined) return;
      if (!applyWrites) return;
      disabled[id] = Boolean(policy.IsDisabled);
    },
    deleteUser: async () => undefined,
    listSessions: async () => [],
    endSession: async () => undefined,
  } as unknown as EmbyClient;
  return { client, disabled };
}

function notifier(sent: Array<{ subject: string; text: string }>): EmailNotifier {
  return {
    configured: true,
    sendNotification: async (_to: string, subject: string, text: string) => {
      sent.push({ subject, text });
    },
  } as unknown as EmailNotifier;
}

describe("会员自助解冻", () => {
  let directory: string;
  let database: DatabaseHandle;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "self-unfreeze-"));
    database = createDatabase(join(directory, "app.sqlite"));
    const ts = T0.toISOString();
    database.db
      .insert(submissionUsers)
      .values({
        email: "member@example.com",
        enabled: true,
        embyUserId: "u1",
        embyMaxStreams: 1,
        processPerDay: 2,
        processFirstBatch: 10,
        createdAt: ts,
        updatedAt: ts,
      })
      .run();
  });

  afterEach(() => {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });

  /** 造一条「已冻结、1 小时后到期」的状态（升级任务的产出）。 */
  function freeze(now = T0, hours = 1) {
    database.db
      .insert(concurrencyEscalationState)
      .values({
        memberId: 1,
        overshootSince: null,
        overshootMs: 0,
        notifiedAt: null,
        disabledUntil: new Date(now.getTime() + hours * 3_600_000).toISOString(),
        unfreezeRequestedAt: null,
        updatedAt: now.toISOString(),
      })
      .run();
  }

  const state = () => database.db.select().from(concurrencyEscalationState).get();
  const events = () => database.db.select().from(memberUnfreezeEvents).all();
  const member = () => database.db.select().from(submissionUsers).get()!;

  it("冻结中：门户拿得到解冻入口与后台文案（占位符已渲染）", () => {
    saveConcurrencyPolicy(database.db, {
      enabled: true,
      remindAfterMinutes: 2,
      disableAfterMinutes: 5,
      disableForHours: 1,
      unfreezeMonthlyLimit: 2,
      unfreezeWaitSeconds: 60,
      unfreezeTitle: "申请提前解冻",
      unfreezeNotice:
        "原定解冻时间 {{unfreezeAt}}，还剩 {{remaining}}；本月可解冻 {{monthlyLimit}} 次、已用 {{usedThisMonth}} 次、本月还剩 {{remainingChances}} 次，本次后还剩 {{remainingAfterThis}} 次。平台：{{platformUrl}}",
      portalUrl: "https://movie.example.com",
    });
    freeze();

    const view = memberUnfreezeView(database.db, member(), T0);
    expect(view.enabled).toBe(true);
    expect(view.frozen).toBe(true);
    expect(view.waitSeconds).toBe(60);
    expect(view.usedThisMonth).toBe(0);
    // 一次都没用过 → 本月还剩满额的 2 次（门户横幅/按钮旁显示的就是它）；
    // "本次解冻后还剩 1 次"是另一个口径，只在"本次解冻后"这种句子里用。
    expect(view.remainingChances).toBe(2);
    expect(view.remainingAfterThis).toBe(1);
    expect(view.title).toBe("申请提前解冻");
    // 占位符必须被渲染掉：会员看到的不能是 {{remaining}} 这种原文
    expect(view.notice).not.toContain("{{");
    expect(view.notice).toContain("还剩 1 小时");
    expect(view.notice).toContain("本月还剩 2 次，本次后还剩 1 次");
    expect(view.notice).toContain("https://movie.example.com");
  });

  it("未登记并发上限的会员同样会被冻结，也必须能看到解冻入口", () => {
    // 未登记上限的会员按「默认并发路数」参与管控 → 一样会被冻结；
    // 门户提示若按"有没有登记上限"过滤，这批人就会被漏掉（看不到解冻时间、也点不了解冻）。
    database.db.update(submissionUsers).set({ embyMaxStreams: null }).run();
    freeze();

    const view = memberUnfreezeView(database.db, member(), T0);
    expect(view.frozen).toBe(true);
    expect(view.enabled).toBe(true);
    expect(view.notice).toContain("同时播放上限：1 路");
  });

  it("点开弹窗记下申请时刻；重复点开不重置（倒计时赖不掉）", () => {
    freeze();

    const first = requestUnfreeze(database.db, "member@example.com", T0);
    expect(first.ok).toBe(true);
    expect(state()?.unfreezeRequestedAt).toBe(T0.toISOString());

    // 关掉弹窗再打开：申请时刻还是第一次那个，等待必须接着算
    requestUnfreeze(database.db, "member@example.com", new Date(T0.getTime() + 30_000));
    expect(state()?.unfreezeRequestedAt).toBe(T0.toISOString());
  });

  it("没等满等待秒数不放过：账号仍停用、不记次数、不发信", async () => {
    freeze();
    requestUnfreeze(database.db, "member@example.com", T0);
    const { client, disabled } = makeEmby();
    const sent: Array<{ subject: string; text: string }> = [];

    const early = await confirmUnfreeze(
      database.db,
      client,
      notifier(sent),
      "member@example.com",
      new Date(T0.getTime() + 30_000),
    );
    expect(early.ok).toBe(false);
    expect(early.error).toBe("wait_not_elapsed");
    expect(early.retryAfterMs).toBe(30_000);
    expect(disabled["u1"]).toBe(true);
    expect(events()).toHaveLength(0);
    expect(sent).toEqual([]);
    expect(state()?.disabledUntil).not.toBeNull();
  });

  it("等满后解冻：Emby 确认恢复、冻结状态清空、记一次次数并发「已解冻」邮件", async () => {
    freeze();
    requestUnfreeze(database.db, "member@example.com", T0);
    const { client, disabled } = makeEmby();
    const sent: Array<{ subject: string; text: string }> = [];

    const at = new Date(T0.getTime() + 61_000);
    const result = await confirmUnfreeze(database.db, client, notifier(sent), "member@example.com", at);
    expect(result.ok).toBe(true);
    expect(result.usedThisMonth).toBe(1);
    expect(result.remainingChances).toBe(1);

    // 解冻 = Emby 账号真的重新启用 + 状态归零（下次超限重新累计，不带着旧账）
    expect(disabled["u1"]).toBe(false);
    expect(state()?.disabledUntil ?? null).toBeNull();
    expect(state()?.overshootMs ?? 0).toBe(0);
    expect(state()?.unfreezeRequestedAt ?? null).toBeNull();
    expect(events()).toHaveLength(1);
    expect(events()[0].month).toBe(unfreezeMonthKey(T0));

    expect(sent.map((item) => item.subject)).toEqual(["账号已解冻"]);
    expect(sent[0].text).toContain("本月还剩 1 次");
    // 门户横幅随之消失
    expect(memberUnfreezeView(database.db, member(), at).frozen).toBe(false);
  });

  it("Emby 没确认恢复就不算解冻：不记次数、不发信、状态不动", async () => {
    freeze();
    requestUnfreeze(database.db, "member@example.com", T0);
    const { client, disabled } = makeEmby({ applyWrites: false });
    const sent: Array<{ subject: string; text: string }> = [];

    const result = await confirmUnfreeze(
      database.db,
      client,
      notifier(sent),
      "member@example.com",
      new Date(T0.getTime() + 61_000),
    );
    expect(result.ok).toBe(false);
    expect(result.error).toBe("release_failed");
    expect(disabled["u1"]).toBe(true);
    expect(events()).toHaveLength(0);
    expect(sent).toEqual([]);
    expect(state()?.disabledUntil).not.toBeNull();
  });

  it("本月次数用完：没有按钮，请求也一律拒绝", async () => {
    freeze();
    const month = unfreezeMonthKey(T0);
    for (let index = 0; index < 2; index += 1) {
      database.db
        .insert(memberUnfreezeEvents)
        .values({ memberId: 1, email: "member@example.com", month, createdAt: T0.toISOString() })
        .run();
    }
    const { client } = makeEmby();
    const sent: Array<{ subject: string; text: string }> = [];

    const view = memberUnfreezeView(database.db, member(), T0);
    expect(view.enabled).toBe(false);
    expect(view.reason).toBe("limit_reached");
    expect(view.usedThisMonth).toBe(2);
    // 用完了就是 0：横幅不会再显示"还可解冻"，按钮也不出现
    expect(view.remainingChances).toBe(0);
    expect(view.remainingAfterThis).toBe(0);
    expect(requestUnfreeze(database.db, "member@example.com", T0)).toEqual({ ok: false, error: "limit_reached" });

    const result = await confirmUnfreeze(
      database.db,
      client,
      notifier(sent),
      "member@example.com",
      new Date(T0.getTime() + 61_000),
    );
    expect(result.ok).toBe(false);
    expect(result.error).toBe("limit_reached");
    expect(events()).toHaveLength(2);
    expect(sent).toEqual([]);
  });

  it("后台关掉自助解冻 / 次数上限设 0：不再提供入口", () => {
    saveConcurrencyPolicy(database.db, {
      enabled: true,
      remindAfterMinutes: 2,
      disableAfterMinutes: 5,
      disableForHours: 1,
      unfreezeEnabled: false,
    });
    freeze();
    expect(memberUnfreezeView(database.db, member(), T0).reason).toBe("unfreeze_disabled");

    saveConcurrencyPolicy(database.db, {
      enabled: true,
      remindAfterMinutes: 2,
      disableAfterMinutes: 5,
      disableForHours: 1,
      unfreezeEnabled: true,
      unfreezeMonthlyLimit: 0,
    });
    expect(memberUnfreezeView(database.db, member(), T0).reason).toBe("unfreeze_disabled");
  });

  it("没被冻结的会员：既没有按钮，也调不动接口", async () => {
    const { client } = makeEmby();
    const sent: Array<{ subject: string; text: string }> = [];

    expect(memberUnfreezeView(database.db, member(), T0).reason).toBe("not_frozen");
    expect(requestUnfreeze(database.db, "member@example.com", T0)).toEqual({ ok: false, error: "not_frozen" });
    expect(await confirmUnfreeze(database.db, client, notifier(sent), "member@example.com", T0)).toEqual({
      ok: false,
      error: "not_frozen",
    });
    expect(requestUnfreeze(database.db, "nobody@example.com", T0)).toEqual({ ok: false, error: "not_member" });
  });
});
