import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDatabase, type DatabaseHandle } from "@emby-task-center/database/client";
import {
  libraryEpisodes,
  libraryItems,
  mediaItems,
  mediaRoots,
  missingEpisodeSnapshots,
} from "@emby-task-center/database/schema";
import type { EmbyClient } from "../integrations/emby-client";
import type { TmdbClient } from "../tmdb/client";
import { computeMissingEpisodes, createMissingEpisodeScanner } from "./missing-episode-scan";
import * as scanContext from "./missing-scan-context";
import { loadMissingScanData } from "./missing-scan-data";

/**
 * 比对基准时刻：2026-09-19 20:00（本地）。
 *
 * 这些用例沿用宽限期 0（`computeMissingEpisodes` 的默认值）= 旧口径"播出日当天即算已播"，
 * 所以这个 Date 与原来那个 "2026-09-19" 字符串的判定结果完全一致；
 * 宽限期本身的行为由文件末尾「今日更新」那组用例覆盖。
 */
const today = new Date(2026, 8, 19, 20, 0, 0);

describe("computeMissingEpisodes", () => {
  it("lists aired episodes that are not in the library and skips unaired ones", () => {
    const result = computeMissingEpisodes(
      [
        {
          seasonNumber: 1,
          episodes: [
            { episodeNumber: 1, name: "第一集", airDate: "2020-01-01" },
            { episodeNumber: 2, name: "第二集", airDate: "2020-02-01" },
            { episodeNumber: 3, name: "还没播", airDate: "2099-01-01" },
          ],
        },
      ],
      new Map([[1, new Set([1])]]),
      today,
    );

    expect(result.missing).toEqual([
      {
        seasonNumber: 1,
        aired: 2,
        stored: 1,
        episodes: [{ episodeNumber: 2, name: "第二集", airDate: "2020-02-01" }],
      },
    ]);
    expect(result).toMatchObject({ airedCount: 2, storedCount: 1, missingCount: 1, unmatched: [] });
  });

  it("matches continuous absolute numbering across seasons instead of reporting the whole season missing", () => {
    const episode = (number: number) => ({ episodeNumber: number, name: `E${number}`, airDate: "2020-01-01" });
    const range = (from: number, to: number) =>
      Array.from({ length: to - from + 1 }, (_, index) => episode(from + index));
    // 库内是 TVDB 风格的连续绝对编号：S1 1–25、S2 26–37、S3 38–49
    const result = computeMissingEpisodes(
      [
        { seasonNumber: 1, episodes: range(1, 25) },
        { seasonNumber: 2, episodes: range(1, 12) },
        { seasonNumber: 3, episodes: range(1, 22) },
      ],
      new Map([
        [1, new Set(range(1, 25).map((item) => item.episodeNumber))],
        [2, new Set(range(26, 37).map((item) => item.episodeNumber))],
        [3, new Set(range(38, 49).map((item) => item.episodeNumber))],
      ]),
      today,
    );

    // S1/S2 全部对上；S3 的绝对位置 38–49 对上，50–59（S3 E13–E22）才是真缺
    expect(result.missingCount).toBe(10);
    expect(result.missing).toHaveLength(1);
    expect(result.missing[0]!.seasonNumber).toBe(3);
    expect(result.missing[0]!.episodes.map((item) => item.episodeNumber)).toEqual([
      13, 14, 15, 16, 17, 18, 19, 20, 21, 22,
    ]);
  });

  it("flags pairing-style numbering as suspect instead of reporting the suffix as missing", () => {
    const episode = (number: number) => ({ episodeNumber: number, name: `E${number}`, airDate: "2020-01-01" });
    // 库内每季 20 集连续前缀，TMDB 一季 41 集（TVDB 半集合并 vs TMDB 分段）
    const result = computeMissingEpisodes(
      [
        {
          seasonNumber: 1,
          episodes: Array.from({ length: 41 }, (_, index) => episode(index + 1)),
        },
      ],
      new Map([[1, new Set(Array.from({ length: 20 }, (_, index) => index + 1))]]),
      today,
    );

    expect(result.missingCount).toBe(0);
    expect(result.missing).toEqual([]);
    expect(result.suspects).toEqual([{ seasonNumber: 1, aired: 41, stored: 20 }]);
  });

  it("flags the remaining suffix season when a show already has several suspect seasons", () => {
    const episode = (number: number) => ({ episodeNumber: number, name: `E${number}`, airDate: "2020-01-01" });
    const season = (seasonNumber: number, count: number) => ({
      seasonNumber,
      episodes: Array.from({ length: count }, (_, index) => episode(index + 1)),
    });
    const prefix = (count: number) => new Set(Array.from({ length: count }, (_, index) => index + 1));
    // 前三季是强疑似（缺失占比高）；第四季缺失占比只有 0.26，但同剧已有 ≥3 个疑似季 → 一并列疑似
    const result = computeMissingEpisodes(
      [season(1, 41), season(2, 36), season(3, 40), season(4, 35)],
      new Map([
        [1, prefix(20)],
        [2, prefix(20)],
        [3, prefix(20)],
        [4, prefix(26)],
      ]),
      today,
    );

    expect(result.missingCount).toBe(0);
    expect(result.suspects).toEqual([
      { seasonNumber: 1, aired: 41, stored: 20 },
      { seasonNumber: 2, aired: 36, stored: 20 },
      { seasonNumber: 3, aired: 40, stored: 20 },
      { seasonNumber: 4, aired: 35, stored: 26 },
    ]);
  });

  it("keeps genuine suffix gaps when the missing tail is small", () => {
    const episode = (number: number) => ({ episodeNumber: number, name: `E${number}`, airDate: "2020-01-01" });
    // 库内 1–191 连续，TMDB 已播 192：只缺 E192，不能当"编号体系不一致"吞掉
    const result = computeMissingEpisodes(
      [{ seasonNumber: 1, episodes: Array.from({ length: 192 }, (_, index) => episode(index + 1)) }],
      new Map([[1, new Set(Array.from({ length: 191 }, (_, index) => index + 1))]]),
      today,
    );

    expect(result.missingCount).toBe(1);
    expect(result.suspects).toEqual([]);
  });

  it("normalizes TMDB's continuous episode numbering to per-season numbers (侠岚 style)", () => {
    const episode = (number: number) => ({ episodeNumber: number, name: `E${number}`, airDate: "2020-01-01" });
    const season = (seasonNumber: number, from: number, count: number) => ({
      seasonNumber,
      episodes: Array.from({ length: count }, (_, index) => episode(from + index)),
    });
    const range = (from: number, to: number) =>
      new Set(Array.from({ length: to - from + 1 }, (_, index) => from + index));
    // TMDB：S1 1–26、S2 27–52、S3 53–78；库内（TVDB）每季从 1 编号——数字不同但内容一一对应。
    const result = computeMissingEpisodes(
      [season(1, 1, 26), season(2, 27, 26), season(3, 53, 26)],
      new Map([
        [1, range(1, 26)],
        [2, range(1, 26)],
        [3, range(1, 26)],
      ]),
      today,
    );

    expect(result.missingCount).toBe(0);
    expect(result.suspects).toEqual([]);
    expect(result.airedCount).toBe(78);
  });

  it("treats episodes as present when only the original TMDB numbers exist in the library", () => {
    const episode = (number: number) => ({ episodeNumber: number, name: `E${number}`, airDate: "2020-01-01" });
    const season = (seasonNumber: number, from: number, count: number) => ({
      seasonNumber,
      episodes: Array.from({ length: count }, (_, index) => episode(from + index)),
    });
    const range = (from: number, to: number) =>
      new Set(Array.from({ length: to - from + 1 }, (_, index) => from + index));
    // 库内只存了绝对编号那一套（S3 = 53–78，没有 1–26 的相对编号）→ 也不能算缺
    const result = computeMissingEpisodes(
      [season(1, 1, 26), season(2, 27, 26), season(3, 53, 26)],
      new Map([
        [1, range(1, 26)],
        [2, range(1, 26)],
        [3, range(53, 78)],
      ]),
      today,
    );

    expect(result.missingCount).toBe(0);
  });

  it("reports the normalized per-season number for a genuinely missing episode", () => {
    const episode = (number: number) => ({ episodeNumber: number, name: `E${number}`, airDate: "2020-01-01" });
    const season = (seasonNumber: number, from: number, count: number) => ({
      seasonNumber,
      episodes: Array.from({ length: count }, (_, index) => episode(from + index)),
    });
    const range = (from: number, to: number) =>
      new Set(Array.from({ length: to - from + 1 }, (_, index) => from + index));
    // TMDB S3 是 53–78；库内 S3 按每季 1–25 存放，缺"相对第 10 集"（TMDB 原编号 62）。
    const result = computeMissingEpisodes(
      [season(1, 1, 26), season(2, 27, 26), season(3, 53, 26)],
      new Map([
        [1, range(1, 26)],
        [2, range(1, 26)],
        [3, new Set(Array.from({ length: 26 }, (_, index) => index + 1).filter((number) => number !== 10))],
      ]),
      today,
    );

    expect(result.missingCount).toBe(1);
    expect(result.missing[0]).toMatchObject({ seasonNumber: 3, aired: 26, stored: 25 });
    // 显示的是相对集号（和 Emby 里看到的一致），集名仍是 TMDB 的
    expect(result.missing[0]!.episodes[0]).toMatchObject({ episodeNumber: 10, name: "E62" });
  });

  it("compares seasons that exist locally and marks the rest as unmatched instead of inventing gaps", () => {
    // TMDB 有 S1+S2，库内只有 S1：S2 没有对应季号记录 → 列未比对，不臆造整季缺集。
    const unmatchedSeason = computeMissingEpisodes(
      [
        { seasonNumber: 1, episodes: [{ episodeNumber: 1, name: null, airDate: "2020-01-01" }] },
        { seasonNumber: 2, episodes: [{ episodeNumber: 1, name: null, airDate: "2020-02-01" }] },
      ],
      new Map([[1, new Set([1])]]),
      today,
    );
    expect(unmatchedSeason.missing).toEqual([]);
    expect(unmatchedSeason.unmatched).toEqual([{ seasonNumber: 2, airedEpisodes: 1 }]);

    // 斗破式季号错位：库内只有 S5，TMDB S1 与 S5 都有 → S1 列未比对，S5 正常逐集比对。
    const yearSplit = computeMissingEpisodes(
      [
        { seasonNumber: 1, episodes: [{ episodeNumber: 1, name: null, airDate: "2020-01-01" }] },
        {
          seasonNumber: 5,
          episodes: [
            { episodeNumber: 1, name: "第 1 集", airDate: "2020-01-01" },
            { episodeNumber: 2, name: "第 2 集", airDate: "2020-02-01" },
          ],
        },
      ],
      new Map([[5, new Set([1])]]),
      today,
    );
    expect(yearSplit.missing).toEqual([
      {
        seasonNumber: 5,
        aired: 2,
        stored: 1,
        episodes: [{ episodeNumber: 2, name: "第 2 集", airDate: "2020-02-01" }],
      },
    ]);
    expect(yearSplit.unmatched).toEqual([{ seasonNumber: 1, airedEpisodes: 1 }]);
  });
});

