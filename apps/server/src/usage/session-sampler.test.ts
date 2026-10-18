import { describe, expect, it } from "vitest";

import { createDatabase } from "@emby-task-center/database/client";
import { submissionUsers } from "@emby-task-center/database/schema";

import type { EmbySession } from "../integrations/emby-client";
import { sampleMemberSessions } from "./session-sampler";
import { listEventsBetween, listSegmentsBetween } from "./usage-store";
import { listUsageOverview } from "./usage-report";

function seedMember(database: ReturnType<typeof createDatabase>["db"], email: string, embyUserId: string) {
  const now = new Date().toISOString();
  database.insert(submissionUsers).values({ email, enabled: true, embyUserId, createdAt: now, updatedAt: now }).run();
}

function playingSession(item?: { id: string; name: string; index: number }): EmbySession {
  const episode = item ?? { id: "item-1", name: "镇魔古洞", index: 4 };
  return {
    Id: "session-1",
    UserId: "emby-user-1",
    UserName: "member@example.com",
    DeviceName: "OPPO-PLG110",
    DeviceId: "device-1",
    Client: "Yamby",
    ApplicationVersion: "2.0.5.5",
    NowPlayingItem: {
      Id: episode.id,
      Name: episode.name,
      SeriesName: "诛仙",
      Type: "Episode",
      ParentIndexNumber: 4,
      IndexNumber: episode.index,
      RunTimeTicks: 12_670_000_000,
    },
    PlayState: { PositionTicks: 0, PlayMethod: "DirectPlay" },
  };
}

