import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDatabase, type DatabaseHandle } from "@emby-task-center/database/client";
import { submissionUsers } from "@emby-task-center/database/schema";
import type { EmbyClient } from "../integrations/emby-client";
import { saveConcurrencyPolicy } from "../integrations/concurrency-policy-config";
import type { EmailNotifier } from "../notifications/email-service";
import { ESCALATION_TICK_MS, enforceConcurrencyEscalation } from "./concurrency-escalation";

function makeEmby(
  sessions: Array<{
    Id: string;
    UserId?: string;
    DeviceId?: string;
    NowPlayingItem?: { Name: string } | null;
    PlayState?: { IsPaused?: boolean };
  }>,
) {
  let current = sessions;
  const disabled: Record<string, boolean> = {};
  const ended: string[] = [];
  const kicked: string[] = [];
  const client = {
    configured: true,
    // 策略要能被**回读**：冻结后会回读确认真的停用了（整份覆盖式写入，写成功 ≠ 生效）。
    listUsers: async () => [{ Id: "u1", Name: "u1", Policy: { IsDisabled: Boolean(disabled["u1"]) } }],
    createUser: async () => ({ Id: "x", Name: "x" }),
    setUserPassword: async () => undefined,
    updateUserPolicy: async (id: string, policy: { IsDisabled?: boolean }) => {
      if (policy.IsDisabled !== undefined) disabled[id] = Boolean(policy.IsDisabled);
    },
    deleteUser: async () => undefined,
    listSessions: async () => current as never,
    endSession: async (id: string) => void ended.push(id),
    stopPlayback: async () => undefined,
    removeDevice: async (deviceId: string) => {
      kicked.push(deviceId);
      return true;
    },
  } as unknown as EmbyClient;
  return {
    client,
    disabled,
    ended,
    kicked,
    setSessions: (s: typeof sessions) => {
      current = s;
    },
  };
}

const T0 = Date.parse("2026-01-01T00:00:00.000Z");

