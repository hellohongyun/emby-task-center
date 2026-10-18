import { describe, expect, it } from "vitest";

import { createDatabase } from "@emby-task-center/database/client";
import { memberUsageEvents, memberUsageSegments, submissionUsers } from "@emby-task-center/database/schema";

import { getUsageMemberDetail, listUsageOverview, localDateKey, usageRange } from "./usage-report";

function seed(database: ReturnType<typeof createDatabase>["db"]) {
  const now = new Date().toISOString();
  database
    .insert(submissionUsers)
    .values([
      { email: "watcher@example.com", enabled: true, embyUserId: "emby-1", createdAt: now, updatedAt: now },
      { email: "never@example.com", enabled: true, embyUserId: "emby-2", createdAt: now, updatedAt: now },
    ])
    .run();
}

function addPlay(
  database: ReturnType<typeof createDatabase>["db"],
  input: {
    sessionId: string;
    startedAt: Date;
    endedAt: Date;
    title: string;
    email: string;
    embyUserId: string;
    deviceId?: string;
  },
) {
  database
    .insert(memberUsageSegments)
    .values({
      sessionId: input.sessionId,
      embyUserId: input.embyUserId,
      memberEmail: input.email,
      userName: input.email,
      kind: "play",
      itemId: `item-${input.title}`,
      itemTitle: input.title,
      episodeTitle: null,
      deviceId: input.deviceId ?? "device-1",
      deviceName: "OPPO-PLG110",
      startedAt: input.startedAt.toISOString(),
      lastSeenAt: input.endedAt.toISOString(),
      endedAt: input.endedAt.toISOString(),
      positionTicks: 60_000_000,
      runTimeTicks: 600_000_000,
    })
    .run();
}

