import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

import { createDatabase, type DatabaseHandle } from "@emby-task-center/database/client";
import { concurrencyEscalationState, submissionUsers } from "@emby-task-center/database/schema";
import { createEmbyClient, type EmbyClient } from "../integrations/emby-client";
import { saveConcurrencyPolicy } from "../integrations/concurrency-policy-config";
import type { EmailNotifier } from "../notifications/email-service";
import { ESCALATION_TICK_MS, enforceConcurrencyEscalation } from "./concurrency-escalation";
import { clearStreamStopCooldown, enforceStreamLimits } from "./stream-guard";
import { StreamLimitResolver } from "./stream-limits";

/**
 * 并发超限 → 冻结 的**端到端**回归（真实 HTTP + 真实 EmbyClient + 真实 DB）。
 *
 * 口径（用户确认）：
 *  - 没有反向代理，不在流量层拦；只用 Emby API 读**每个账号的实时播放状态**；
 *  - 同一账号同时播放 ≥2 路（超过上限）→ **触发式累计**：累计超限时长到「提醒档」发邮件，
 *    再累计到「冻结档」直接冻结（两个时间都在系统设置里配）；
 *  - **只处理会员**，Emby 管理员不受影响；
 *  - 冻结 = 停用账号 + 断掉该账号全部会话 + 踢设备（这台 Emby 不执行 SimultaneousStreamLimit，
 *    停用也不会中断已登录设备的播放，只写策略位等于没冻），到期自动恢复。
 *
 * 与 `stream-guard.test.ts` / `concurrency-escalation.test.ts` 的分工：那两个用例把 Emby
 * 打桩成对象方法，验判定逻辑；这里起一个假 Emby HTTP 服务，让**真实的 EmbyClient** 真发请求，
 * 验"接到真实接口上，第二路到底会不会被掐掉、账号到底会不会被冻上"。
 */

interface FakeSession {
  Id: string;
  UserId: string;
  UserName: string;
  DeviceName: string;
  DeviceId: string;
  NowPlayingItem: { Name: string } | null;
  PlayState: { PositionTicks: number; IsPaused: boolean };
}

interface FakeUser {
  Id: string;
  Name: string;
  Policy: Record<string, unknown>;
}

/** POST body 解析：空/非法 body 一律当空对象（Emby 的 Stop/Logout 请求本来就不带 body）。 */
function parseBody(raw: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** 假 Emby：只实现并发链路会用到的接口，每次调用都记进 calls 供断言。 */
function startFakeEmby() {
  const users = new Map<string, FakeUser>();
  const sessions = new Map<string, FakeSession>();
  const devices = new Map<string, { Id: string; DeviceId: string }>();
  const calls: string[] = [];
  /** 让接下来 N 次策略写入"被 Emby 吃掉"（返回成功但没生效）。 */
  let rejectPolicyWrites = 0;

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = url.pathname.replace(/^\/emby/, "");
    const method = req.method ?? "GET";

    const json = (body: unknown): void => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const noContent = (): void => {
      res.writeHead(204);
      res.end();
    };

    // 真实客户端必须带 X-Emby-Token（顺带验证凭据真的发出去了）。
    if (!req.headers["x-emby-token"]) {
      res.writeHead(401);
      res.end();
      return;
    }

    const route = (body: Record<string, unknown>): void => {
      if (method === "GET" && path === "/Users") return json([...users.values()]);
      if (method === "GET" && path === "/Sessions") return json([...sessions.values()]);
      if (method === "GET" && path === "/Devices") return json({ Items: [...devices.values()] });

      const policy = path.match(/^\/Users\/([^/]+)\/Policy$/);
      if (method === "POST" && policy) {
        const user = users.get(policy[1]);
        calls.push(`policy:${policy[1]}:IsDisabled=${String(body.IsDisabled)}`);
        // Emby 的策略写是**整份覆盖**、不是字段合并：夹具必须照这个来，
        // 否则"只发一个字段会把别的字段冲掉"这类问题在测试里永远暴露不出来。
        if (rejectPolicyWrites > 0) rejectPolicyWrites -= 1;
        else if (user) user.Policy = { ...body };
        return noContent();
      }
      const stop = path.match(/^\/Sessions\/([^/]+)\/Playing\/Stop$/);
      if (method === "POST" && stop) {
        // 收到 Stop 的客户端"照做"：这一路不再播（PlayState 保留 = 客户端还在线）。
        const session = sessions.get(stop[1]);
        if (session) session.NowPlayingItem = null;
        calls.push(`stop:${stop[1]}`);
        return noContent();
      }
      const command = path.match(/^\/Sessions\/([^/]+)\/Command$/);
      if (method === "POST" && command) {
        sessions.delete(command[1]);
        calls.push(`logout:${command[1]}`);
        return noContent();
      }
      if (method === "DELETE" && path === "/Devices") {
        const wanted = url.searchParams.get("Id");
        const device = [...devices.values()].find((item) => item.Id === wanted);
        if (device) {
          devices.delete(device.DeviceId);
          // 令牌失效 → 该设备上的会话一并消失。
          for (const [id, session] of sessions) if (session.DeviceId === device.DeviceId) sessions.delete(id);
          calls.push(`kick:${device.DeviceId}`);
        }
        return noContent();
      }
      res.writeHead(404);
      res.end();
    };

    if (method === "GET" || method === "DELETE") return route({});
    let raw = "";
    req.on("data", (chunk) => (raw += String(chunk)));
    req.on("end", () => route(parseBody(raw)));
  });

  return {
    users,
    sessions,
    devices,
    calls,
    async listen(): Promise<string> {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("fake emby: no port");
      return `http://127.0.0.1:${address.port}`;
    },
    /** 让接下来 count 次策略写入失效（模拟写成功但没生效）。 */
    rejectPolicyWrites(count: number): void {
      rejectPolicyWrites = count;
    },
    close(): void {
      server.close();
    },
  };
}

