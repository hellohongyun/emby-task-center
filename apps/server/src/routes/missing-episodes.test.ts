import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

import { createDatabase, type DatabaseHandle } from "@emby-task-center/database/client";
import {
  auditLogs,
  libraryEpisodes,
  libraryItems,
  mediaItems,
  mediaRoots,
  missingEpisodeSnapshots,
} from "@emby-task-center/database/schema";
import { createApp } from "../app";
import { staticCredentialVerifier } from "../auth/test-session";
import type { EmbyClient, EmbyLibraryItem } from "../integrations/emby-client";
import type { MissingEpisodeScanner } from "../library/missing-episode-scan";
import { createLibraryService } from "../library/service";
import type { EmailNotifier } from "../notifications/email-service";
import type { TmdbClient } from "../tmdb/client";

const sharedPassword = "family-password";
const sessionSecret = "session-signing-secret";

/** 带可变方法的 Emby 替身：测试里只驱动用到的那两个方法，绝不碰真实 Emby。 */
interface EmbyStub extends EmbyClient {
  configured: boolean;
  searchItems: ReturnType<typeof vi.fn>;
  deleteItem: ReturnType<typeof vi.fn>;
  listLibraryItems: ReturnType<typeof vi.fn>;
}

const tmdbStub: TmdbClient = {
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
  seasonEpisodes: async () => [],
  airedEpisodeCount: async () => 1,
};

