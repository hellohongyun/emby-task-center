import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDatabase, type DatabaseHandle } from "@emby-task-center/database/client";
import { concurrencyEscalationState, submissionUsers } from "@emby-task-center/database/schema";
import type { EmbyClient } from "../integrations/emby-client";
import { clearStreamStopCooldown, enforceStreamLimits, pickSessionsToStop } from "./stream-guard";
import { StreamLimitResolver } from "./stream-limits";

const session = (id: string, positionTicks: number | null, userId = "u1") => ({
  id,
  userId,
  deviceName: `dev-${id}`,
  deviceId: `device-${id}`,
  positionTicks,
});

/**
 * 并发看门狗：同一账号多路播放时**真的停掉多出来的**（先到先得，中断后来者）。
 * 这里是并发限制唯一的执行点：已在播的流只能靠它收尾。
 */
describe("stream guard", () => {
  let directory: string;
  let database: DatabaseHandle;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "stream-guard-"));
    database = createDatabase(join(directory, "app.sqlite"));
    // 停止冷却记在模块级 Map 里，用例之间要清掉，否则后一个用例会被前一个的冷却挡住。
    clearStreamStopCooldown();
  });

  afterEach(() => {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("keeps the session that has been playing longest and stops the newcomer", () => {
    const kept = session("a", 900_000_000);
    const newcomer = session("b", 1_000_000);
    expect(pickSessionsToStop([newcomer, kept], 1)).toEqual([newcomer]);
    expect(pickSessionsToStop([newcomer, kept], 2)).toEqual([]);
    // 不限（0）时什么都不停
    expect(pickSessionsToStop([newcomer, kept], 0)).toEqual([]);
    // 三个会话 + 1 路 → 停掉后面两个（先停进度次大的，再停最小的）
    const third = session("c", 5_000_000);
    expect(pickSessionsToStop([third, kept, newcomer], 1).map((item) => item.id)).toEqual(["c", "b"]);
  });

  it("stops only the extra sessions, via stopPlayback", async () => {
    const stopped: string[] = [];
    const emby = {
      configured: true,
      listSessions: vi.fn().mockResolvedValue([
        { Id: "s1", UserId: "u1", NowPlayingItem: { Name: "A" }, PlayState: { PositionTicks: 900 } },
        { Id: "s2", UserId: "u1", NowPlayingItem: { Name: "A" }, PlayState: { PositionTicks: 10 } },
        { Id: "s3", UserId: "u2", NowPlayingItem: { Name: "B" }, PlayState: { PositionTicks: 500 } },
      ]),
      stopPlayback: vi.fn(async (id: string) => void stopped.push(id)),
    } as unknown as EmbyClient;

    const result = await enforceStreamLimits(database.db, emby);

    expect(stopped).toEqual(["s2"]);
    expect(result.stopped).toBe(1);
    expect(result.overshootUsers).toBe(1);
    // 日志要能说清"停了哪台设备"（这条用例的会话没带设备名 → 兜底文案）
    expect(result.stoppedSessions).toEqual([{ sessionId: "s2", deviceName: "未知设备", action: "stop" }]);
    // 有人在播 → 调用方据此改成每秒盯一次
    expect(result.playingUsers).toBe(2);
  });

  it("escalates stop → logout → device kick when the client ignores everything", async () => {
    // 真实案例：某客户端收到 Stop 命令后照播不误，只有断开会话才真的停下。
    const stopped: string[] = [];
    const loggedOut: string[] = [];
    const kicked: string[] = [];
    const emby = {
      configured: true,
      listSessions: vi.fn().mockResolvedValue([
        { Id: "s1", UserId: "u1", DeviceId: "dev-1", NowPlayingItem: { Name: "A" }, PlayState: { PositionTicks: 900 } },
        { Id: "s2", UserId: "u1", DeviceId: "dev-2", NowPlayingItem: { Name: "A" }, PlayState: { PositionTicks: 10 } },
      ]),
      stopPlayback: vi.fn(async (id: string) => void stopped.push(id)),
      endSession: vi.fn(async (id: string) => void loggedOut.push(id)),
      removeDevice: vi.fn(async (deviceId: string) => {
        kicked.push(deviceId);
        return true;
      }),
    } as unknown as EmbyClient;
    const resolve = new StreamLimitResolver(database.db, emby);

    // 第 1 次：请客户端停止播放
    await enforceStreamLimits(database.db, emby, resolve);
    expect(stopped).toEqual(["s2"]);

    // 第 2 次：还不停 → 升级为断开该会话
    vi.setSystemTime(Date.now() + 1_100);
    const second = await enforceStreamLimits(database.db, emby, resolve);
    expect(loggedOut).toEqual(["s2"]);
    expect(second.stoppedSessions).toEqual([{ sessionId: "s2", deviceName: "未知设备", action: "logout" }]);

    // 断开也没用 → 升级为踢设备（令牌失效，客户端必须重新登录），之后每 3 秒继续踢
    vi.setSystemTime(Date.now() + 3_100);
    const third = await enforceStreamLimits(database.db, emby, resolve);
    expect(kicked).toEqual(["dev-2"]);
    expect(third.stoppedSessions).toEqual([{ sessionId: "s2", deviceName: "未知设备", action: "kick" }]);
    vi.useRealTimers();
  });

  it("踢设备失败（设备不在 /Devices 里）时如实降级为断会话，不谎报踢设备", async () => {
    // 线上真事：日志连着两分钟写"（踢设备）"，其实 removeDevice 返回 false、只断了会话，
    // 排查时以为踢过了。这里把两种结果分开断言。
    const loggedOut: string[] = [];
    const emby = {
      configured: true,
      listSessions: vi.fn().mockResolvedValue([
        { Id: "s1", UserId: "u1", DeviceId: "dev-1", NowPlayingItem: { Name: "A" }, PlayState: { PositionTicks: 900 } },
        { Id: "s2", UserId: "u1", DeviceId: "dev-2", NowPlayingItem: { Name: "A" }, PlayState: { PositionTicks: 10 } },
      ]),
      stopPlayback: vi.fn(async () => undefined),
      endSession: vi.fn(async (id: string) => void loggedOut.push(id)),
      removeDevice: vi.fn(async () => false), // Emby 的 /Devices 里找不到这台设备
    } as unknown as EmbyClient;
    const resolve = new StreamLimitResolver(database.db, emby);

    await enforceStreamLimits(database.db, emby, resolve); // ① 请它停
    vi.setSystemTime(Date.now() + 1_100);
    await enforceStreamLimits(database.db, emby, resolve); // ② 断开会话
    vi.setSystemTime(Date.now() + 3_100);
    const third = await enforceStreamLimits(database.db, emby, resolve); // ③ 想踢设备，踢不动 → 断会话

    expect(third.stoppedSessions).toEqual([{ sessionId: "s2", deviceName: "未知设备", action: "logout" }]);
    expect(loggedOut).toContain("s2");
    vi.useRealTimers();
  });

  it("terminates every session of a frozen member, even a single one within the limit", async () => {
    // 冻结期间一路都不许：这台 Emby 不因账号停用中断已登录设备，
    // 所以哪怕只有 1 路（限内），看门狗也要直接踢掉。
    const timestamp = new Date().toISOString();
    const memberId = database.db
      .insert(submissionUsers)
      .values({
        email: "blocked@example.test",
        enabled: true,
        embyUserId: "u1",
        embyUsername: "blocked",
        embyMaxStreams: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .returning({ id: submissionUsers.id })
      .get().id;
    database.db
      .insert(concurrencyEscalationState)
      .values({
        memberId,
        overshootSince: null,
        notifiedAt: null,
        disabledUntil: new Date(Date.now() + 3_600_000).toISOString(),
        updatedAt: timestamp,
      })
      .run();

    const kicked: string[] = [];
    const emby = {
      configured: true,
      listSessions: vi.fn().mockResolvedValue([
        {
          Id: "s1",
          UserId: "u1",
          DeviceId: "dev-1",
          NowPlayingItem: { Name: "A" },
          PlayState: { PositionTicks: 900 },
        },
      ]),
      stopPlayback: vi.fn(async () => undefined),
      endSession: vi.fn(async () => undefined),
      removeDevice: vi.fn(async (deviceId: string) => {
        kicked.push(deviceId);
        return true;
      }),
    } as unknown as EmbyClient;

    const result = await enforceStreamLimits(database.db, emby);

    expect(kicked).toEqual(["dev-1"]);
    expect(result.stopped).toBe(1);
    expect(result.stoppedSessions).toEqual([{ sessionId: "s1", deviceName: "未知设备", action: "kick" }]);
  });

  it("leaves idle sessions alone (only playing/paused count)", async () => {
    const stopped: string[] = [];
    const emby = {
      configured: true,
      listSessions: vi.fn().mockResolvedValue([
        { Id: "s1", UserId: "u1", NowPlayingItem: { Name: "A" }, PlayState: { PositionTicks: 900 } },
        { Id: "s2", UserId: "u1", NowPlayingItem: null, PlayState: null },
        { Id: "s3", UserId: "u1", NowPlayingItem: null, PlayState: null },
      ]),
      stopPlayback: vi.fn(async (id: string) => void stopped.push(id)),
    } as unknown as EmbyClient;

    const idle = await enforceStreamLimits(database.db, emby);
    expect(idle.stopped).toBe(0);
    expect(idle.overshootUsers).toBe(0);
    expect(stopped).toEqual([]);
  });
});

describe("stream limit resolver", () => {
  let directory: string;
  let database: DatabaseHandle;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "stream-limit-"));
    database = createDatabase(join(directory, "app.sqlite"));
  });

  afterEach(() => {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const memberRow = (embyUserId: string, embyMaxStreams: number | null) => ({
    email: `${embyUserId}@example.test`,
    enabled: true,
    subscriptionExpiresAt: null,
    embyUserId,
    embyUsername: embyUserId,
    embyMaxStreams,
    note: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  it("uses the member's own limit, otherwise the default, and exempts administrators", async () => {
    database.db.insert(submissionUsers).values(memberRow("registered", 3)).run();
    database.db.insert(submissionUsers).values(memberRow("plain", null)).run();
    const emby = {
      configured: true,
      listUsers: vi.fn().mockResolvedValue([{ Id: "admin", Name: "admin", Policy: { IsAdministrator: true } }]),
    } as unknown as EmbyClient;
    const resolver = new StreamLimitResolver(database.db, emby, 1);

    expect(await resolver.limitFor("registered")).toBe(3);
    expect(await resolver.limitFor("plain")).toBe(1);
    expect(await resolver.limitFor("admin")).toBeNull();
    // 用户列表带缓存：看门狗每隔几秒判定一次管理员，不能每次都打 Emby
    expect(emby.listUsers).toHaveBeenCalledTimes(1);
  });

  it("honours a 0 default as unlimited", async () => {
    const emby = { configured: true, listUsers: vi.fn().mockResolvedValue([]) } as unknown as EmbyClient;
    const resolver = new StreamLimitResolver(database.db, emby, 0);
    expect(await resolver.limitFor("anyone")).toBeNull();
  });

  it("reports whether a member is inside an over-limit freeze window", () => {
    const timestamp = new Date().toISOString();
    const memberId = database.db
      .insert(submissionUsers)
      .values(memberRow("frozen", 1))
      .returning({ id: submissionUsers.id })
      .get().id;
    // 没有冻结状态 → 不算冻结
    expect(new StreamLimitResolver(database.db, undefined, 1).isFrozen("frozen")).toBe(false);

    database.db
      .insert(concurrencyEscalationState)
      .values({
        memberId,
        overshootSince: null,
        notifiedAt: null,
        disabledUntil: new Date(Date.now() + 60 * 60_000).toISOString(),
        updatedAt: timestamp,
      })
      .run();
    expect(new StreamLimitResolver(database.db, undefined, 1).isFrozen("frozen")).toBe(true);

    // 冻结已到期 → 不再算冻结（恢复由升级任务写回状态，这里只看时间）
    database.db
      .update(concurrencyEscalationState)
      .set({ disabledUntil: new Date(Date.now() - 1_000).toISOString() })
      .run();
    expect(new StreamLimitResolver(database.db, undefined, 1).isFrozen("frozen")).toBe(false);
  });
});