describe("member usage sampler", () => {
  it("turns a session snapshot into segments and login/play events", () => {
    const handle = createDatabase(":memory:");
    seedMember(handle.db, "member@example.com", "emby-user-1");
    // 用"今天的 20:00"而不是写死日期：时段断言（hourly[20]）与 7 天窗口都不受运行日期影响。
    const t0 = new Date();
    t0.setHours(20, 0, 0, 0);

    // ① 第一次看到：开播里的一段 + 登录 + 开始播放
    const first = sampleMemberSessions(handle.db, [playingSession()], t0);
    expect(first).toMatchObject({ observed: 1, opened: 1, closed: 0, events: 2 });

    // ② 30 秒后同一路播放：只是延长，不产生新事件
    const second = sampleMemberSessions(
      handle.db,
      [
        {
          ...playingSession(),
          PlayState: { PositionTicks: 300_000_000, PlayMethod: "DirectPlay" },
        },
      ],
      new Date(t0.getTime() + 30_000),
    );
    expect(second).toMatchObject({ opened: 0, extended: 1, events: 0 });

    // ③ 换集：旧段封口（play_stop），新段开张（play_start）
    const nextEpisode = { id: "item-2", name: "血战", index: 5 };
    const third = sampleMemberSessions(handle.db, [playingSession(nextEpisode)], new Date(t0.getTime() + 60_000));
    expect(third).toMatchObject({ opened: 1, closed: 1, events: 2 }); // play_stop + play_start

    // ④ 同一集又看了 60 秒 → 延长（不换片就不该切段）
    const fourth = sampleMemberSessions(handle.db, [playingSession(nextEpisode)], new Date(t0.getTime() + 120_000), {
      intervalMs: 60_000,
    });
    expect(fourth).toMatchObject({ opened: 0, extended: 1, events: 0 });

    // ⑤ 客户端下线：还没到"两个周期没见到"的容忍边界，先不封口
    const stillOpen = sampleMemberSessions(handle.db, [], new Date(t0.getTime() + 150_000), {
      intervalMs: 60_000,
    });
    expect(stillOpen.closed).toBe(0);

    // ⑥ 超过容忍边界 → 封口，且封口时间取最后一次看到的时间（不编造时长）
    const closed = sampleMemberSessions(handle.db, [], new Date(t0.getTime() + 300_000), { intervalMs: 60_000 });
    expect(closed.closed).toBe(1);

    const segments = listSegmentsBetween(
      handle.db,
      new Date(t0.getTime() - 86_400_000).toISOString(),
      new Date(t0.getTime() + 86_400_000).toISOString(),
    );
    expect(segments).toHaveLength(2);
    expect(segments.every((segment) => segment.endedAt != null)).toBe(true);
    expect(segments[0].memberEmail).toBe("member@example.com");
    expect(segments[0].itemTitle).toBe("诛仙");
    expect(segments[0].episodeTitle).toBe("镇魔古洞");
    expect(segments[0].seasonNumber).toBe(4);
    expect(segments[0].episodeNumber).toBe(4);
    expect(segments[0].deviceId).toBe("device-1");
    expect(segments[0].playMethod).toBe("DirectPlay");
    // 第 1 段：t0 → t0+60s；第 2 段：t0+60s → t0+120s
    expect(Date.parse(segments[0].endedAt!) - Date.parse(segments[0].startedAt)).toBe(60_000);
    expect(Date.parse(segments[1].endedAt!) - Date.parse(segments[1].startedAt)).toBe(60_000);

    const events = listEventsBetween(
      handle.db,
      new Date(t0.getTime() - 86_400_000).toISOString(),
      new Date(t0.getTime() + 86_400_000).toISOString(),
    );
    expect(events.map((event) => event.kind).sort()).toEqual([
      "login",
      "play_start",
      "play_start",
      "play_stop",
      "play_stop",
    ]);
    // 结束播放的事件带着"看到哪儿了"
    expect(events.find((event) => event.kind === "play_stop")?.positionTicks).not.toBeNull();

    // ⑦ 汇总：2 分钟播放、2 次播放、1 次登录，时段落在 20 点（本地时间）
    const overview = listUsageOverview(handle.db, { days: 7, now: new Date(t0.getTime() + 600_000) });
    const member = overview.members.find((row) => row.email === "member@example.com")!;
    expect(member.playMinutes).toBe(2);
    expect(member.plays).toBe(2);
    expect(member.loginCount).toBe(1);
    expect(member.hourly[20]).toBe(2);
    expect(overview.totals.plays).toBe(2);
    expect(overview.totals.activeMembers).toBe(1);
    handle.close();
  });

  it("records idle sessions (client connected, nothing playing) without a play event", () => {
    const handle = createDatabase(":memory:");
    seedMember(handle.db, "idle@example.com", "emby-user-2");
    const t0 = new Date();
    t0.setHours(9, 0, 0, 0);

    const result = sampleMemberSessions(
      handle.db,
      [{ Id: "session-9", UserId: "emby-user-2", UserName: "idle@example.com", DeviceName: "Xiaomi TV" }],
      t0,
    );
    expect(result).toMatchObject({ opened: 1, events: 1 }); // 只有登录
    const segments = listSegmentsBetween(
      handle.db,
      new Date(t0.getTime() - 1_000).toISOString(),
      new Date(t0.getTime() + 1_000).toISOString(),
    );
    expect(segments[0].kind).toBe("idle");
    expect(segments[0].itemTitle).toBeNull();
    handle.close();
  });

  /**
   * 线上：我们自己后台的「媒体任务中心 / TgtoDrive」连接也在 /Sessions 里，但没有 UserId。
   * 早期它们被记成 name:unknown，在「会员使用情况」里多出一行说不出是谁的记录，还把设备数算大。
   */
  it("ignores sessions that belong to no Emby user", () => {
    const handle = createDatabase(":memory:");
    const t0 = new Date();
    t0.setHours(10, 0, 0, 0);
    const result = sampleMemberSessions(
      handle.db,
      [{ Id: "session-self", Client: "媒体任务中心", DeviceName: "Google Chrome Windows" }],
      t0,
    );
    expect(result).toMatchObject({ observed: 0, opened: 0, events: 0 });
    expect(
      listSegmentsBetween(
        handle.db,
        new Date(t0.getTime() - 1_000).toISOString(),
        new Date(t0.getTime() + 1_000).toISOString(),
      ),
    ).toHaveLength(0);
    handle.close();
  });

  it("keeps watches from unbound Emby accounts instead of dropping them", () => {
    const handle = createDatabase(":memory:");
    const t0 = new Date();
    t0.setHours(21, 30, 0, 0);
    const result = sampleMemberSessions(handle.db, [playingSession()], t0);
    expect(result.opened).toBe(1);
    const overview = listUsageOverview(handle.db, { days: 1, now: new Date(t0.getTime() + 60_000) });
    const orphan = overview.members.find((row) => row.key === "emby:emby-user-1");
    expect(orphan).toBeTruthy();
    expect(orphan?.email).toBeNull();
    handle.close();
  });
});
