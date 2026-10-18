import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import BetterSqlite3 from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";

import { createDatabase, type AppDatabase, type DatabaseHandle } from "@emby-task-center/database/client";
import { migrate } from "@emby-task-center/database/migrate";
import { schema } from "@emby-task-center/database/schema";
import {
  libraryEpisodes,
  libraryItems,
  libraryScanRuns,
  mediaItems,
  mediaRoots,
} from "@emby-task-center/database/schema";
import {
  createTaskWithOutcome,
  getTask,
  setTaskFolderMapping,
  updateTaskAirProgress,
} from "@emby-task-center/task-domain/task-service";
import {
  classifyItemMediaType,
  createLibraryService,
  matchInventoryToMediaItem,
  type LibraryRootConfig,
} from "./service";
import type { ScannedMediaItem } from "./scan-types";

describe("persistent library service", () => {
  let directory: string;
  let handle: DatabaseHandle;

  afterEach(() => {
    handle?.close();
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  it("persists matched TV inventory and restores progress after service recreation", async () => {
    ({ directory, handle } = createTestDatabase());
    const task = createTaskWithOutcome(
      handle.db,
      {
        mediaType: "tv",
        tmdbId: 70523,
        taskType: "ingest",
        title: "Dark",
      },
      canonical(2017),
    ).task;
    updateTaskAirProgress(handle.db, task.id, 3, new Date("2026-08-11T00:00:00Z"));
    const roots = [{ id: "tv", name: "电视剧", mediaType: "tv" as const, path: "tv-root" }];
    const scan = async () => [episode("Dark (2017)/Season 01/Dark.S01E01-E02.strm", [1, 2])];
    const library = createLibraryService(roots, scan, handle.db);

    await library.scanRoot("tv");

    expect(library.getInventory("tv")?.items[0]).toMatchObject({
      sourceTitle: "Dark",
      sourceYear: 2017,
      mediaItemId: 1,
      recognitionStatus: "matched",
      identity: { episodeNumbers: [1, 2] },
    });
    expect(getTask(handle.db, task.id)).toMatchObject({
      storedProgress: 2,
      libraryMatched: true,
      missingEpisodes: [3],
      lastCheckedAt: expect.any(String),
    });
    expect(createLibraryService(roots, async () => [], handle.db).getInventory("tv")?.items).toHaveLength(1);
    expect(handle.db.select().from(libraryScanRuns).all()).toHaveLength(1);
  });

  it("marks movies as stored and refuses a title match when years conflict", async () => {
    ({ directory, handle } = createTestDatabase());
    const task = createTaskWithOutcome(
      handle.db,
      {
        mediaType: "movie",
        tmdbId: 329865,
        taskType: "ingest",
        title: "Arrival",
      },
      canonical(2016),
    ).task;
    const roots = [{ id: "movies", name: "电影", mediaType: "movie" as const, path: "movies-root" }];
    const library = createLibraryService(roots, async () => [episode("Arrival (2017)/Arrival.strm", [])], handle.db);

    await library.scanRoot("movies");

    expect(handle.db.select().from(libraryItems).get()).toMatchObject({
      recognitionStatus: "unresolved",
      mediaItemId: null,
    });
    expect(getTask(handle.db, task.id)).toMatchObject({ storedProgress: 0, lastCheckedAt: expect.any(String) });
  });

  it("persists poster sidecar paths and resolves them safely within the root", async () => {
    ({ directory, handle } = createTestDatabase());
    const roots = [{ id: "movies", name: "电影", mediaType: "mixed" as const, path: "movies-root" }];
    const library = createLibraryService(
      roots,
      async () => [
        {
          relativePath: "电影-经典-123/Arrival (2016)/Arrival (2016).strm",
          posterPath: "电影-经典-123/Arrival (2016)/poster.jpg",
          identity: episode("unused", []).identity,
        },
      ],
      handle.db,
    );

    await library.scanRoot("movies");

    const item = library.getInventory("movies")!.items[0]!;
    // 扫描器给什么就存什么：Emby 驱动时是 `emby:<条目Id>` 引用
    expect(item.posterPath).toBe("电影-经典-123/Arrival (2016)/poster.jpg");
  });

  it("matches existing inventory immediately via a newly added alias", async () => {
    ({ directory, handle } = createTestDatabase());
    const roots = [{ id: "mix", name: "混合", mediaType: "mixed" as const, path: "mix-root" }];
    const library = createLibraryService(
      roots,
      async () => [
        {
          relativePath: "更新-动漫-123/斗破苍弯年番/Season 01/斗破苍弯年番 S01E01.strm",
          identity: episode("unused", [1]).identity,
        },
      ],
      handle.db,
    );
    await library.scanRoot("mix");

    const outcome = createTaskWithOutcome(
      handle.db,
      {
        mediaType: "tv",
        tmdbId: 999,
        taskType: "ingest",
        title: "斗破苍穹年番第五季",
      },
      canonical(2025),
    ).task;
    const before = handle.db.select().from(mediaItems).where(eq(mediaItems.tmdbId, 999)).get()!;
    handle.db
      .update(mediaItems)
      .set({ aliases: ["斗破苍弯年番"] })
      .where(eq(mediaItems.id, before.id))
      .run();
    const media = handle.db.select().from(mediaItems).where(eq(mediaItems.id, before.id)).get()!;

    const matched = matchInventoryToMediaItem(handle.db, media);

    expect(matched).toBe(1);
    expect(getTask(handle.db, outcome.id)).toMatchObject({ storedProgress: 1, libraryMatched: true });
  });

  it("matches a movie task to TV sources through an explicit alias", async () => {
    ({ directory, handle } = createTestDatabase());
    const roots = [{ id: "mix", name: "混合", mediaType: "mixed" as const, path: "mix-root" }];
    const library = createLibraryService(
      roots,
      async () => [
        {
          relativePath: "更新-动漫-123/斗破苍穹：年番 (2022)/Season 01/斗破苍穹：年番 S01E01.strm",
          identity: episode("unused", [1]).identity,
        },
      ],
      handle.db,
    );
    await library.scanRoot("mix");

    const outcome = createTaskWithOutcome(
      handle.db,
      {
        mediaType: "movie",
        tmdbId: 888,
        taskType: "ingest",
        title: "斗破苍穹年番 第五季",
      },
      canonical(2022),
    ).task;
    const before = handle.db.select().from(mediaItems).where(eq(mediaItems.tmdbId, 888)).get()!;
    handle.db
      .update(mediaItems)
      .set({ aliases: ["斗破苍穹：年番"] })
      .where(eq(mediaItems.id, before.id))
      .run();
    const media = handle.db.select().from(mediaItems).where(eq(mediaItems.id, before.id)).get()!;

    const matched = matchInventoryToMediaItem(handle.db, media);
    expect(matched).toBe(1);
    expect(getTask(handle.db, outcome.id)).toMatchObject({ storedProgress: 1, libraryMatched: true });

    // 扫描路径同样保留该跨类型别名匹配
    await library.scanRoot("mix");
    expect(library.getInventory("mix")!.items[0]?.recognitionStatus).toBe("matched");
  });

  it("calculates missing episodes across every matched file", async () => {
    ({ directory, handle } = createTestDatabase());
    createTaskWithOutcome(
      handle.db,
      {
        mediaType: "tv",
        tmdbId: 70523,
        taskType: "ingest",
        title: "Dark",
      },
      canonical(2017),
    );
    const roots = [{ id: "tv", name: "TV", mediaType: "tv" as const, path: "tv-root" }];
    const library = createLibraryService(
      roots,
      async () => [
        episode("Dark (2017)/Season 01/Dark.S01E01.strm", [1]),
        episode("Dark (2017)/Season 01/Dark.S01E02.strm", [2]),
        episode("Dark (2017)/Season 01/Dark.S01E03.strm", [3]),
        {
          ...episode("Dark (2017)/Season 02/Dark.S02E01.strm", [1]),
          identity: {
            ...episode("unused", [1]).identity,
            physicalSeason: 2,
            parsedSeason: 2,
          },
        },
      ],
      handle.db,
    );

    await library.scanRoot("tv");
    const selected = library.getInventory("tv")!.items.find((item) => item.relativePath.includes("S01E01"))!;

    expect(library.getMissingEpisodes("tv", selected.id, "seasonal", [1, 2, 3, 4, 5])).toEqual([4, 5]);
  });

  it("matches movies and TV from a mixed root and uses classification folder names", async () => {
    ({ directory, handle } = createTestDatabase());
    const movieTask = createTaskWithOutcome(
      handle.db,
      {
        mediaType: "movie",
        tmdbId: 329865,
        taskType: "ingest",
        title: "Arrival",
      },
      canonical(2016),
    ).task;
    const tvTask = createTaskWithOutcome(
      handle.db,
      {
        mediaType: "tv",
        tmdbId: 70523,
        taskType: "ingest",
        title: "Dark",
      },
      canonical(2017),
    ).task;
    const folderTvTask = createTaskWithOutcome(
      handle.db,
      {
        mediaType: "tv",
        tmdbId: 777,
        taskType: "ingest",
        title: "SomeShow",
      },
      canonical(2020),
    ).task;
    updateTaskAirProgress(handle.db, tvTask.id, 3, new Date("2026-08-11T00:00:00Z"));
    updateTaskAirProgress(handle.db, folderTvTask.id, 1, new Date("2026-08-11T00:00:00Z"));
    const roots = [{ id: "all", name: "混合目录", mediaType: "mixed" as const, path: "mixed-root" }];
    const library = createLibraryService(
      roots,
      async () => [
        episode("电影-经典-123/Arrival (2016)/Arrival.strm", []),
        episode("更新-电视剧-123/Dark (2017)/Season 01/Dark.S01E01-E02.strm", [1, 2]),
        // 无集号文件名，但分类文件夹名含“更新/电视剧” => 判为剧集
        episode("更新-电视剧-123/SomeShow (2020)/SomeShow.1080p.strm", []),
      ],
      handle.db,
    );

    await library.scanRoot("all");

    const items = library.getInventory("all")!.items;
    expect(items.find((item) => item.sourceTitle === "Arrival")).toMatchObject({ recognitionStatus: "matched" });
    expect(items.find((item) => item.sourceTitle === "Dark")).toMatchObject({ recognitionStatus: "matched" });
    expect(items.find((item) => item.sourceTitle === "SomeShow")).toMatchObject({ recognitionStatus: "matched" });
    expect(items.find((item) => item.sourceTitle === "Arrival")?.identity.numberingMode).toBe("unresolved");
    expect(items.find((item) => item.sourceTitle === "SomeShow")?.identity.numberingMode).toBe("unresolved");
    expect(getTask(handle.db, movieTask.id)).toMatchObject({ storedProgress: 1, libraryMatched: true });
    expect(getTask(handle.db, tvTask.id)).toMatchObject({
      storedProgress: 2,
      libraryMatched: true,
      missingEpisodes: [3],
    });
    // 文件夹名判定为剧集但文件名无集号：能匹配到任务，但无法计入具体已存集数。
    expect(getTask(handle.db, folderTvTask.id)).toMatchObject({ storedProgress: 0, libraryMatched: true });
  });
  it("updates a persisted root when its path changes under the same name", async () => {
    ({ directory, handle } = createTestDatabase());
    const first = createLibraryService(
      [{ id: "strm", name: "STRM", mediaType: "mixed" as const, path: "old-path" }],
      async () => [],
      handle.db,
    );
    expect(first.listRoots()[0]).toMatchObject({ id: "strm", name: "STRM" });

    // Recreate with the same name but a different path: must update, not crash
    // on the unique name constraint.
    expect(() =>
      createLibraryService(
        [{ id: "strm", name: "STRM", mediaType: "mixed" as const, path: "new-path" }],
        async () => [],
        handle.db,
      ),
    ).not.toThrow();
    const roots = handle.db.select().from(mediaRoots).all();
    expect(roots).toHaveLength(1);
    expect(roots[0]).toMatchObject({ name: "STRM", containerPath: "new-path" });
  });

  it("mapped source mode only counts the mapped folder, ignoring auto-matched files", async () => {
    ({ directory, handle } = createTestDatabase());
    const task = createTaskWithOutcome(
      handle.db,
      {
        mediaType: "tv",
        tmdbId: 70523,
        taskType: "ingest",
        title: "Dark",
      },
      canonical(2017),
    ).task;
    const roots = [{ id: "tv", name: "电视剧", mediaType: "tv" as const, path: "tv-root" }];
    const library = createLibraryService(
      roots,
      async () => [
        episode("Dark (2017)/Season 01/Dark.S01E01-E02.strm", [1, 2]),
        {
          ...episode("Dark (2017)/Season 02/Dark.S02E01.strm", [1]),
          identity: {
            ...episode("unused", [1]).identity,
            physicalSeason: 2,
            parsedSeason: 2,
          },
        },
      ],
      handle.db,
    );
    await library.scanRoot("tv");
    expect(getTask(handle.db, task.id)).toMatchObject({ storedProgress: 3, sourceMode: "auto" });

    setTaskFolderMapping(handle.db, task.id, "tv", "Dark (2017)/Season 01", 2, "mapped");
    expect(getTask(handle.db, task.id)).toMatchObject({ storedProgress: 2, sourceMode: "mapped" });

    // 重新扫描后 refreshStoredProgress 按 mapped 分支只统计映射文件夹（Season 01 2 集），忽略 Season 02
    await library.scanRoot("tv");
    expect(getTask(handle.db, task.id)).toMatchObject({ storedProgress: 2, sourceMode: "mapped" });
  });

  it("does not zero mapped tasks when inventory matching runs without roots", async () => {
    ({ directory, handle } = createTestDatabase());
    const mapped = createTaskWithOutcome(
      handle.db,
      {
        mediaType: "tv",
        tmdbId: 70523,
        taskType: "ingest",
        title: "Dark",
      },
      canonical(2017),
    ).task;
    const roots = [{ id: "tv", name: "电视剧", mediaType: "tv" as const, path: "tv-root" }];
    const library = createLibraryService(
      roots,
      async () => [
        episode("Dark (2017)/Season 01/Dark.S01E01-E02.strm", [1, 2]),
        {
          ...episode("Dark (2017)/Season 02/Dark.S02E01.strm", [1]),
          identity: {
            ...episode("unused", [1]).identity,
            physicalSeason: 2,
            parsedSeason: 2,
          },
        },
      ],
      handle.db,
    );
    await library.scanRoot("tv");
    setTaskFolderMapping(handle.db, mapped.id, "tv", "Dark (2017)/Season 01", 2, "mapped");
    expect(getTask(handle.db, mapped.id)).toMatchObject({ storedProgress: 2, sourceMode: "mapped" });

    // 另一个作品的一条未匹配库存行，触发 matchInventoryToMediaItem 内部的 refreshStoredProgress
    createTaskWithOutcome(
      handle.db,
      {
        mediaType: "tv",
        tmdbId: 999999,
        taskType: "ingest",
        title: "Other",
      },
      canonical(2020),
    );
    const rootRow = handle.db.select().from(mediaRoots).where(eq(mediaRoots.containerPath, "tv-root")).get();
    expect(rootRow).toBeDefined();
    const timestamp = new Date().toISOString();
    handle.db
      .insert(libraryItems)
      .values({
        mediaRootId: rootRow!.id,
        relativePath: "Other (2020)/Season 01/Other.S01E01.strm",
        sourceTitle: "Other",
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .run();
    const otherItem = handle.db.select().from(mediaItems).where(eq(mediaItems.tmdbId, 999999)).get();
    expect(otherItem).toBeDefined();
    // 不传 roots，模拟旧调用路径：mapped 任务不应被清零
    matchInventoryToMediaItem(handle.db, otherItem!);
    expect(getTask(handle.db, mapped.id)).toMatchObject({ storedProgress: 2, sourceMode: "mapped" });
  });

  it("counts only the tracked season's files for a season-scoped task", async () => {
    ({ directory, handle } = createTestDatabase());
    const task = createTaskWithOutcome(
      handle.db,
      {
        mediaType: "tv",
        tmdbId: 70523,
        taskType: "ingest",
        title: "Dark",
        seasonNumber: 2,
      },
      canonical(2017),
    ).task;
    const roots = [{ id: "tv", name: "TV", mediaType: "tv" as const, path: "tv-root" }];
    const seasonTwo = (path: string, episodeNumbers: number[]) => ({
      ...episode(path, episodeNumbers),
      identity: { ...episode(path, episodeNumbers).identity, physicalSeason: 2, parsedSeason: 2 },
    });
    const library = createLibraryService(
      roots,
      async () => [
        episode("Dark (2017)/Season 01/Dark.S01E01.strm", [1]),
        seasonTwo("Dark (2017)/Season 02/Dark.S02E01.strm", [1]),
        seasonTwo("Dark (2017)/Season 02/Dark.S02E02.strm", [2]),
      ],
      handle.db,
    );

    await library.scanRoot("tv");

    expect(getTask(handle.db, task.id)).toMatchObject({ storedProgress: 2, seasonNumber: 2 });
  });

  it("upserts by relative path (keeps ids) and removes deleted STRMs", async () => {
    ({ directory, handle } = createTestDatabase());
    const roots = [{ id: "movies", name: "电影", mediaType: "movie" as const, path: "movies-root" }];
    const both = [episode("A (2000)/A (2000).strm", []), episode("B (2001)/B (2001).strm", [])];
    const first = createLibraryService(roots, async () => both, handle.db);
    await first.scanRoot("movies");
    const firstIds = handle.db
      .select({ id: libraryItems.id, relativePath: libraryItems.relativePath })
      .from(libraryItems)
      .all();

    // 第二次只保留 A：B 应被删除，A 的数据库行 id 应保持不变。
    const second = createLibraryService(roots, async () => ({ items: [both[0]!], complete: true }), handle.db);
    await second.scanRoot("movies");
    const after = handle.db
      .select({ id: libraryItems.id, relativePath: libraryItems.relativePath })
      .from(libraryItems)
      .all();
    expect(after).toHaveLength(1);
    expect(after[0]!.relativePath).toBe("A (2000)/A (2000).strm");
    const keptId = firstIds.find((row) => row.relativePath === "A (2000)/A (2000).strm")?.id;
    expect(keptId).toBeDefined();
    expect(after[0]!.id).toBe(keptId);
    expect(after.map((row) => row.id)).not.toContain(
      firstIds.find((row) => row.relativePath === "B (2001)/B (2001).strm")!.id,
    );
  });

  it("classifies the new tgtodrive nested structure into movie/tv by structural segments", () => {
    const tvIdentity = {
      physicalSeason: 1,
      parsedSeason: 1,
      episodeNumbers: [1],
      absoluteEpisodeNumbers: [],
      numberingMode: "seasonal" as const,
      warning: null,
    };
    const movieIdentity = {
      physicalSeason: null,
      parsedSeason: null,
      episodeNumbers: [],
      absoluteEpisodeNumbers: [],
      numberingMode: "unresolved" as const,
      warning: null,
    };
    expect(
      classifyItemMediaType(
        tvIdentity,
        "光鸭云盘/天鸿影视/剧集/其他剧集/2026/迷途善人 (2026) {tmdb-304210}/Season 1/迷途善人.2026.S01E03.第3集.strm",
      ),
    ).toBe("tv");
    expect(
      classifyItemMediaType(
        movieIdentity,
        "123云盘/天鸿影视/电影/欧美电影/1975/巴里·林登 (1975) {tmdb-3175}/巴里·林登 (1975) - 2160p.BluRay REMUX.strm",
      ),
    ).toBe("movie");
    expect(
      classifyItemMediaType(tvIdentity, "光鸭云盘/天鸿影视/综艺/其他综艺/2026/某综艺 (2026) {tmdb-7}/Season 1/x.strm"),
    ).toBe("tv");
    expect(
      classifyItemMediaType(movieIdentity, "光鸭云盘/天鸿影视/纪录片/其他纪录片/2020/某电影 (2020) {tmdb-8}/x.strm"),
    ).toBe("movie");
  });
});

function createTestDatabase() {
  const directory = mkdtempSync(join(tmpdir(), "emby-library-"));
  return { directory, handle: createDatabase(join(directory, "library.sqlite")) };
}

function canonical(releaseYear: number) {
  return { originalTitle: "", releaseYear, overview: "", posterUrl: null, backdropUrl: null, tmdbPayload: {} };
}

function episode(relativePath: string, episodeNumbers: number[]) {
  return {
    relativePath,
    identity: {
      physicalSeason: episodeNumbers.length ? 1 : null,
      parsedSeason: episodeNumbers.length ? 1 : null,
      episodeNumbers,
      absoluteEpisodeNumbers: [],
      numberingMode: episodeNumbers.length ? ("seasonal" as const) : ("unresolved" as const),
      warning: null,
    },
  };
}

describe("library roots driven by a source (Emby)", () => {
  it("adds, renames and removes roots as the source changes, and never deletes rows", async () => {
    const directory = mkdtempSync(join(tmpdir(), "emby-roots-"));
    const database = createDatabase(join(directory, "app.sqlite"));
    try {
      let incoming: LibraryRootConfig[] = [
        { id: "1", name: "国产电影", mediaType: "movie", path: "emby:1" },
        { id: "2", name: "欧美电影", mediaType: "movie", path: "emby:2" },
      ];
      const service = createLibraryService({ load: async () => incoming }, async () => [], database.db);

      // 启动时还没有库根（来源驱动）；refresh 后才有
      expect(service.listRoots()).toHaveLength(0);
      expect((await service.refreshRoots?.())?.plan.added.map((root) => root.id)).toEqual(["1", "2"]);
      expect(service.listRoots().map((root) => root.name)).toEqual(["国产电影", "欧美电影"]);

      // Emby 里改名 + 新增 + 删库
      incoming = [
        { id: "1", name: "华语电影", mediaType: "movie", path: "emby:1" },
        { id: "3", name: "日韩电影", mediaType: "movie", path: "emby:3" },
      ];
      const outcome = await service.refreshRoots?.();
      expect(outcome?.plan.updated.map((root) => root.name)).toEqual(["华语电影"]);
      expect(outcome?.plan.added.map((root) => root.id)).toEqual(["3"]);
      expect(outcome?.plan.removed).toEqual(["2"]);
      expect(
        service
          .listRoots()
          .map((root) => root.name)
          .sort(),
      ).toEqual(["华语电影", "日韩电影"]);

      // 被删的库在数据库里只停用、不删行
      const rows = database.db.select().from(mediaRoots).all();
      expect(rows).toHaveLength(3);
      expect(rows.find((row) => row.containerPath === "emby:2")?.enabled).toBe(false);
      expect(rows.find((row) => row.containerPath === "emby:1")?.enabled).toBe(true);
    } finally {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps the current roots when the source fails", async () => {
    const directory = mkdtempSync(join(tmpdir(), "emby-roots-"));
    const database = createDatabase(join(directory, "app.sqlite"));
    try {
      let fail = false;
      const service = createLibraryService(
        {
          load: async () => {
            if (fail) throw new Error("emby_unreachable");
            return [{ id: "1", name: "国产电影", mediaType: "movie", path: "emby:1" }];
          },
        },
        async () => [],
        database.db,
      );
      await service.refreshRoots?.();
      fail = true;

      const outcome = await service.refreshRoots?.();
      expect(outcome?.error).toBeInstanceOf(Error);
      expect(outcome?.plan.removed).toEqual([]);
      // 关键：Emby 不可达时库根与库存保持原样，绝不当成"库都被删了"
      expect(service.listRoots().map((root) => root.name)).toEqual(["国产电影"]);
      expect(
        database.db
          .select()
          .from(mediaRoots)
          .all()
          .every((row) => row.enabled),
      ).toBe(true);
    } finally {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("Emby identity and safe deletion", () => {
  function setup() {
    const directory = mkdtempSync(join(tmpdir(), "emby-identity-"));
    const database = createDatabase(join(directory, "app.sqlite"));
    return { directory, database };
  }

  const root: LibraryRootConfig = { id: "1", name: "动画电影", mediaType: "movie", path: "emby:1" };

  function item(relativePath: string, embyItemId: string): ScannedMediaItem {
    return {
      relativePath,
      embyItemId,
      identity: {
        physicalSeason: null,
        parsedSeason: null,
        episodeNumbers: [],
        absoluteEpisodeNumbers: [],
        numberingMode: "unresolved",
        warning: null,
      },
    };
  }

  it("keeps the same row when Emby renames a work instead of inserting a new one", async () => {
    const { directory, database } = setup();
    try {
      let scanned = [item("狮子王/狮子王 [1001].strm", "1001")];
      const service = createLibraryService([root], async () => ({ items: scanned, complete: true }), database.db);
      await service.scanRoot("1");

      const first = database.db.select().from(libraryItems).all();
      expect(first).toHaveLength(1);
      expect(first[0]?.embyItemId).toBe("1001");

      // Emby 侧改名 → 合成路径变了，但条目 Id 没变
      scanned = [item("狮子王 (1994)/狮子王 [1001].strm", "1001")];
      await service.scanRoot("1");

      const after = database.db.select().from(libraryItems).all();
      expect(after).toHaveLength(1); // 不是"新建一行 + 删旧行"
      expect(after[0]?.id).toBe(first[0]?.id);
      expect(after[0]?.relativePath).toBe("狮子王 (1994)/狮子王 [1001].strm");
    } finally {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not wipe the inventory when a scan comes back empty", async () => {
    const { directory, database } = setup();
    try {
      let scanned = [item("甲/甲 [1].strm", "1"), item("乙/乙 [2].strm", "2")];
      const service = createLibraryService([root], async () => ({ items: scanned, complete: true }), database.db);
      await service.scanRoot("1");
      expect(database.db.select().from(libraryItems).all()).toHaveLength(2);

      // Emby 分页/瞬时故障导致整轮结果为空 → 不能当成"都被删了"
      scanned = [];
      await service.scanRoot("1");
      expect(database.db.select().from(libraryItems).all()).toHaveLength(2);

      // 真的少了一条（结果非空）→ 正常删除
      scanned = [item("甲/甲 [1].strm", "1")];
      await service.scanRoot("1");
      expect(database.db.select().from(libraryItems).all()).toHaveLength(1);
    } finally {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("inactive inventory retention", () => {
  it("keeps stock, episodes and scan history for removed roots and restores reads when they return", async () => {
    const directory = mkdtempSync(join(tmpdir(), "legacy-cleanup-"));
    const database = createDatabase(join(directory, "app.sqlite"));
    try {
      // 先造出"本地 STRM 时代"的样子：一个盘根 + 一条带分集的库存
      const legacy = createLibraryService(
        [{ id: "strm", name: "STRM", mediaType: "mixed", path: "strm" }],
        async () => [],
        database.db,
      );
      // 直接落一行带分集的库存（模拟旧数据）
      const rootRow = database.db.select().from(mediaRoots).all()[0]!;
      const inserted = database.db
        .insert(libraryItems)
        .values({
          mediaRootId: rootRow.id,
          relativePath: "旧片/旧片.strm",
          sourceTitle: "旧片",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        })
        .returning({ id: libraryItems.id })
        .get();
      database.db
        .insert(libraryEpisodes)
        .values({
          libraryItemId: inserted.id,
          physicalSeason: 1,
          episodeNumber: 1,
          createdAt: new Date().toISOString(),
        })
        .run();
      expect(database.db.select().from(libraryItems).all()).toHaveLength(1);
      expect(database.db.select().from(libraryEpisodes).all()).toHaveLength(1);
      const history = database.db
        .insert(libraryScanRuns)
        .values({
          mediaRootId: rootRow.id,
          startedAt: "2026-10-07T00:00:00Z",
          discoveredCount: 1,
        })
        .returning()
        .get();
      expect(legacy.getInventory("strm")?.items).toHaveLength(1);
      expect(legacy.getInventoryPayload("strm")).not.toBeNull();

      // 换成 Emby 库根（Emby 侧只有一个库）
      const removed: Array<{ roots: number; rows: number }> = [];
      const embyRoot: LibraryRootConfig = { id: "127638", name: "动画电影", mediaType: "movie", path: "emby:127638" };
      const legacyRoot: LibraryRootConfig = { id: "strm", name: "STRM", mediaType: "mixed", path: "strm" };
      let incoming = [embyRoot];
      const emby = createLibraryService({ load: async () => incoming }, async () => [], database.db, {
        onLegacyInventoryRemoved: (info) => removed.push({ roots: info.roots, rows: info.rows }),
      });
      await emby.refreshRoots?.();

      expect(database.db.select().from(libraryItems).all()).toHaveLength(1);
      expect(database.db.select().from(libraryEpisodes).all()).toHaveLength(1);
      expect(database.db.select().from(libraryScanRuns).all()).toEqual([history]);
      expect(removed).toEqual([]);
      // 旧服务实例与已经加载的缓存也必须立即停止显示停用库存。
      expect(legacy.listRoots()).toEqual([]);
      expect(legacy.getInventory("strm")).toBeNull();
      expect(legacy.getInventoryPayload("strm")).toBeNull();
      // 库根仍然正常：Emby 的库在、盘根停用但保留
      expect(emby.listRoots().map((root) => root.name)).toEqual(["动画电影"]);
      const rows = database.db.select().from(mediaRoots).all();
      expect(rows.find((row) => row.containerPath === "strm")?.enabled).toBe(false);
      incoming = [embyRoot, legacyRoot];
      await emby.refreshRoots?.();
      expect(emby.getInventory("strm")?.items[0]?.databaseId).toBe(inserted.id);
      expect(legacy.getInventory("strm")?.items).toHaveLength(1);
      expect(database.db.select().from(libraryScanRuns).all()).toEqual([history]);
    } finally {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("authoritative titles from Emby", () => {
  it("prefers the Emby name and year over parsing the synthesised path", async () => {
    const directory = mkdtempSync(join(tmpdir(), "emby-title-"));
    const database = createDatabase(join(directory, "app.sqlite"));
    try {
      const service = createLibraryService(
        [{ id: "127638", name: "动画电影", mediaType: "movie", path: "emby:127638" }],
        async () => [
          {
            // 合成路径里的目录段是"作品名"，但正则推断会带上括号里的年份等噪声
            relativePath: "狮子王 (1994) [特别版]/狮子王 (1994) [特别版] [1001].strm",
            embyItemId: "1001",
            sourceTitleHint: "狮子王",
            sourceYearHint: 1994,
            identity: {
              physicalSeason: null,
              parsedSeason: null,
              episodeNumbers: [],
              absoluteEpisodeNumbers: [],
              numberingMode: "unresolved",
              warning: null,
            },
          },
        ],
        database.db,
      );
      await service.scanRoot("127638");

      const item = service.getInventory("127638")!.items[0]!;
      expect(item.sourceTitle).toBe("狮子王");
      expect(item.sourceYear).toBe(1994);
    } finally {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("scan items survive the sanitizer", () => {
  it("keeps every field a scanner can set (no silent drops)", async () => {
    // sanitizeItem 是一份白名单，历史上已经漏掉过 fileModifiedAt 与 Emby 的权威片名/年份——
    // 漏掉不会报错，只会让功能静默失效。这条用例把"扫描器能给的字段"整体锁住。
    const directory = mkdtempSync(join(tmpdir(), "sanitize-"));
    const database = createDatabase(join(directory, "app.sqlite"));
    try {
      const service = createLibraryService(
        [{ id: "1", name: "库", mediaType: "movie", path: "emby:1" }],
        async () => [
          {
            relativePath: "某片 (2016)/某片 [9].strm",
            embyItemId: "9",
            posterPath: "emby:9",
            tags: ["2160p", "HEVC"],
            genres: ["科幻"],
            fileModifiedAt: "2026-09-02T08:24:18.000Z",
            sourceTitleHint: "某片",
            sourceYearHint: 2016,
            identity: {
              physicalSeason: null,
              parsedSeason: null,
              episodeNumbers: [],
              absoluteEpisodeNumbers: [],
              numberingMode: "unresolved",
              warning: null,
            },
          },
        ],
        database.db,
      );
      await service.scanRoot("1");

      const item = service.getInventory("1")!.items[0]!;
      expect(item.sourceTitle).toBe("某片");
      expect(item.sourceYear).toBe(2016);
      expect(item.posterPath).toBe("emby:9");
      expect(item.tags).toEqual(["2160p", "HEVC"]);
      expect(item.genres).toEqual(["科幻"]);
      expect(item.addedAt).toBe("2026-09-02T08:24:18.000Z");
    } finally {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("Emby metadata projection", () => {
  it("links items by Emby's tmdb id and creates the missing title without calling TMDB", async () => {
    const directory = mkdtempSync(join(tmpdir(), "emby-tmdb-"));
    const database = createDatabase(join(directory, "app.sqlite"));
    try {
      const service = createLibraryService(
        [{ id: "127638", name: "动画电影", mediaType: "movie", path: "emby:127638" }],
        async () => [
          {
            relativePath: "狮子王/狮子王 [1001].strm",
            embyItemId: "1001",
            sourceTitleHint: "狮子王",
            sourceYearHint: 1994,
            tmdbId: 8587,
            genres: ["动画", "家庭"],
            identity: {
              physicalSeason: null,
              parsedSeason: null,
              episodeNumbers: [],
              absoluteEpisodeNumbers: [],
              numberingMode: "unresolved",
              warning: null,
            },
          },
        ],
        database.db,
      );
      await service.scanRoot("127638");

      // 本地原本没有这部电影：用 Emby 的元数据直接建条目（零 TMDB 调用）
      const created = database.db.select().from(mediaItems).all();
      expect(created).toHaveLength(1);
      expect(created[0]?.tmdbId).toBe(8587);
      expect(created[0]?.title).toBe("狮子王");
      expect(created[0]?.releaseYear).toBe(1994);
      expect(created[0]?.genres).toEqual(["动画", "家庭"]);

      // 库存行已经认到条目（匹配率不再是 0）
      const item = service.getInventory("127638")!.items[0]!;
      expect(item.mediaItemId).toBe(created[0]?.id);
      expect(item.recognitionStatus).toBe("matched");

      // 再扫一遍不会重复建条目（按 tmdbId 复用）
      await service.scanRoot("127638");
      expect(database.db.select().from(mediaItems).all()).toHaveLength(1);
    } finally {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("prefers Emby's tmdb id over a same-named local entry", async () => {
    // 真实数据：本地按片名匹配到了同名的另一部剧（Rebelde 2004 / 2011、我们的宇宙两版）。
    // 媒体库是 Emby 驱动的，Emby 的 ProviderId 才是权威——必须挂到它指向的条目，而不是同名条目。
    const directory = mkdtempSync(join(tmpdir(), "emby-priority-"));
    const database = createDatabase(join(directory, "app.sqlite"));
    try {
      const timestamp = new Date().toISOString();
      const wrong = database.db
        .insert(mediaItems)
        .values({
          tmdbId: 66757,
          mediaType: "tv",
          title: "我们的宇宙",
          releaseYear: 2022,
          createdAt: timestamp,
          updatedAt: timestamp,
        })
        .returning({ id: mediaItems.id })
        .get()!;
      const service = createLibraryService(
        [{ id: "1", name: "库", mediaType: "tv", path: "emby:1" }],
        async () => [
          {
            relativePath: "我们的宇宙/Season 1/EP01 [9001].strm",
            embyItemId: "9001",
            sourceTitleHint: "我们的宇宙",
            sourceYearHint: 2022,
            tmdbId: 213608,
            identity: {
              physicalSeason: 1,
              parsedSeason: 1,
              episodeNumbers: [1],
              absoluteEpisodeNumbers: [],
              numberingMode: "seasonal",
              warning: null,
            },
          },
        ],
        database.db,
      );
      await service.scanRoot("1");

      const rows = database.db.select().from(mediaItems).all();
      const correct = rows.find((row) => row.tmdbId === 213608);
      expect(correct).toBeDefined();
      const item = service.getInventory("1")!.items[0]!;
      expect(item.mediaItemId).toBe(correct!.id);
      expect(item.mediaItemId).not.toBe(wrong.id);
    } finally {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("falls back to title matching for items Emby has no tmdb id for", async () => {
    const directory = mkdtempSync(join(tmpdir(), "emby-notmdb-"));
    const database = createDatabase(join(directory, "app.sqlite"));
    try {
      const service = createLibraryService(
        [{ id: "1", name: "库", mediaType: "movie", path: "emby:1" }],
        async () => [
          {
            relativePath: "无编号的片/无编号的片 [1].strm",
            embyItemId: "1",
            sourceTitleHint: "无编号的片",
            sourceYearHint: 2020,
            tmdbId: null,
            identity: {
              physicalSeason: null,
              parsedSeason: null,
              episodeNumbers: [],
              absoluteEpisodeNumbers: [],
              numberingMode: "unresolved",
              warning: null,
            },
          },
        ],
        database.db,
      );
      await service.scanRoot("1");

      // 没有 tmdbId 时不该凭空建条目
      expect(database.db.select().from(mediaItems).all()).toHaveLength(0);
      expect(service.getInventory("1")!.items[0]?.recognitionStatus).toBe("unresolved");
    } finally {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

/**
 * 媒体库库存的读取成本与缓存。
 *
 * 为什么单独立一组：这组用例守的是"打开媒体库页不会把整个服务拖死"。
 * 起因是真实环境里 GET /api/library/roots/:id/inventory 平均 326ms、最慢 5.5s，
 * 而前端一次并发拉全部 32 个根（合计 ~67MB）——全是同步 CPU 活，
 * 结果所有页面一起卡（别的接口被排队到 10-27 秒）。
 */
describe("library inventory read cost", () => {
  let directory: string;
  let handle: DatabaseHandle;

  afterEach(() => {
    handle?.close();
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  /**
   * 建一个"能数查询次数"的库：自己持有原生 sqlite 句柄，包装 prepare 出来的语句，
   * 统计**执行**（而不是 prepare）次数——drizzle 可能复用已 prepare 的语句，
   * 只数 prepare 会漏掉真正的 N+1。
   */
  function createCountingDatabase() {
    const directory = mkdtempSync(join(tmpdir(), "emby-library-count-"));
    const sqlite = new BetterSqlite3(join(directory, "library.sqlite"));
    sqlite.pragma("foreign_keys = ON");
    const db = drizzle(sqlite, { schema }) as AppDatabase;
    migrate(db);

    let episodeReads = 0;
    const originalPrepare = sqlite.prepare.bind(sqlite) as (sql: string, ...rest: unknown[]) => unknown;
    (sqlite as unknown as { prepare: typeof originalPrepare }).prepare = ((sql: string, ...rest: unknown[]) => {
      const statement = originalPrepare(sql, ...rest) as {
        all?: (...args: unknown[]) => unknown;
        get?: (...args: unknown[]) => unknown;
      };
      // 指纹：任何"查 library_episodes"的语句，每执行一次记一笔
      if (/library_episodes/i.test(sql)) {
        const all = statement.all?.bind(statement);
        const get = statement.get?.bind(statement);
        if (all) statement.all = (...args: unknown[]) => (episodeReads++, all(...args));
        if (get) statement.get = (...args: unknown[]) => (episodeReads++, get(...args));
      }
      return statement;
    }) as typeof originalPrepare;

    return {
      directory,
      handle: { db, close: () => sqlite.close() } as DatabaseHandle,
      episodeReads: () => episodeReads,
      resetCount: () => {
        episodeReads = 0;
      },
    };
  }

  it("剧集明细用一条 SQL 全取，查询次数不随条目数增长（N+1 回归）", async () => {
    const counting = createCountingDatabase();
    directory = counting.directory;
    handle = counting.handle;
    const roots: LibraryRootConfig[] = [{ id: "tv", name: "剧集", mediaType: "tv", path: "tv-root" }];
    const many = Array.from({ length: 40 }, (_, index) =>
      episode(`Dark (2017)/Season 01/Dark.S01E${String(index + 1).padStart(2, "0")}.strm`, [index + 1]),
    );
    const library = createLibraryService(roots, async () => many, handle.db);
    await library.scanRoot("tv");

    // 内容正确性：40 条的集号都在（说明分组没串行）
    const items = library.getInventory("tv")!.items;
    expect(items).toHaveLength(40);
    expect(items.map((item) => item.identity.episodeNumbers[0]).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 40 }, (_, index) => index + 1),
    );
    expect(items[0]!.identity.numberingMode).toBe("seasonal");

    // 清掉扫描期缓存后量一次纯读：40 条不该变成 40 次查询
    library.invalidateInventory();
    counting.resetCount();
    library.getInventory("tv");
    expect(counting.episodeReads(), "读一次库存查了太多次 library_episodes（N+1 又回来了）").toBeLessThanOrEqual(2);
  });

  it("同一库根重复读取走缓存，且 payload 是可直接下发的 JSON", async () => {
    ({ directory, handle } = createTestDatabase());
    const roots: LibraryRootConfig[] = [{ id: "tv", name: "剧集", mediaType: "tv", path: "tv-root" }];
    const library = createLibraryService(roots, async () => [episode("Dark (2017)/S01/E01.strm", [1])], handle.db);
    await library.scanRoot("tv");

    const first = library.getInventoryPayload("tv");
    expect(first).toBeTruthy();
    const parsed = JSON.parse(first!) as { root: { id: string }; items: unknown[] };
    expect(parsed.root.id).toBe("tv");
    expect(parsed.items).toHaveLength(1);

    // 第二次读：把库里的行清掉，若仍能读出同样内容，说明走的是缓存而不是重新查库
    // （剧集表有外键指过来，必须先删子行）
    handle.db.delete(libraryEpisodes).run();
    handle.db.delete(libraryItems).run();
    const second = library.getInventoryPayload("tv");
    expect(second).toBe(first);

    // 失效之后必须重新查库（此时已空）
    library.invalidateInventory("tv");
    expect(JSON.parse(library.getInventoryPayload("tv")!).items).toHaveLength(0);
  });

  it("扫描会作废该库根的缓存（新扫出来的内容立刻可见）", async () => {
    ({ directory, handle } = createTestDatabase());
    const roots: LibraryRootConfig[] = [{ id: "tv", name: "剧集", mediaType: "tv", path: "tv-root" }];
    let scanned = [episode("Dark (2017)/S01/E01.strm", [1])];
    const library = createLibraryService(roots, async () => scanned, handle.db);
    await library.scanRoot("tv");
    expect(library.getInventory("tv")!.items).toHaveLength(1);

    // 第二次扫描多出一集，缓存必须跟着变
    scanned = [...scanned, episode("Dark (2017)/S01/E02.strm", [2])];
    await library.scanRoot("tv");
    expect(library.getInventory("tv")!.items).toHaveLength(2);
  });

  it("没有这个库根时 getInventoryPayload 返回 null（路由据此回 404）", async () => {
    ({ directory, handle } = createTestDatabase());
    const library = createLibraryService(
      [{ id: "tv", name: "剧集", mediaType: "tv", path: "tv-root" }],
      async () => [],
      handle.db,
    );
    expect(library.getInventoryPayload("nope")).toBeNull();
  });
});