/**
 * 「今日更新」（入库宽限期）：当天播出的集不算缺集。
 *
 * 场景来自真实反馈：剧集当天 18 点更新、片源 20 点才入库，早上 8 点打开任务中心时，
 * 旧口径（air_date <= 今天）已经让这一集变成"缺集"了。
 */
describe("computeMissingEpisodes 今日更新（宽限期）", () => {
  const seasons = [
    {
      seasonNumber: 1,
      episodes: [
        { episodeNumber: 1, name: "上一集", airDate: "2026-09-12" },
        { episodeNumber: 2, name: "今日更新", airDate: "2026-09-19" },
      ],
    },
  ];
  const morning = new Date(2026, 8, 19, 8, 0, 0);
  const nextDay = new Date(2026, 8, 20, 0, 30, 0);
  const storedFirstOnly = new Map([[1, new Set([1])]]);

  it("早上 8 点：当天播出的集只进 pending，不算缺集", () => {
    const result = computeMissingEpisodes(seasons, storedFirstOnly, morning, 24);

    expect(result.missing).toEqual([]);
    expect(result.pending).toEqual([
      { seasonNumber: 1, episodes: [{ episodeNumber: 2, name: "今日更新", airDate: "2026-09-19" }] },
    ]);
    // 已播 = 已存 + 缺集 + 今日更新：页面上的三个数字要自洽
    expect(result).toMatchObject({ airedCount: 2, storedCount: 1, missingCount: 0, pendingCount: 1 });
  });

  it("次日 0 点后同一集落到缺集里：不会因为宽限期漏报", () => {
    const result = computeMissingEpisodes(seasons, storedFirstOnly, nextDay, 24);

    expect(result.pending).toEqual([]);
    expect(result.missing).toEqual([
      {
        seasonNumber: 1,
        aired: 2,
        stored: 1,
        episodes: [{ episodeNumber: 2, name: "今日更新", airDate: "2026-09-19" }],
      },
    ]);
    expect(result).toMatchObject({ airedCount: 2, storedCount: 1, missingCount: 1, pendingCount: 0 });
  });

  it("宽限期设 0 时回到旧口径（当天播出即算缺集）", () => {
    const result = computeMissingEpisodes(seasons, storedFirstOnly, morning, 0);

    expect(result.pending).toEqual([]);
    expect(result.missingCount).toBe(1);
  });

  it("当天那一集已经入库时不再提示待入库", () => {
    const result = computeMissingEpisodes(seasons, new Map([[1, new Set([1, 2])]]), morning, 24);

    expect(result.pending).toEqual([]);
    expect(result.missing).toEqual([]);
    expect(result).toMatchObject({ airedCount: 2, storedCount: 2, missingCount: 0, pendingCount: 0 });
  });

  it("当天首播整季：整季都算待入库，不报缺集", () => {
    const premiere = [
      {
        seasonNumber: 1,
        episodes: [
          { episodeNumber: 1, name: "第 1 集", airDate: "2026-09-19" },
          { episodeNumber: 2, name: "第 2 集", airDate: "2026-09-19" },
        ],
      },
    ];
    const result = computeMissingEpisodes(premiere, new Map(), morning, 24);

    expect(result.missing).toEqual([]);
    expect(result.pending[0]?.episodes).toHaveLength(2);
    expect(result).toMatchObject({ missingCount: 0, pendingCount: 2 });
  });
});