describe("member usage report", () => {
  it("buckets usage into local hour slots, per day, per member", () => {
    const handle = createDatabase(":memory:");
    seed(handle.db);

    const now = new Date();
    now.setHours(20, 30, 0, 0); // 今天 20:30
    const yesterdayStart = new Date(now.getTime() - 86_400_000);
    yesterdayStart.setHours(21, 30, 0, 0); // 昨天 21:30
    const yesterdayEnd = new Date(yesterdayStart.getTime() + 3_600_000); // 昨天 22:30
    const todayStart = new Date(now.getTime() - 30 * 60_000); // 今天 20:00

    addPlay(handle.db, {
      sessionId: "s-yesterday",
      startedAt: yesterdayStart,
      endedAt: yesterdayEnd,
      title: "诛仙",
      email: "watcher@example.com",
      embyUserId: "emby-1",
    });
    addPlay(handle.db, {
      sessionId: "s-today",
      startedAt: todayStart,
      endedAt: now,
      title: "斗破苍穹",
      email: "watcher@example.com",
      embyUserId: "emby-1",
      deviceId: "device-2",
    });
    handle.db
      .insert(memberUsageEvents)
      .values({
        embyUserId: "emby-1",
        memberEmail: "watcher@example.com",
        kind: "login",
        source: "sampler",
        deviceName: "OPPO-PLG110",
        occurredAt: todayStart.toISOString(),
        createdAt: new Date().toISOString(),
      })
      .run();

    const overview = listUsageOverview(handle.db, { days: 7, now });
    const watcher = overview.members.find((member) => member.email === "watcher@example.com")!;
    expect(watcher.playMinutes).toBe(90); // 昨天 60 + 今天 30
    expect(watcher.plays).toBe(2);
    expect(watcher.loginCount).toBe(1);
    expect(watcher.activeDays).toBe(2);
    // 昨天 21:30→22:30 跨整点，切成两个时段；今天 20:00→20:30 落在 20 点
    expect(watcher.hourly[21]).toBe(30);
    expect(watcher.hourly[22]).toBe(30);
    expect(watcher.hourly[20]).toBe(30);
    expect(watcher.daily.map((day) => day.date)).toEqual([localDateKey(now), localDateKey(yesterdayStart)]);
    expect(watcher.topItems[0].title).toBe("诛仙");

    // 窗口只留今天：昨天的记录不参与统计
    const todayOnly = listUsageOverview(handle.db, { days: 1, now });
    const todayWatcher = todayOnly.members.find((member) => member.email === "watcher@example.com")!;
    expect(todayWatcher.playMinutes).toBe(30);
    expect(todayWatcher.hourly[21]).toBe(0);

    // 完全没有使用的会员也要在列表里（显示 0，而不是消失）
    const never = todayOnly.members.find((member) => member.email === "never@example.com")!;
    expect(never.playMinutes).toBe(0);
    expect(never.lastLoginAt).toBeNull();
    expect(todayOnly.totals.knownMembers).toBe(2);
    expect(todayOnly.totals.activeMembers).toBe(1);
    expect(todayOnly.totals.playHours).toBe(0.5);
    expect(todayOnly.totals.devices).toBe(1);

    // 总览的时段分布 = 各会员之和
    expect(todayOnly.hourly[20]).toBe(30);
    handle.close();
  });

  /**
   * 我们自己后台客户端的连接（没有 UserId、没有用户名）不是会员使用：不进列表，也不该把设备数算大。
   */
  it("leaves rows without any identity out of the member list", () => {
    const handle = createDatabase(":memory:");
    seed(handle.db);
    const now = new Date();
    now.setHours(20, 30, 0, 0);
    const start = new Date(now.getTime() - 30 * 60_000);
    handle.db
      .insert(memberUsageSegments)
      .values({
        sessionId: "s-anonymous",
        embyUserId: null,
        memberEmail: null,
        userName: null,
        kind: "idle",
        itemId: "",
        deviceId: "device-self",
        deviceName: "Google Chrome Windows",
        client: "媒体任务中心",
        startedAt: start.toISOString(),
        lastSeenAt: now.toISOString(),
        endedAt: now.toISOString(),
      })
      .run();
    handle.db
      .insert(memberUsageEvents)
      .values({
        embyUserId: null,
        memberEmail: null,
        userName: null,
        kind: "session_end",
        source: "sampler",
        deviceName: "Google Chrome Windows",
        occurredAt: now.toISOString(),
        createdAt: new Date().toISOString(),
      })
      .run();

    const overview = listUsageOverview(handle.db, { days: 1, now });
    expect(overview.members.some((member) => member.key === "name:unknown")).toBe(false);
    expect(overview.members.every((member) => member.email !== null)).toBe(true);
    expect(overview.totals.devices).toBe(0);
    expect(overview.totals.playHours).toBe(0);
    handle.close();
  });

  it("builds the per-member detail page (heatmap + timeline)", () => {
    const handle = createDatabase(":memory:");
    seed(handle.db);
    const now = new Date();
    now.setHours(22, 0, 0, 0);
    const start = new Date(now.getTime() - 45 * 60_000);
    addPlay(handle.db, {
      sessionId: "s1",
      startedAt: start,
      endedAt: now,
      title: "诛仙",
      email: "watcher@example.com",
      embyUserId: "emby-1",
    });
    handle.db
      .insert(memberUsageEvents)
      .values([
        {
          embyUserId: "emby-1",
          memberEmail: "watcher@example.com",
          kind: "play_start",
          source: "sampler",
          itemTitle: "诛仙",
          episodeTitle: "镇魔古洞",
          seasonNumber: 4,
          episodeNumber: 4,
          deviceName: "OPPO-PLG110",
          client: "Yamby",
          appVersion: "2.0.5.5",
          remoteAddress: "192.0.2.10",
          occurredAt: start.toISOString(),
          createdAt: new Date().toISOString(),
        },
      ])
      .run();

    const detail = getUsageMemberDetail(handle.db, { days: 7, key: "email:watcher@example.com", now });
    expect(detail).toBeTruthy();
    expect(detail!.member.playMinutes).toBe(45);
    expect(detail!.heatmap).toHaveLength(1);
    expect(detail!.heatmap[0].date).toBe(localDateKey(now));
    expect(detail!.heatmap[0].hours[21]).toBe(45); // 21:15 → 22:00 全落在 21 点这一格
    expect(detail!.heatmap[0].hours[22]).toBe(0);
    expect(detail!.events).toHaveLength(1);
    expect(detail!.events[0]).toMatchObject({ kind: "play_start", episodeNumber: 4, client: "Yamby" });
    expect(getUsageMemberDetail(handle.db, { days: 7, key: "email:nobody@example.com", now })).toBeNull();
    handle.close();
  });

  it("computes the requested range in local days", () => {
    const now = new Date(2026, 5, 15, 12, 0, 0);
    const range = usageRange(7, now);
    const from = new Date(range.from);
    expect(from.getHours()).toBe(0);
    expect(from.getMinutes()).toBe(0);
    // 含今天在内的 7 天
    expect((now.getTime() - from.getTime()) / 86_400_000).toBeGreaterThan(5.9);
    expect(range.days).toBe(7);
    expect(usageRange(9_999, now).days).toBe(365);
  });
});