describe("缺集总览（全库）", () => {
  let directory: string;
  let database: DatabaseHandle;
  let server: Server;
  let baseUrl: string;
  let cookie: string;
  let emby: EmbyStub;
  let scannerRun: ReturnType<typeof vi.fn>;
  let scannerRunning: boolean;
  let scanner: MissingEpisodeScanner;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "emby-missing-api-"));
    database = createDatabase(join(directory, "app.sqlite"));
    emby = {
      configured: true,
      systemInfo: vi.fn().mockResolvedValue({ id: "server-1", serverName: "天鸿影视", version: "4.10.0.40" }),
      searchItems: vi.fn().mockResolvedValue([]),
      listLibraryItems: vi.fn().mockResolvedValue([]),
      listItemEpisodes: vi.fn().mockResolvedValue([{ id: "e1", seasonNumber: 1, episodeNumber: 1, name: "开端" }]),
      deleteItem: vi.fn().mockResolvedValue(undefined),
    } as unknown as EmbyStub;
    scannerRunning = false;
    scannerRun = vi.fn().mockResolvedValue(undefined);
    scanner = {
      status: () => ({
        running: scannerRunning,
        trigger: null,
        startedAt: null,
        finishedAt: null,
        total: 10,
        processed: 3,
        missingShows: 0,
        missingEpisodes: 0,
        pendingShows: 0,
        pendingEpisodes: 0,
        suspectShows: 0,
        mismatches: 0,
        failed: 0,
        error: null,
      }),
      run: scannerRun as unknown as MissingEpisodeScanner["run"],
    };
    const app = createApp({
      database: database.db,
      auth: { sessionSecret, verifyCredentials: staticCredentialVerifier(sharedPassword) },
      tmdb: tmdbStub,
      library: createLibraryService([]),
      integrationServices: { email: { configured: false } as EmailNotifier, emby },
      missingEpisodeScanner: scanner,
      publicEmbyBaseUrl: "https://emby.test",
    });
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: sharedPassword }),
    });
    cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });

  function seedShow(): { mediaItemId: number } {
    const timestamp = "2026-01-01T00:00:00.000Z";
    const root = database.db
      .insert(mediaRoots)
      .values({ name: "动漫", mediaType: "tv", containerPath: "emby:1", createdAt: timestamp, updatedAt: timestamp })
      .returning()
      .get()!;
    const media = database.db
      .insert(mediaItems)
      .values({
        tmdbId: 202,
        mediaType: "tv",
        title: "暗黑",
        posterUrl: "https://image.test/dark.jpg",
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .returning()
      .get()!;
    const item = database.db
      .insert(libraryItems)
      .values({
        mediaRootId: root.id,
        mediaItemId: media.id,
        relativePath: "暗黑/Season 1/EP01 [e1].strm",
        embyItemId: "e1",
        sourceTitle: "暗黑",
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .returning()
      .get()!;
    database.db
      .insert(libraryEpisodes)
      .values({
        libraryItemId: item.id,
        parsedSeason: 1,
        episodeNumber: 1,
        numberingMode: "seasonal",
        createdAt: timestamp,
      })
      .run();
    database.db
      .insert(missingEpisodeSnapshots)
      .values({
        mediaItemId: media.id,
        tmdbId: 202,
        title: "暗黑",
        embySeriesId: "series-1",
        embyTmdbId: 202,
        embySeasons: [{ seasonNumber: 1, id: "season-1" }],
        tmdbSeasons: [
          {
            seasonNumber: 1,
            episodes: [
              { episodeNumber: 1, name: "开端", airDate: "2020-01-01" },
              { episodeNumber: 2, name: "谎言", airDate: "2020-01-08" },
            ],
          },
        ],
        fetchedAt: timestamp,
        missing: [
          {
            seasonNumber: 1,
            aired: 2,
            stored: 1,
            episodes: [{ episodeNumber: 2, name: "谎言", airDate: "2020-01-08" }],
          },
        ],
        unmatchedSeasons: [],
        airedCount: 2,
        storedCount: 1,
        missingCount: 1,
        error: null,
        scannedAt: timestamp,
      })
      .run();
    return { mediaItemId: media.id };
  }

  it("serves the snapshot with libraries, episode names and scan progress", async () => {
    const { mediaItemId } = seedShow();
    scannerRunning = true;

    const response = await fetch(`${baseUrl}/api/missing-episodes`, { headers: { cookie } });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      lastScanAt: string | null;
      scanning: boolean;
      progress: { processed: number; total: number } | null;
      mismatchCount: number;
      mismatches: Array<{
        mediaItemId: number;
        title: string;
        tmdbId: number | null;
        embySeriesId: string | null;
        embyTmdbId: number | null;
      }>;
      emby: { webBaseUrl: string; serverId: string | null } | null;
      showCount: number;
      episodeCount: number;
      shows: Array<{
        mediaItemId: number;
        tmdbId: number | null;
        title: string;
        posterUrl: string | null;
        missingCount: number;
        embySeriesId: string | null;
        libraries: Array<{ rootId: string; name: string; episodeCount: number; path: string }>;
        suspectSeasons: Array<{ seasonNumber: number; aired: number; stored: number }>;
        seasons: Array<{
          seasonNumber: number;
          embySeasonId: string | null;
          episodes: Array<{ episodeNumber: number; name: string | null }>;
        }>;
      }>;
    };
    expect(body).toMatchObject({
      scanning: true,
      progress: { processed: 3, total: 10 },
      mismatchCount: 0,
      mismatches: [],
      // 「在 Emby 查看」跳转配置：网页地址（回落 Emby 地址）+ System/Info 的 serverId
      emby: { webBaseUrl: "https://emby.test", serverId: null },
      showCount: 1,
      episodeCount: 1,
    });
    expect(body.lastScanAt).toBe("2026-01-01T00:00:00.000Z");
    expect(body.shows[0]).toMatchObject({
      mediaItemId,
      tmdbId: 202,
      title: "暗黑",
      posterUrl: "https://image.test/dark.jpg",
      missingCount: 1,
      embySeriesId: null,
    });
    expect(body.shows[0]!.suspectSeasons).toEqual([]);
    // 库归属来自本地扫描（Emby 库根 `emby:1` 对外报库 Id `1`）
    expect(body.shows[0]!.libraries).toEqual([
      { rootId: "1", name: "动漫", mediaType: "tv", episodeCount: 1, fileCount: 1, seasons: [1], path: "暗黑" },
    ]);
    // 每季带上 Emby 季条目 Id，页面点击缺集直接跳到那一季
    expect(body.shows[0]!.seasons[0]!.embySeasonId).toBeNull();
    expect(body.shows[0]!.seasons[0]!.episodes).toEqual([{ episodeNumber: 2, name: "谎言", airDate: "2020-01-08" }]);
    const warm = await fetch(`${baseUrl}/api/missing-episodes`, { headers: { cookie } });
    expect((await warm.json()).emby.serverId).toBe("server-1");
  });

  it("returns local snapshots while Emby System/Info remains pending", async () => {
    const systemInfo = vi.fn(() => new Promise<never>(() => {}));
    emby.systemInfo = systemInfo;
    seedShow();
    for (let index = 0; index < 2; index += 1) {
      const response = await fetch(`${baseUrl}/api/missing-episodes`, {
        headers: { cookie },
        signal: AbortSignal.timeout(1_000),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ showCount: 1, emby: { serverId: null } });
    }
    expect(systemInfo).toHaveBeenCalledTimes(1);
  });

  /**
   * 收录条件放宽（2026-09-21）：只差"今日更新"、没有其它缺集的剧也列出来，
   * 但它不计缺集、不计入「共 N 部剧缺 M 集」，排序时沉到最后（它不需要动作）。
   */
  it("lists shows whose only gap is a today-update, without counting them as missing", async () => {
    seedShow();
    const timestamp = "2026-01-01T00:00:00.000Z";
    const todayEntry = {
      mediaItemId: database.db
        .insert(mediaItems)
        .values({
          tmdbId: 303,
          mediaType: "tv" as const,
          title: "斗破苍穹",
          createdAt: timestamp,
          updatedAt: timestamp,
        })
        .returning({ id: mediaItems.id })
        .get()!.id,
    };
    database.db
      .insert(missingEpisodeSnapshots)
      .values({
        mediaItemId: todayEntry.mediaItemId,
        tmdbId: 303,
        title: "斗破苍穹",
        embySeriesId: "series-303",
        embyTmdbId: 303,
        embySeasons: [],
        tmdbSeasons: [
          {
            seasonNumber: 1,
            episodes: [
              { episodeNumber: 1, name: "开端", airDate: "2020-01-01" },
              { episodeNumber: 2, name: "谎言", airDate: "2020-01-08" },
            ],
          },
        ],
        fetchedAt: timestamp,
        missing: [],
        pendingSeasons: [
          { seasonNumber: 5, episodes: [{ episodeNumber: 210, name: "今日更新", airDate: "2026-09-21" }] },
        ],
        unmatchedSeasons: [],
        airedCount: 210,
        storedCount: 209,
        missingCount: 0,
        error: null,
        scannedAt: timestamp,
      })
      .run();

    const today = new Date();
    const airDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    const stored = database.db
      .insert(libraryItems)
      .values({
        mediaRootId: 1,
        mediaItemId: todayEntry.mediaItemId,
        relativePath: "斗破苍穹/Season 5/EP209.strm",
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .returning()
      .get()!;
    database.db
      .insert(libraryEpisodes)
      .values({
        libraryItemId: stored.id,
        parsedSeason: 5,
        episodeNumber: 209,
        numberingMode: "seasonal",
        createdAt: timestamp,
      })
      .run();
    database.db
      .update(missingEpisodeSnapshots)
      .set({
        tmdbSeasons: [
          {
            seasonNumber: 5,
            episodes: [
              { episodeNumber: 209, name: "上一集", airDate: "2020-01-01" },
              { episodeNumber: 210, name: "今日更新", airDate },
            ],
          },
        ],
      })
      .where(eq(missingEpisodeSnapshots.mediaItemId, todayEntry.mediaItemId))
      .run();
    const body = (await (await fetch(`${baseUrl}/api/missing-episodes`, { headers: { cookie } })).json()) as {
      showCount: number;
      pendingShowCount: number;
      episodeCount: number;
      pendingEpisodeCount: number;
      shows: Array<{
        mediaItemId: number;
        title: string;
        missingCount: number;
        pendingCount: number;
        pendingSeasons: Array<{ seasonNumber: number; episodes: Array<{ episodeNumber: number; airDate: string }> }>;
      }>;
    };

    // 缺集口径不变：只有真正缺集的剧算进「共 N 部剧缺 M 集」
    expect(body.showCount).toBe(1);
    expect(body.episodeCount).toBe(1);
    // 今日更新单独计数，且列在清单里
    expect(body.pendingShowCount).toBe(1);
    expect(body.pendingEpisodeCount).toBe(1);
    expect(body.shows.map((show) => show.title)).toEqual(["暗黑", "斗破苍穹"]);
    expect(body.shows[1]).toMatchObject({ missingCount: 0, pendingCount: 1 });
    expect(body.shows[1]!.pendingSeasons).toEqual([
      {
        seasonNumber: 5,
        episodes: [{ episodeNumber: 210, name: "今日更新", airDate }],
        embySeasonId: null,
        embyUrl: `/api/missing-episodes/emby-link?rootId=1&mediaItemId=${todayEntry.mediaItemId}&seasonNumber=5`,
      },
    ]);
  });

  it("does not reuse another root's global TMDB mismatch or parent IDs", async () => {
    seedShow();
    // 被标注为 TMDB 标识不一致的条目：缺集清零、不进清单，只计入 mismatchCount / mismatches。
    database.db
      .update(missingEpisodeSnapshots)
      .set({ missing: [], missingCount: 0, error: "emby_tmdb_mismatch", embyTmdbId: 213608 })
      .run();

    const body = (await (await fetch(`${baseUrl}/api/missing-episodes`, { headers: { cookie } })).json()) as {
      mismatchCount: number;
      mismatches: Array<{
        mediaItemId: number;
        title: string;
        tmdbId: number | null;
        embySeriesId: string | null;
        embyTmdbId: number | null;
      }>;
      showCount: number;
      episodeCount: number;
    };
    expect(body).toMatchObject({ mismatchCount: 0, showCount: 1, episodeCount: 1 });
    expect(body.mismatches).toEqual([]);
  });

  it("deletes through the Emby delete API, cleans local caches and writes an audit row", async () => {
    const { mediaItemId } = seedShow();
    const series: EmbyLibraryItem[] = [
      { id: "series-a", name: "暗黑", year: 2017, type: "tv", tmdbId: 202, genres: [] },
      { id: "series-b", name: "暗黑", year: 2017, type: "tv", tmdbId: 202, genres: [] },
    ];
    emby.listLibraryItems.mockResolvedValue(series);

    const response = await fetch(`${baseUrl}/api/missing-episodes/delete`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ mediaItemIds: [mediaItemId], rootId: "1" }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      deleted: number;
      failed: number;
      results: Array<{ mediaItemId: number; title: string; ok: boolean; embyItemIds: string[]; error?: string }>;
    };
    expect(body).toMatchObject({ deleted: 1, failed: 0 });
    expect(body.results[0]).toMatchObject({
      mediaItemId,
      title: "暗黑",
      ok: true,
      embyItemIds: ["series-a", "series-b"],
    });
    // 必须按 TMDB ProviderId 精确查找，不做标题回退（避免删错剧）
    expect(emby.listLibraryItems).toHaveBeenCalledWith({ libraryId: "1", mediaType: "tv" });
    expect(emby.searchItems).not.toHaveBeenCalled();
    expect(emby.deleteItem).toHaveBeenCalledWith("series-a");
    expect(emby.deleteItem).toHaveBeenCalledWith("series-b");
    // 本地缓存同步清掉：快照、库内条目与分集都不再留着
    expect(database.db.select().from(missingEpisodeSnapshots).all()).toHaveLength(0);
    expect(database.db.select().from(libraryItems).all()).toHaveLength(0);
    expect(database.db.select().from(libraryEpisodes).all()).toHaveLength(0);
    const audits = database.db.select().from(auditLogs).all();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: "missing_episode.deleted",
      targetType: "media_item",
      targetId: mediaItemId,
    });
  });

  it("keeps everything untouched when Emby cannot resolve the series", async () => {
    const { mediaItemId } = seedShow();
    emby.listLibraryItems.mockResolvedValue([]);

    const response = await fetch(`${baseUrl}/api/missing-episodes/delete`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ mediaItemIds: [mediaItemId], rootId: "1" }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { deleted: number; results: Array<{ ok: boolean; error?: string }> };
    expect(body.deleted).toBe(0);
    expect(body.results[0]).toMatchObject({ ok: false, error: "emby_item_not_found" });
    expect(emby.deleteItem).not.toHaveBeenCalled();
    expect(database.db.select().from(missingEpisodeSnapshots).all()).toHaveLength(1);
  });

  it("rejects deletion when Emby is not configured", async () => {
    const { mediaItemId } = seedShow();
    emby.configured = false;

    const response = await fetch(`${baseUrl}/api/missing-episodes/delete`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ mediaItemIds: [mediaItemId], rootId: "1" }),
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "emby_not_configured" });
  });

  it("starts a manual scan once and refuses to queue another while running", async () => {
    const first = await fetch(`${baseUrl}/api/missing-episodes/scan`, { method: "POST", headers: { cookie } });
    expect(first.status).toBe(202);
    expect(await first.json()).toEqual({ started: true, scanning: true });
    expect(scannerRun).toHaveBeenCalledWith("manual");

    scannerRunning = true;
    const second = await fetch(`${baseUrl}/api/missing-episodes/scan`, { method: "POST", headers: { cookie } });
    expect(await second.json()).toEqual({ started: false, scanning: true });
    expect(scannerRun).toHaveBeenCalledTimes(1);
  });

  it("requires an admin session", async () => {
    const response = await fetch(`${baseUrl}/api/missing-episodes`);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
    const link = await fetch(`${baseUrl}/api/missing-episodes/emby-link?rootId=1&mediaItemId=1`);
    expect(link.status).toBe(401);
  });

  it("validates the delete payload", async () => {
    const response = await fetch(`${baseUrl}/api/missing-episodes/delete`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ mediaItemIds: [] }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_request" });
  });
});