function tmdbStub(overrides: Partial<TmdbClient> = {}): TmdbClient {
  return {
    search: vi.fn().mockResolvedValue([]),
    details: vi.fn().mockResolvedValue({
      id: 100,
      mediaType: "tv",
      title: "测试剧",
      originalTitle: "测试剧",
      releaseYear: 2020,
      overview: "",
      posterUrl: null,
      backdropUrl: null,
      seasons: [{ seasonNumber: 1, name: "第 1 季", episodeCount: 2, airDate: "2020-01-01" }],
    }),
    seasonProgress: vi.fn().mockResolvedValue({
      seasonNumber: 1,
      airedEpisodes: 2,
      totalEpisodes: 2,
      lastAirDate: "2020-02-01",
      nextAirDate: null,
    }),
    seasonEpisodes: vi.fn().mockImplementation(async (_tvId: number, seasonNumber: number) =>
      seasonNumber === 1
        ? [
            { episodeNumber: 1, name: "第一集", airDate: "2020-01-01" },
            { episodeNumber: 2, name: "第二集", airDate: "2020-02-01" },
          ]
        : [],
    ),
    airedEpisodeCount: vi.fn().mockResolvedValue(2),
    ...overrides,
  };
}

describe("createMissingEpisodeScanner", () => {
  let directory: string;
  let database: DatabaseHandle;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "emby-missing-"));
    database = createDatabase(join(directory, "scan.sqlite"));
  });

  afterEach(() => {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });

  function seedLibrary(): number {
    const timestamp = "2026-01-01T00:00:00.000Z";
    const root = database.db
      .insert(mediaRoots)
      .values({ name: "动漫", mediaType: "tv", containerPath: "emby:1", createdAt: timestamp, updatedAt: timestamp })
      .returning()
      .get()!;
    const media = database.db
      .insert(mediaItems)
      .values({ tmdbId: 100, mediaType: "tv", title: "测试剧", createdAt: timestamp, updatedAt: timestamp })
      .returning()
      .get()!;
    const item = database.db
      .insert(libraryItems)
      .values({
        mediaRootId: root.id,
        mediaItemId: media.id,
        relativePath: "测试剧/Season 1/EP01 [e1].strm",
        embyItemId: "e1",
        sourceTitle: "测试剧",
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
    return media.id;
  }

  it("writes a missing-episode snapshot and reuses the TMDB cache on the next run", async () => {
    seedLibrary();
    const tmdb = tmdbStub();
    const emby = {
      configured: true,
      searchItems: vi
        .fn()
        .mockResolvedValue([{ id: "series-1", name: "测试剧", year: 2020, type: "tv", tmdbId: 100, genres: [] }]),
      listSeasons: vi.fn().mockResolvedValue([{ id: "season-1", seasonNumber: 1, name: "第 1 季" }]),
    } as unknown as EmbyClient;
    const scanner = createMissingEpisodeScanner({ database: database.db, tmdb, emby });

    await scanner.run("manual");

    const row = database.db.select().from(missingEpisodeSnapshots).get()!;
    expect(row).toMatchObject({
      mediaItemId: 1,
      tmdbId: 100,
      title: "测试剧",
      missingCount: 1,
      airedCount: 2,
      storedCount: 1,
      // Emby 跳转用的条目 Id 与实际 TMDB 标识（「在 Emby 查看」按季跳转）
      embySeriesId: "series-1",
      embyTmdbId: 100,
      embySeasons: [{ seasonNumber: 1, id: "season-1" }],
    });
    expect(row.missing).toEqual([
      {
        seasonNumber: 1,
        aired: 2,
        stored: 1,
        episodes: [{ episodeNumber: 2, name: "第二集", airDate: "2020-02-01" }],
      },
    ]);
    // 有缺集的条目要用 Emby 精确校验 TMDB 标识
    expect(emby.searchItems).toHaveBeenCalledWith({ tmdbId: 100, mediaType: "tv" });
    expect(tmdb.details).toHaveBeenCalledTimes(1);
    expect(tmdb.seasonEpisodes).toHaveBeenCalledTimes(1);
    expect(scanner.status()).toMatchObject({
      running: false,
      total: 1,
      processed: 1,
      missingShows: 1,
      missingEpisodes: 1,
    });

    // 第二轮：TMDB 缓存期内只用本地数据重算，不再打 TMDB。
    await scanner.run("manual");
    expect(tmdb.details).toHaveBeenCalledTimes(1);
    expect(tmdb.seasonEpisodes).toHaveBeenCalledTimes(1);
  });

  it("excludes rows whose Emby series does not carry the media item's TMDB id", async () => {
    seedLibrary();
    const emby = {
      configured: true,
      searchItems: vi.fn().mockResolvedValue([]),
    } as unknown as EmbyClient;
    const scanner = createMissingEpisodeScanner({ database: database.db, tmdb: tmdbStub(), emby });

    await scanner.run("manual");

    const row = database.db.select().from(missingEpisodeSnapshots).get()!;
    expect(row).toMatchObject({
      missingCount: 0,
      error: "emby_tmdb_mismatch",
      embySeriesId: null,
      embyTmdbId: null,
    });
    expect(row.missing).toEqual([]);
    expect(scanner.status().mismatches).toBe(1);
  });

  it("records the Emby entry's actual TMDB id when the ids differ", async () => {
    seedLibrary();
    const searchItems = vi.fn().mockImplementation(async (query: { tmdbId?: number; title?: string }) => {
      if (query.tmdbId != null) return [];
      return [{ id: "series-9", name: "测试剧", year: 2020, type: "tv", tmdbId: 999, genres: [] }];
    });
    const emby = { configured: true, searchItems } as unknown as EmbyClient;
    const scanner = createMissingEpisodeScanner({ database: database.db, tmdb: tmdbStub(), emby });

    await scanner.run("manual");

    const row = database.db.select().from(missingEpisodeSnapshots).get()!;
    // 库里同名条目的实际 TMDB id（999）与本地记录的 100 不一致：单独记下来给页面展示
    expect(row).toMatchObject({
      missingCount: 0,
      error: "emby_tmdb_mismatch",
      embySeriesId: "series-9",
      embyTmdbId: 999,
    });
    expect(searchItems).toHaveBeenCalledWith({ title: "测试剧", mediaType: "tv" });
  });

  it("downgrades a season to suspect when the missing episodes' names already exist in Emby", async () => {
    seedLibrary();
    const tmdb = tmdbStub({
      seasonEpisodes: vi.fn().mockResolvedValue([
        { episodeNumber: 1, name: "一触即发", airDate: "2020-01-01" },
        { episodeNumber: 2, name: "炁门之争", airDate: "2020-02-01" },
        { episodeNumber: 3, name: "心境陷阱", airDate: "2020-03-01" },
      ]),
    });
    const emby = {
      configured: true,
      searchItems: vi
        .fn()
        .mockResolvedValue([{ id: "series-1", name: "测试剧", year: 2020, type: "tv", tmdbId: 100, genres: [] }]),
      // 库内没有 2/3 号，但这两集的名字分别挂在编号 9/10 上 → 编号体系不同，不是真缺
      listItemEpisodes: vi.fn().mockResolvedValue([
        { id: "e1", seasonNumber: 1, episodeNumber: 1, name: "一触即发" },
        { id: "e9", seasonNumber: 1, episodeNumber: 9, name: "炁门之争" },
        { id: "e10", seasonNumber: 1, episodeNumber: 10, name: "心境陷阱" },
      ]),
    } as unknown as EmbyClient;
    const scanner = createMissingEpisodeScanner({ database: database.db, tmdb, emby });

    await scanner.run("manual");

    const row = database.db.select().from(missingEpisodeSnapshots).get()!;
    expect(row.missingCount).toBe(0);
    expect(row.missing).toEqual([]);
    expect(row.suspectSeasons).toEqual([{ seasonNumber: 1, aired: 3, stored: 1 }]);
  });

  it("does not let generic episode names hide a real gap", async () => {
    seedLibrary();
    const tmdb = tmdbStub({
      seasonEpisodes: vi.fn().mockResolvedValue([
        { episodeNumber: 1, name: "第一集", airDate: "2020-01-01" },
        { episodeNumber: 2, name: "第二集", airDate: "2020-02-01" },
      ]),
    });
    const emby = {
      configured: true,
      searchItems: vi
        .fn()
        .mockResolvedValue([{ id: "series-1", name: "测试剧", year: 2020, type: "tv", tmdbId: 100, genres: [] }]),
      listItemEpisodes: vi.fn().mockResolvedValue([
        { id: "e1", seasonNumber: 1, episodeNumber: 1, name: "第一集" },
        { id: "e9", seasonNumber: 1, episodeNumber: 9, name: "第二集" },
      ]),
    } as unknown as EmbyClient;
    const scanner = createMissingEpisodeScanner({ database: database.db, tmdb, emby });

    await scanner.run("manual");

    const row = database.db.select().from(missingEpisodeSnapshots).get()!;
    // 占位名不参与兜底：E2 仍然是缺集
    expect(row.missingCount).toBe(1);
    expect(row.suspectSeasons).toEqual([]);
  });

  it("drops snapshots for series that are no longer in the library", async () => {
    seedLibrary();
    const scanner = createMissingEpisodeScanner({ database: database.db, tmdb: tmdbStub() });
    await scanner.run("manual");
    expect(database.db.select().from(missingEpisodeSnapshots).all()).toHaveLength(1);

    database.db.delete(libraryEpisodes).run();
    database.db.delete(libraryItems).run();
    await scanner.run("manual");

    expect(database.db.select().from(missingEpisodeSnapshots).all()).toHaveLength(0);
  });

  it("keeps the run exclusive until in-flight TMDB finishes after a context read fails", async () => {
    const id = seedLibrary();
    const baselineScanner = createMissingEpisodeScanner({ database: database.db, tmdb: tmdbStub() });
    await baselineScanner.run("manual");
    const data = loadMissingScanData(database.db);
    let failRead!: (error: Error) => void;
    const blockedRead = new Promise<ReturnType<typeof data.read>>((_, reject) => {
      failRead = reject;
    });
    let finishDetails!: (value: Awaited<ReturnType<TmdbClient["details"]>>) => void;
    const blockedDetails = new Promise<Awaited<ReturnType<TmdbClient["details"]>>>((resolve) => {
      finishDetails = resolve;
    });
    const tmdb = tmdbStub({ details: vi.fn(() => blockedDetails) });
    const close = vi.fn(async () => {});
    // Force fresh metadata for this run without changing the prior display snapshot's presence.
    const loaded = data.read(id);
    const stale = { ...loaded, previous: { ...loaded.previous!, fetchedAt: "2000-01-01" } };
    const create = vi.spyOn(scanContext, "createMissingScanContext").mockResolvedValue({
      candidates: [data.candidates[0]!, { id: 999, tmdbId: 999, title: "unreadable" }],
      read: (itemId) => (itemId === id ? Promise.resolve(stale) : blockedRead),
      close,
    });
    try {
      const scanner = createMissingEpisodeScanner({ database: database.db, tmdb });
      const run = scanner.run("manual");
      await vi.waitFor(() => expect(tmdb.details).toHaveBeenCalledOnce());
      failRead(new Error("fixture_context_read_failed"));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(scanner.status().running).toBe(true);
      await scanner.run("interval");
      expect(create).toHaveBeenCalledOnce();
      expect(close).not.toHaveBeenCalled();
      finishDetails(await tmdbStub().details("tv", 100));
      await run;
      expect(scanner.status()).toMatchObject({ running: false, error: "fixture_context_read_failed" });
      expect(close).toHaveBeenCalledOnce();
      expect(database.db.select().from(missingEpisodeSnapshots).all()).toHaveLength(1);
    } finally {
      create.mockRestore();
    }
  });

  it("keeps old data instead of faking a complete library when TMDB is down", async () => {
    seedLibrary();
    const scanner = createMissingEpisodeScanner({
      database: database.db,
      tmdb: tmdbStub({ details: vi.fn().mockRejectedValue(new Error("tmdb down")) }),
    });

    await scanner.run("manual");

    expect(scanner.status().failed).toBe(1);
    expect(database.db.select().from(missingEpisodeSnapshots).all()).toHaveLength(0);
  });

  it("把当天播出的集记成 pending 而不是缺集（8 点看到的假缺集）", async () => {
    seedLibrary();
    const now = new Date();
    const iso = (date: Date) =>
      `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    const todayIso = iso(now);
    const lastWeekIso = iso(new Date(now.getTime() - 7 * 24 * 3_600_000));
    const scanner = createMissingEpisodeScanner({
      database: database.db,
      tmdb: tmdbStub({
        seasonEpisodes: vi.fn().mockResolvedValue([
          { episodeNumber: 1, name: "第一集", airDate: lastWeekIso },
          { episodeNumber: 2, name: "今日更新", airDate: todayIso },
        ]),
      }),
    });

    await scanner.run("manual");

    const row = database.db.select().from(missingEpisodeSnapshots).get()!;
    // 当天 18 点更新、20 点才入库：早上跑扫描时这一集不该出现在缺集清单里
    expect(row.missing).toEqual([]);
    expect(row.missingCount).toBe(0);
    expect(row.pendingSeasons).toEqual([
      { seasonNumber: 1, episodes: [{ episodeNumber: 2, name: "今日更新", airDate: todayIso }] },
    ]);
    // 已播口径不变（2 集），已存 1 集：差额正好是"今日更新待入库"的 1 集
    expect(row).toMatchObject({ airedCount: 2, storedCount: 1 });
    expect(scanner.status()).toMatchObject({ missingEpisodes: 0, pendingShows: 1, pendingEpisodes: 1 });
  });
});
