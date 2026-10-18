import { describe, expect, it } from "vitest";

import { createDatabase } from "@emby-task-center/database/client";
import { libraryItems, mediaRoots, submissionUsers } from "@emby-task-center/database/schema";

import type { EmbyActivityEntry, EmbyClient } from "../integrations/emby-client";
import { classifyActivityEntry, syncEmbyActivityLog } from "./activity-log";
import { insertUsageEvent, listEventsBetween } from "./usage-store";

function fakeEmby(entries: EmbyActivityEntry[], users: Record<string, { id: string; name: string }> = {}): EmbyClient {
  return {
    configured: true,
    systemInfo: async () => ({ serverName: "Emby", version: "4.8" }),
    verify: async () => true,
    listActivityLog: async () => entries,
    // /Users/{id}：GUID 与内部数字 id 都吃（见 emby-client.getUser）。
    getUser: async (userId: string) => users[userId] ?? null,
  } as unknown as EmbyClient;
}

const SAMPLE_USER_GUID = "0123456789abcdef0123456789abcdef";

describe("emby activity log classification", () => {
  it("recognises the entry shapes Emby actually emits", () => {
    expect(classifyActivityEntry({ Type: "AuthenticationSuccess" }).kind).toBe("login");
    expect(classifyActivityEntry({ ShortOverview: "User has logged in" }).kind).toBe("login");
    expect(classifyActivityEntry({ Type: "VideoPlayback" }).kind).toBe("play_start");
    expect(classifyActivityEntry({ ShortOverview: "admin has started playing 诛仙" }).kind).toBe("play_start");
    expect(classifyActivityEntry({ Type: "VideoPlaybackStopped" }).kind).toBe("play_stop");
    expect(classifyActivityEntry({ ShortOverview: "someone has finished playing 诛仙" }).kind).toBe("play_stop");
  });

  it("falls back to the localised text and keeps unknown entries as other", () => {
    expect(classifyActivityEntry({ Name: "用户已登录" }).kind).toBe("login");
    expect(classifyActivityEntry({ Name: "开始播放：诛仙" }).kind).toBe("play_start");
    expect(classifyActivityEntry({ Name: "停止播放：诛仙" }).kind).toBe("play_stop");
    expect(classifyActivityEntry({ Name: "用户已退出登录" }).kind).toBe("session_end");
    const unknown = classifyActivityEntry({ Type: "PluginInstalled", Name: "plugin installed" });
    expect(unknown.kind).toBe("other");
    expect(unknown.matched).toBe(false);
  });
});