const T0 = Date.parse("2026-01-01T00:00:00.000Z");
/** 判定用的是 Date.now()：用假时钟推进，避免真等几分钟。 */
const at = (offsetMs: number): Date => {
  const now = new Date(T0 + offsetMs);
  vi.setSystemTime(now);
  return now;
};
/** 一个检查周期（断言时间线用）。 */
const TICK = ESCALATION_TICK_MS;
/** 跑到「累计满 5 分钟」需要多少跳（+2 跳余量）。 */
const MAX_STEP = Math.ceil((5 * 60_000) / TICK) + 2;

describe("并发超限 → 冻结（端到端：真实 HTTP + 真实 EmbyClient）", () => {
  let directory: string;
  let database: DatabaseHandle;
  let emby: ReturnType<typeof startFakeEmby>;
  let client: EmbyClient;
  let sent: string[];

  const email = () =>
    ({
      configured: true,
      sendNotification: async (_to: string, subject: string) => void sent.push(subject),
      sendTest: async () => undefined,
      retryPending: async () => undefined,
    }) as unknown as EmailNotifier;

  /** 某个账号的一台设备开始播放（真实客户端登录开播的样子）。 */
  const play = (sessionId: string, userId: string, deviceId: string, positionTicks: number): void => {
    emby.sessions.set(sessionId, {
      Id: sessionId,
      UserId: userId,
      UserName: userId,
      DeviceName: deviceId,
      DeviceId: deviceId,
      NowPlayingItem: { Name: "测试影片" },
      PlayState: { PositionTicks: positionTicks, IsPaused: false },
    });
    emby.devices.set(deviceId, { Id: `device-row-${deviceId}`, DeviceId: deviceId });
  };

  const addMember = (input: { email: string; embyUserId: string; embyMaxStreams: number | null }): number => {
    const timestamp = new Date().toISOString();
    return database.db
      .insert(submissionUsers)
      .values({
        email: input.email,
        enabled: true,
        embyUserId: input.embyUserId,
        embyUsername: input.email,
        embyMaxStreams: input.embyMaxStreams,
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .returning({ id: submissionUsers.id })
      .get().id;
  };

  const escalationState = (memberId: number) =>
    database.db
      .select()
      .from(concurrencyEscalationState)
      .where(eq(concurrencyEscalationState.memberId, memberId))
      .get();

  const guardTick = (): ReturnType<typeof enforceStreamLimits> =>
    enforceStreamLimits(database.db, client, new StreamLimitResolver(database.db, client, 1));

  const escalate = (offsetMs: number) => enforceConcurrencyEscalation(database.db, client, email(), at(offsetMs));

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "concurrency-freeze-"));
    database = createDatabase(join(directory, "app.sqlite"));
    vi.useFakeTimers({ toFake: ["Date"] });
    clearStreamStopCooldown();
    sent = [];
    emby = startFakeEmby();
    const baseUrl = await emby.listen();
    client = createEmbyClient({ baseUrl, apiKey: "test-admin-key" });
    // 与后台默认值一致：累计超限 2 分钟提醒、5 分钟冻结 12 小时、未登记账号按 1 路。
    saveConcurrencyPolicy(database.db, {
      enabled: true,
      remindAfterMinutes: 2,
      disableAfterMinutes: 5,
      disableForHours: 12,
      adminEmail: null,
      interruptStreams: true,
      defaultStreamLimit: 1,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    emby.close();
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("未登记并发上限的会员：按「默认并发路数」走同一套冻结流程", async () => {
    // 线上现状就是这种会员（emby_max_streams 为空）：上限取默认 1 路，同样会被累计、提醒、冻结。
    const memberEmail = "unregistered@example.test";
    const userId = "u-unregistered";
    const memberId = addMember({ email: memberEmail, embyUserId: userId, embyMaxStreams: null });
    emby.users.set(userId, { Id: userId, Name: memberEmail, Policy: {} });
    play("s1", userId, "dev-1", 900_000_000);

    let frozeAt: number | null = null;
    for (let step = 0; step <= MAX_STEP && frozeAt == null; step += 1) {
      play("s2", userId, "dev-2", 1_000_000); // 第二路一直在
      const outcome = await escalate(step * TICK);
      if (outcome.frozen.length) frozeAt = step * TICK;
    }

    // 首次确认超限（t=0）→ 累计满 5 分钟 → 冻结
    expect(frozeAt).toBe(5 * 60_000);
    expect(sent).toEqual(["账号并发播放提醒", "账号已因超限冻结"]);
    expect(emby.users.get(userId)?.Policy.IsDisabled).toBe(true);
    expect(escalationState(memberId)?.overshootMs).toBe(0);
  });

  it("登记了上限的顽固客户端：提醒 → 到点冻结（停用+断全部会话+踢设备）→ 冻结期内单路也踢 → 到期恢复", async () => {
    const memberEmail = "stubborn@example.test";
    const userId = "u-stubborn";
    const memberId = addMember({ email: memberEmail, embyUserId: userId, embyMaxStreams: 1 });
    emby.users.set(userId, { Id: userId, Name: memberEmail, Policy: {} });
    play("s1", userId, "dev-1", 900_000_000);

    // 按真实节奏跑：升级任务每 30 秒一跳，看门狗每秒都在跑（这里每跳前跑一轮），
    // 客户端被掐掉就秒级重开 —— 持续对抗。
    let remindedAt: number | null = null;
    let frozeAt: number | null = null;
    for (let step = 0; step <= MAX_STEP && frozeAt == null; step += 1) {
      const t = step * TICK;
      at(t);
      await guardTick();
      play("s2", userId, "dev-2", 1_000_000);
      const outcome = await escalate(t);
      if (remindedAt == null && sent.includes("账号并发播放提醒")) remindedAt = t;
      if (outcome.frozen.length) frozeAt = t;
    }

    // 看门狗手段逐级加强：先请它停 → 断开会话 → 踢设备（令牌失效）
    expect(emby.calls).toContain("stop:s2");
    expect(emby.calls).toContain("logout:s2");
    expect(emby.calls).toContain("kick:dev-2");

    // 时间线：累计超限 2 分钟提醒、5 分钟冻结
    expect(remindedAt).toBe(2 * 60_000);
    expect(frozeAt).toBe(5 * 60_000);

    // 冻结 = 停用 + 断掉全部会话 + 踢掉设备 + 发信（只写策略位在这台 Emby 上等于没冻）
    expect(emby.calls).toContain(`policy:${userId}:IsDisabled=true`);
    expect(emby.calls).toContain("logout:s1");
    expect(emby.calls).toContain("kick:dev-1");
    expect(emby.sessions.size).toBe(0);
    expect(emby.devices.size).toBe(0);
    expect(sent).toEqual(["账号并发播放提醒", "账号已因超限冻结"]);
    expect(Date.parse(escalationState(memberId)!.disabledUntil!)).toBe(T0 + 5 * 60_000 + 12 * 3_600_000);
    expect(escalationState(memberId)?.overshootSince).toBeNull();
    expect(escalationState(memberId)?.overshootMs).toBe(0);

    // 冻结期内"一路都不许"：只剩 1 路（限内）也直接踢，不给重连机会
    clearStreamStopCooldown();
    play("s1", userId, "dev-1", 0);
    const duringFreeze = await guardTick();
    expect(duringFreeze.stoppedSessions).toEqual([{ sessionId: "s1", deviceName: "dev-1", action: "kick" }]);
    expect(emby.sessions.size).toBe(0);

    // 冻结 12 小时到期：自动恢复（Emby 重新启用）并清空状态
    const released = await escalate(5 * 60_000 + 12 * 3_600_000 + 1_000);
    expect(emby.users.get(userId)?.Policy.IsDisabled).toBe(false);
    expect(released.released).toEqual([memberEmail]);
    expect(escalationState(memberId)?.disabledUntil).toBeNull();
    expect(escalationState(memberId)?.overshootMs).toBe(0);
  });

  it("采样瞬间恰好回落也不清零：累计保住，仍能到点冻结（旧实现冻不掉人的根因）", async () => {
    // 看门狗每秒把第二路掐掉，升级任务 30 秒才采样一次 —— 采样时经常读到"已经回落限内"。
    // 只要这时候把计时清零，持续对抗的会员就永远攒不到阈值，冻结形同虚设。
    const userId = "u-intermittent";
    const memberEmail = "intermittent@example.test";
    const memberId = addMember({ email: memberEmail, embyUserId: userId, embyMaxStreams: 1 });
    emby.users.set(userId, { Id: userId, Name: memberEmail, Policy: {} });
    play("s1", userId, "dev-1", 900_000_000);

    // 第 1~3 跳：持续对抗，累计 90 秒
    for (let step = 0; step <= 3; step += 1) {
      play("s2", userId, "dev-2", 1_000_000);
      await escalate(step * TICK);
    }
    expect(escalationState(memberId)?.overshootMs).toBe(3 * TICK);

    // 第 4 跳：看门狗已经把第二路掐掉了、客户端这一轮还没来得及重开 → 采样读到"限内"
    emby.sessions.delete("s2");
    const idleTick = await escalate(4 * TICK);
    expect(idleTick.frozen).toEqual([]);
    expect(escalationState(memberId)?.overshootSince ?? null).toBeNull(); // 这一档闭合
    expect(escalationState(memberId)?.overshootMs).toBe(3 * TICK); // 但累计没被清掉
    expect(sent).toEqual([]); // 也还没到提醒档

    // 之后继续对抗：从 90 秒接着往上攒
    let frozeAt: number | null = null;
    for (let step = 5; step <= MAX_STEP && frozeAt == null; step += 1) {
      play("s2", userId, "dev-2", 1_000_000);
      const outcome = await escalate(step * TICK);
      if (outcome.frozen.length) frozeAt = step * TICK;
    }
    // 前 3 跳累计 30 秒 → 断一档（不清零）→ 从 30 秒接着攒：30 + 10×(N−5) ≥ 300 → N = 32
    expect(frozeAt).toBe(32 * TICK);
    expect(sent).toEqual(["账号并发播放提醒", "账号已因超限冻结"]);
    expect(emby.users.get(userId)?.Policy.IsDisabled).toBe(true);
  });

  it("只短暂超限一次就被掐掉的会员：累计攒不起来 → 不提醒、不冻结", async () => {
    // 换设备、客户端重连这类一次性重叠：只贡献不到一个检查周期的累计，永远到不了阈值，
    // 因此不会误伤 —— 这正是会员须知里"多次违规才临时封停"的口径。
    const userId = "u-obedient";
    const memberEmail = "obedient@example.test";
    const memberId = addMember({ email: memberEmail, embyUserId: userId, embyMaxStreams: 1 });
    emby.users.set(userId, { Id: userId, Name: memberEmail, Policy: {} });
    play("s1", userId, "dev-1", 900_000_000);
    play("s2", userId, "dev-2", 1_000_000);

    // 升级任务恰好撞见两路同时在播（开始累计，但这一跳计入 0）
    await escalate(0);
    expect(escalationState(memberId)?.overshootSince).toBe(new Date(T0).toISOString());

    // 看门狗掐掉第二路，客户端照做、不再重开
    at(500);
    const guard = await guardTick();
    expect(guard.stoppedSessions).toEqual([{ sessionId: "s2", deviceName: "dev-2", action: "stop" }]);

    // 之后连采 15 分钟：累计始终是 0
    for (let step = 1; step <= 30; step += 1) {
      const outcome = await escalate(step * TICK);
      expect(outcome.frozen).toEqual([]);
    }
    expect(escalationState(memberId)?.overshootMs).toBe(0);
    expect(escalationState(memberId)?.overshootSince ?? null).toBeNull();
    expect(sent).toEqual([]);
    expect(emby.calls.filter((call) => call.includes("IsDisabled=true"))).toEqual([]);
    expect(emby.calls).toContain("stop:s2");
    expect(emby.calls).not.toContain("logout:s2");
  });

  it("Emby 停用没生效时绝不发「已冻结」邮件：先断流、记失败，重试成功才发信", async () => {
    // 线上真事：会员收到"已冻结"，账号却照常用 —— 因为停用请求发出去就当成功了。
    // 这里让前两次策略写入被 Emby 吃掉（返回成功但回读仍是启用）。
    const userId = "u-reject";
    const memberEmail = "reject@example.test";
    const memberId = addMember({ email: memberEmail, embyUserId: userId, embyMaxStreams: 1 });
    emby.users.set(userId, { Id: userId, Name: memberEmail, Policy: {} });
    play("s1", userId, "dev-1", 900_000_000);
    emby.rejectPolicyWrites(2);

    let failuresSeen = 0;
    let sentWhenFirstFailed: string[] = [];
    let frozeAt: number | null = null;
    for (let step = 0; step <= MAX_STEP && frozeAt == null; step += 1) {
      play("s2", userId, "dev-2", 1_000_000);
      const outcome = await escalate(step * TICK);
      if (outcome.failures.length) {
        if (failuresSeen === 0) sentWhenFirstFailed = [...sent];
        failuresSeen += outcome.failures.length;
      }
      if (outcome.frozen.length) frozeAt = step * TICK;
    }

    expect(failuresSeen).toBeGreaterThan(0); // 失败被如实报出来，不再静默
    // 核心断言：停用没生效的那几轮，一封"已冻结"都不能发
    expect(sentWhenFirstFailed).not.toContain("账号已因超限冻结");
    // 重试成功后：只发一封冻结邮件，且账号真的停用了
    expect(sent).toEqual(["账号并发播放提醒", "账号已因超限冻结"]);
    expect(emby.users.get(userId)?.Policy.IsDisabled).toBe(true);
    expect(frozeAt).toBe(32 * TICK);
    expect(escalationState(memberId)?.disabledUntil).not.toBeNull();
  });

  it("冻结期内停用位被外部写回启用：下一个周期自动重新停用并留痕（整份覆盖式写入不能冲掉别的字段）", async () => {
    const userId = "u-clobber";
    const memberEmail = "clobber@example.test";
    addMember({ email: memberEmail, embyUserId: userId, embyMaxStreams: 1 });
    emby.users.set(userId, { Id: userId, Name: memberEmail, Policy: { SimultaneousStreamLimit: 7 } });
    play("s1", userId, "dev-1", 900_000_000);

    let frozeAt: number | null = null;
    for (let step = 0; step <= MAX_STEP && frozeAt == null; step += 1) {
      play("s2", userId, "dev-2", 1_000_000);
      const outcome = await escalate(step * TICK);
      if (outcome.frozen.length) frozeAt = step * TICK;
    }
    expect(frozeAt).toBe(5 * 60_000);
    // 停用这一下不能把账号自己的其它策略字段冲掉
    expect(emby.users.get(userId)?.Policy).toMatchObject({ IsDisabled: true, SimultaneousStreamLimit: 7 });

    // 模拟外部把停用位改回启用（一次会员上限同步 / 管理员改设置都会这样）
    emby.users.get(userId)!.Policy.IsDisabled = false;
    const healed = await escalate((MAX_STEP + 1) * TICK);

    expect(emby.users.get(userId)?.Policy.IsDisabled).toBe(true); // 自愈
    expect(healed.reasserted).toEqual([memberEmail]); // 且留了痕
    expect(healed.failures).toEqual([]);
    expect(emby.sessions.size).toBe(0); // 冻结期内继续断流
  });

  it("Emby 管理员不受影响：即使被登记成会员、开了多路，也不进冻结流程", async () => {
    const userId = "u-admin";
    const memberId = addMember({ email: "admin@example.test", embyUserId: userId, embyMaxStreams: 1 });
    emby.users.set(userId, { Id: userId, Name: "admin", Policy: { IsAdministrator: true } });
    play("s1", userId, "dev-1", 900_000_000);
    play("s2", userId, "dev-2", 1_000_000);

    for (let step = 0; step <= 15; step += 1) {
      at(step * TICK);
      await guardTick(); // 看门狗也不该动管理员
      const outcome = await escalate(step * TICK);
      expect(outcome.frozen).toEqual([]);
    }

    expect(sent).toEqual([]);
    expect(emby.users.get(userId)?.Policy.IsDisabled).toBeUndefined();
    expect(emby.calls.filter((call) => call.includes("IsDisabled=true"))).toEqual([]);
    // 看门狗层也不动他：没有 stop / logout / kick
    expect(
      emby.calls.filter((call) => call.startsWith("stop:") || call.startsWith("logout:") || call.startsWith("kick:")),
    ).toEqual([]);
    // 连升级状态行都不该建
    expect(escalationState(memberId)).toBeUndefined();
  });
});