describe("enforceConcurrencyEscalation", () => {
  let directory: string;
  let database: DatabaseHandle;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "escalate-"));
    database = createDatabase(join(directory, "app.sqlite"));
    const ts = new Date().toISOString();
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

  afterEach(async () => {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("escalates over-limit: remind email then disable, then auto-recover", async () => {
    const over = [
      { Id: "s1", UserId: "u1", DeviceId: "dev-1", NowPlayingItem: { Name: "A" } },
      { Id: "s2", UserId: "u1", DeviceId: "dev-2", NowPlayingItem: { Name: "B" } },
    ];
    const { client, disabled, ended, kicked, setSessions } = makeEmby(over);
    const sent: string[] = [];
    const email: EmailNotifier = {
      configured: true,
      sendNotification: async (_e: string, subject: string) => {
        sent.push(subject);
      },
      sendTest: async () => undefined,
      retryPending: async () => undefined,
    } as unknown as EmailNotifier;

    // 按真实节奏跑：升级任务每 30 秒一跳，累计也按这个周期计入。
    const tick = (offsetMs: number) =>
      enforceConcurrencyEscalation(database.db, client, email, new Date(T0 + offsetMs));

    // 1) 前 90 秒：只累计，不提醒也不冻结
    for (let offset = 0; offset <= 90_000; offset += ESCALATION_TICK_MS) await tick(offset);
    expect(sent.length).toBe(0);
    expect(disabled["u1"]).toBeUndefined();

    // 2) 累计超限满 remindAfterMinutes(2 分钟)：发提醒邮件（且只发这一封）
    for (let offset = 100_000; offset <= 2 * 60_000; offset += ESCALATION_TICK_MS) await tick(offset);
    expect(sent).toEqual(["账号并发播放提醒"]);
    expect(disabled["u1"]).toBeUndefined();

    // 3) 累计超限满 disableAfterMinutes(5 分钟)：到点直接冻结 —— 停用账号 + 立刻断掉它所有设备
    for (let offset = 130_000; offset < 5 * 60_000; offset += ESCALATION_TICK_MS) await tick(offset);
    expect(disabled["u1"]).toBeUndefined(); // 差一点，还不冻
    const frozen = await tick(5 * 60_000);
    expect(disabled["u1"]).toBe(true);
    expect(sent).toContain("账号已因超限冻结");
    // 只写策略位是不够的：这台 Emby 不因停用中断已登录设备，必须断会话 + 踢设备
    expect(ended.sort()).toEqual(["s1", "s2"]);
    expect(kicked.sort()).toEqual(["dev-1", "dev-2"]);
    expect(frozen.frozen).toEqual(["member@example.com"]);

    // 4) 冻结期间客户端若还在播（Emby 不拦），每一轮都继续断
    const before = ended.length + kicked.length;
    const during = await enforceConcurrencyEscalation(database.db, client, email, new Date(T0 + 30 * 60_000));
    expect(ended.length + kicked.length).toBeGreaterThan(before);
    expect(during.terminated).toBeGreaterThan(0);
    // 冻结期内不再重复冻结/发信
    expect(during.frozen).toEqual([]);

    // 5) after 1-hour cooldown and back within limit: re-enables and resets
    const idle = [{ Id: "s1", UserId: "u1", NowPlayingItem: null, PlayState: { IsPaused: false } }];
    setSessions(idle);
    const out = await enforceConcurrencyEscalation(database.db, client, email, new Date(T0 + 5 * 60_000 + 61 * 60_000));
    expect(disabled["u1"] ?? false).toBe(false);
    expect(out.released).toEqual(["member@example.com"]);
  });

  it("freezes right at the threshold even when the reminder was switched off", async () => {
    // remindAfterMinutes = 0：不提醒，超限满 disableAfterMinutes 直接冻结
    saveConcurrencyPolicy(database.db, {
      enabled: true,
      remindAfterMinutes: 0,
      disableAfterMinutes: 5,
      disableForHours: 1,
      adminEmail: null,
      interruptStreams: true,
      defaultStreamLimit: 1,
    });
    const over = [
      { Id: "s1", UserId: "u1", DeviceId: "dev-1", NowPlayingItem: { Name: "A" } },
      { Id: "s2", UserId: "u1", DeviceId: "dev-2", NowPlayingItem: { Name: "B" } },
    ];
    const { client, disabled, kicked } = makeEmby(over);
    const sent: string[] = [];
    const email = {
      configured: true,
      sendNotification: async (_e: string, subject: string) => {
        sent.push(subject);
      },
    } as unknown as EmailNotifier;

    // 每 30 秒一跳（与 runtime 的排程一致），一路累计到冻结档
    for (let offset = 0; offset < 5 * 60_000; offset += ESCALATION_TICK_MS) {
      await enforceConcurrencyEscalation(database.db, client, email, new Date(T0 + offset));
    }
    const outcome = await enforceConcurrencyEscalation(database.db, client, email, new Date(T0 + 5 * 60_000));

    expect(disabled["u1"]).toBe(true);
    expect(kicked.sort()).toEqual(["dev-1", "dev-2"]);
    // 只发了"已冻结"通知，没有提醒邮件
    expect(sent).toEqual(["账号已因超限冻结"]);
    expect(outcome.frozen).toEqual(["member@example.com"]);
  });

  it("管理员收到的是**带会员信息**的独立邮件，而不是会员邮件的副本", async () => {
    // 抄送一封会员口吻的信 = 管理员根本不知道是谁触发的、超到什么程度、系统做了什么。
    saveConcurrencyPolicy(database.db, {
      enabled: true,
      remindAfterMinutes: 2,
      disableAfterMinutes: 5,
      disableForHours: 1,
      adminEmail: "admin@example.com",
    });
    const over = [
      { Id: "s1", UserId: "u1", DeviceId: "dev-1", NowPlayingItem: { Name: "A" } },
      { Id: "s2", UserId: "u1", DeviceId: "dev-2", NowPlayingItem: { Name: "B" } },
    ];
    const { client } = makeEmby(over);
    const mails: Array<{ to: string; subject: string; text: string; cc?: string }> = [];
    const email = {
      configured: true,
      sendNotification: async (to: string, subject: string, text: string, _html?: string, cc?: string) =>
        void mails.push({ to, subject, text, cc }),
    } as unknown as EmailNotifier;

    // 累计到提醒档：会员一封 + 管理员一封
    for (let offset = 0; offset <= 2 * 60_000; offset += ESCALATION_TICK_MS) {
      await enforceConcurrencyEscalation(database.db, client, email, new Date(T0 + offset));
    }
    const adminRemind = mails.find((mail) => mail.to === "admin@example.com");
    expect(adminRemind).toBeTruthy();
    expect(adminRemind!.subject).toContain("[并发超限·提醒]");
    // 管理员邮件必须回答"是谁、什么情况"
    expect(adminRemind!.subject).toContain("member@example.com");
    expect(adminRemind!.text).toContain("会员邮箱：member@example.com");
    expect(adminRemind!.text).toContain("Emby 用户名：");
    expect(adminRemind!.text).toContain("同时播放上限：1 路（会员登记值）");
    expect(adminRemind!.text).toContain("触发时同时播放：2 路");
    // 会员那封不再抄送管理员（否则管理员收到的就是一份看不懂的副本）
    expect(mails.find((mail) => mail.to === "member@example.com")!.cc).toBeUndefined();

    // 累计到冻结档：再发一封"已冻结"，且写清系统做了什么、现在能做什么
    for (let offset = 130_000; offset < 5 * 60_000; offset += ESCALATION_TICK_MS) {
      await enforceConcurrencyEscalation(database.db, client, email, new Date(T0 + offset));
    }
    await enforceConcurrencyEscalation(database.db, client, email, new Date(T0 + 5 * 60_000));
    const adminFrozen = mails.filter((mail) => mail.to === "admin@example.com").at(-1)!;
    expect(adminFrozen.subject).toContain("[并发超限·已冻结]");
    // 2 路播放会话 + 2 台设备 = 4 项（冻结必须断流+踢设备，只写策略位拦不住已登录设备）
    expect(adminFrozen.text).toContain("已强制中断：4 项");
    expect(adminFrozen.text).toContain("冻结时长：1 小时");
    expect(adminFrozen.text).toContain("一键恢复");
  });

  it("冻结邮件写清「可以登录平台自助解冻」，并带上平台地址与次数口径", async () => {
    // 收到冻结邮件时会员最想知道的是"现在怎么办"：能自助解冻就把入口、等待秒数、每月次数写清楚。
    saveConcurrencyPolicy(database.db, {
      enabled: true,
      remindAfterMinutes: 0,
      disableAfterMinutes: 5,
      disableForHours: 1,
      unfreezeEnabled: true,
      unfreezeMonthlyLimit: 2,
      unfreezeWaitSeconds: 60,
      portalUrl: "https://movie.example.com",
    });
    const over = [
      { Id: "s1", UserId: "u1", DeviceId: "dev-1", NowPlayingItem: { Name: "A" } },
      { Id: "s2", UserId: "u1", DeviceId: "dev-2", NowPlayingItem: { Name: "B" } },
    ];
    const { client } = makeEmby(over);
    const mails: Array<{ subject: string; text: string }> = [];
    const email = {
      configured: true,
      sendNotification: async (_e: string, subject: string, text: string) => void mails.push({ subject, text }),
    } as unknown as EmailNotifier;

    for (let offset = 0; offset < 5 * 60_000; offset += ESCALATION_TICK_MS) {
      await enforceConcurrencyEscalation(database.db, client, email, new Date(T0 + offset));
    }
    await enforceConcurrencyEscalation(database.db, client, email, new Date(T0 + 5 * 60_000));

    const frozen = mails.find((mail) => mail.subject === "账号已因超限冻结");
    expect(frozen).toBeTruthy();
    expect(frozen!.text).toContain("申请解冻");
    expect(frozen!.text).toContain("等待 60 秒");
    expect(frozen!.text).toContain("每月最多 2 次");
    expect(frozen!.text).toContain("平台地址：https://movie.example.com");
  });

  it("关掉自助解冻时冻结邮件不提这条路（不给会员指一条走不通的路）", async () => {
    saveConcurrencyPolicy(database.db, {
      enabled: true,
      remindAfterMinutes: 0,
      disableAfterMinutes: 5,
      disableForHours: 1,
      unfreezeEnabled: false,
    });
    const over = [
      { Id: "s1", UserId: "u1", DeviceId: "dev-1", NowPlayingItem: { Name: "A" } },
      { Id: "s2", UserId: "u1", DeviceId: "dev-2", NowPlayingItem: { Name: "B" } },
    ];
    const { client } = makeEmby(over);
    const mails: Array<{ subject: string; text: string }> = [];
    const email = {
      configured: true,
      sendNotification: async (_e: string, subject: string, text: string) => void mails.push({ subject, text }),
    } as unknown as EmailNotifier;

    for (let offset = 0; offset < 5 * 60_000; offset += ESCALATION_TICK_MS) {
      await enforceConcurrencyEscalation(database.db, client, email, new Date(T0 + offset));
    }
    await enforceConcurrencyEscalation(database.db, client, email, new Date(T0 + 5 * 60_000));

    const frozen = mails.find((mail) => mail.subject === "账号已因超限冻结");
    expect(frozen).toBeTruthy();
    expect(frozen!.text).not.toContain("申请解冻");
  });
});