describe("emby activity log sync", () => {
  it("backfills member events, attaches titles from the library, and never duplicates", async () => {
    const handle = createDatabase(":memory:");
    const now = new Date().toISOString();
    handle.db
      .insert(submissionUsers)
      .values({ email: "member@example.com", enabled: true, embyUserId: "emby-1", createdAt: now, updatedAt: now })
      .run();
    const root = handle.db
      .insert(mediaRoots)
      .values({ name: "电影", mediaType: "movie", containerPath: "/media/movies", createdAt: now, updatedAt: now })
      .returning()
      .get();
    handle.db
      .insert(libraryItems)
      .values({
        mediaRootId: root.id,
        relativePath: "movies/1.strm",
        sourceTitle: "诛仙",
        embyItemId: "item-1",
        createdAt: now,
        updatedAt: now,
      })
      .run();

    const client = fakeEmby(
      [
        { Id: 101, Type: "AuthenticationSuccess", UserId: "emby-1", Date: "2026-01-10T10:00:00.0000000Z" },
        {
          Id: 102,
          Type: "VideoPlayback",
          UserId: "emby-1",
          ItemId: "item-1",
          ShortOverview: "member has started playing 诛仙",
          Date: "2026-01-10T10:05:00.0000000Z",
        },
        // 没有 UserId 的活动（扫描、插件）不属于会员使用记录
        { Id: 103, Type: "PluginInstalled", Date: "2026-01-10T10:06:00.0000000Z" },
      ],
      { "emby-1": { id: "emby-1", name: "member@example.com" } },
    );

    const first = await syncEmbyActivityLog(handle.db, client);
    expect(first).toMatchObject({ fetched: 3, inserted: 2, unknown: 0, unsupported: false });

    const events = listEventsBetween(handle.db, "2026-01-01T00:00:00.000Z", "2026-02-01T00:00:00.000Z");
    expect(events).toHaveLength(2);
    const play = events.find((event) => event.kind === "play_start")!;
    expect(play.memberEmail).toBe("member@example.com");
    expect(play.itemTitle).toBe("诛仙");
    expect(play.detail).toContain("started playing");
    // Emby 的时间戳带 7 位小数秒：入库前统一裁到毫秒
    expect(play.occurredAt).toBe("2026-01-10T10:05:00.000Z");
    expect(play.source).toBe("activity_log");

    // 再同步一次：同一条活动不重复入库
    const second = await syncEmbyActivityLog(handle.db, client);
    expect(second.inserted).toBe(0);
    expect(listEventsBetween(handle.db, "2026-01-01T00:00:00.000Z", "2026-02-01T00:00:00.000Z")).toHaveLength(2);
    handle.close();
  });

  /**
   * 线上实测的坑：Emby 活动日志里的 `UserId` 是**内部数字 id**（同一账号在 /Sessions 里是
   * GUID `01234567…`，活动日志里却是 `1`）。早期版本直接当 Emby UserId 存 → 「会员使用情况」
   * 里冒出一个根本不存在的 `emby:1`（用户名也是空的，界面只能显示这个 key）。
   */
  it("resolves the activity log's internal numeric UserId into the real Emby account", async () => {
    const handle = createDatabase(":memory:");
    const now = new Date().toISOString();
    handle.db
      .insert(submissionUsers)
      .values({
        email: "member@example.com",
        enabled: true,
        embyUserId: SAMPLE_USER_GUID,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    const client = fakeEmby(
      [
        {
          Id: 5001,
          Type: "VideoPlayback",
          UserId: "1",
          ShortOverview: "sample-member has started playing 诛仙",
          Date: "2026-01-10T10:05:00.0000000Z",
        },
      ],
      { "1": { id: SAMPLE_USER_GUID, name: "sample-member" } },
    );

    const result = await syncEmbyActivityLog(handle.db, client);
    expect(result).toMatchObject({ inserted: 1, unresolved: 0 });

    const [event] = listEventsBetween(handle.db, "2026-01-01T00:00:00.000Z", "2026-02-01T00:00:00.000Z");
    expect(event.embyUserId).toBe(SAMPLE_USER_GUID);
    expect(event.userName).toBe("sample-member");
    expect(event.memberEmail).toBe("member@example.com");
    handle.close();
  });

  it("repairs legacy rows that stored the numeric id, then is idempotent", async () => {
    const handle = createDatabase(":memory:");
    const now = new Date().toISOString();
    handle.db
      .insert(submissionUsers)
      .values({
        email: "member@example.com",
        enabled: true,
        embyUserId: SAMPLE_USER_GUID,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    // 造一条历史遗留行（早期版本就是这么写的）
    insertUsageEvent(handle.db, {
      embyUserId: "1",
      memberEmail: null,
      userName: null,
      kind: "play_start",
      source: "activity_log",
      externalId: "legacy-5001",
      occurredAt: "2026-01-10T10:05:00.000Z",
    });

    const client = fakeEmby([], { "1": { id: SAMPLE_USER_GUID, name: "sample-member" } });
    const first = await syncEmbyActivityLog(handle.db, client);
    expect(first.repaired).toBe(1);

    const [repaired] = listEventsBetween(handle.db, "2026-01-01T00:00:00.000Z", "2026-02-01T00:00:00.000Z");
    expect(repaired.embyUserId).toBe(SAMPLE_USER_GUID);
    expect(repaired.userName).toBe("sample-member");
    expect(repaired.memberEmail).toBe("member@example.com");

    // 修完之后再同步：没有可修的行（幂等）
    const second = await syncEmbyActivityLog(handle.db, client);
    expect(second.repaired).toBe(0);
    handle.close();
  });

  it("skips entries whose user cannot be resolved instead of inventing an account", async () => {
    const handle = createDatabase(":memory:");
    const client = fakeEmby(
      [{ Id: 6001, Type: "VideoPlayback", UserId: "999", Date: "2026-01-10T10:05:00.0000000Z" }],
      {},
    );
    const result = await syncEmbyActivityLog(handle.db, client);
    expect(result).toMatchObject({ inserted: 0, unresolved: 1 });
    expect(listEventsBetween(handle.db, "2026-01-01T00:00:00.000Z", "2026-02-01T00:00:00.000Z")).toHaveLength(0);
    handle.close();
  });

  it("reports unsupported when the Emby client has no activity-log capability", async () => {
    const handle = createDatabase(":memory:");
    const result = await syncEmbyActivityLog(handle.db, { configured: true } as unknown as EmbyClient);
    expect(result.unsupported).toBe(true);
    handle.close();
  });
});
