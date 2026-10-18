import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDatabase, type DatabaseHandle } from "@emby-task-center/database/client";
import { libraryEpisodes, libraryItems, mediaItems, mediaRoots } from "@emby-task-center/database/schema";
import { createLibraryService, type LibraryRootConfig } from "./service";
import { createWorkSummaryStore } from "./work-summaries";

const timestamp = "2026-09-30T00:00:00.000Z";
const root: LibraryRootConfig = { id: "test", name: "测试混合库", mediaType: "mixed", path: "emby:test" };

describe("work summaries", () => {
  let handle: DatabaseHandle;
  let rootId: number;
  let sequence: number;

  beforeEach(() => {
    handle = createDatabase(":memory:");
    createLibraryService([root], undefined, handle.db);
    rootId = handle.db.select().from(mediaRoots).get()!.id;
    sequence = 0;
  });
  afterEach(() => handle.close());

  function item(
    values: Partial<typeof libraryItems.$inferInsert> = {},
    episodes: Partial<typeof libraryEpisodes.$inferInsert>[] = [],
  ) {
    const row = handle.db
      .insert(libraryItems)
      .values({
        mediaRootId: rootId,
        relativePath: `item-${++sequence}.strm`,
        sourceTitle: "作品",
        sourceYear: 2024,
        createdAt: timestamp,
        updatedAt: timestamp,
        ...values,
      })
      .returning()
      .get();
    for (const episode of episodes)
      handle.db
        .insert(libraryEpisodes)
        .values({
          libraryItemId: row.id,
          createdAt: timestamp,
          ...episode,
        })
        .run();
    return row;
  }

  function media(cast: unknown, genres: string[] = []) {
    return handle.db
      .insert(mediaItems)
      .values({
        title: `TMDB ${sequence}`,
        mediaType: "tv",
        genres,
        tmdbPayload: { cast },
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .returning()
      .get();
  }

  it("merges Unicode and ASCII case variants, while details include every file only in that work/root", () => {
    const canonical = media(["演员一", "Björk", { name: "ignored" }, ["nested ignored"], null], ["剧情"]);
    const other = media(["Björk", "演员二"]);
    const a = item(
      { sourceTitle: "ÉCOLE", mediaItemId: canonical.id, recognitionStatus: "matched", tags: ["1080p", "AVC"] },
      [{ episodeNumber: 1, parsedSeason: 1, numberingMode: "seasonal" }],
    );
    const b = item({ sourceTitle: "école", mediaItemId: other.id, genres: ["科幻"], tags: ["2160p", "HEVC"] }, [
      { episodeNumber: 2, parsedSeason: 1, numberingMode: "seasonal" },
    ]);
    const c = item({ sourceTitle: "ÉCOLE", fileModifiedAt: "2026-09-29T00:00:00Z" }, [
      { episodeNumber: 3, parsedSeason: 1, numberingMode: "seasonal" },
    ]);
    item({ sourceTitle: "école", sourceYear: 2023 }, [{ episodeNumber: 1 }]);
    item({ sourceTitle: "école" }); // 同名电影不能混入剧集详情。
    item({ sourceTitle: "ALPHA" });
    item({ sourceTitle: "alpha" });
    const elsewhere = handle.db
      .insert(mediaRoots)
      .values({
        name: "另一个库",
        mediaType: "tv",
        containerPath: "emby:elsewhere",
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .returning()
      .get();
    item({ sourceTitle: "école", mediaRootId: elsewhere.id }, [{ episodeNumber: 9 }]);

    const store = createWorkSummaryStore(handle.db);
    const state = store.get(root)!;
    expect(state.summary).toMatchObject({ totalFiles: 7, workCount: 4, matchedFiles: 1, unmatchedFiles: 6 });
    const work = state.works.find((w) => w.key === "tv|école|2024")!;
    expect(work).toMatchObject({
      fileCount: 3,
      matchedFiles: 1,
      unmatchedFiles: 2,
      resolution: "2160p",
      addedAt: "2026-09-29T00:00:00Z",
    });
    expect(work.cast.sort()).toEqual(["Björk", "演员一", "演员二"].sort());
    expect(work.genres.sort()).toEqual(["剧情", "科幻"].sort());
    expect(work.tags.sort()).toEqual(["1080p", "2160p", "AVC", "HEVC"].sort());
    const page = store.page(root, [work]);
    expect(page[0]!.items).toHaveLength(1);
    expect(page[0]!.items[0]!.databaseId).toBe(a.id);
    expect(
      store
        .details(root, work.key)!
        .map((i) => i.databaseId)
        .sort(),
    ).toEqual([a.id, b.id, c.id].sort());
    expect(store.details(root, "unknown")).toBeNull();
  });

  it("uses linked TV metadata for empty shows and falls back to episode identity without metadata", () => {
    const tv = media([]);
    item({ sourceTitle: "空剧集条目", mediaItemId: tv.id });
    item({ sourceTitle: "常规分集" }, [{ numberingMode: "seasonal", episodeNumber: 1 }]);
    item({ sourceTitle: "绝对编号" }, [{ numberingMode: "unresolved", absoluteEpisodeNumber: 17 }]);
    item({ sourceTitle: "有集号未定编号" }, [{ numberingMode: "unresolved", episodeNumber: 2 }]);
    item({ sourceTitle: "仅编号模式" }, [{ numberingMode: "seasonal" }]);
    item({ sourceTitle: "未关联电影" });
    const state = createWorkSummaryStore(handle.db).get(root)!;
    expect(state.works.map((w) => w.key).sort()).toEqual(
      [
        "tv|空剧集条目|2024",
        "tv|常规分集|2024",
        "tv|绝对编号|2024",
        "tv|有集号未定编号|2024",
        "tv|仅编号模式|2024",
        "movie|未关联电影|2024",
      ].sort(),
    );
    for (const work of state.works) expect(createWorkSummaryStore(handle.db).details(root, work.key)).toHaveLength(1);
  });

  it("ignores malformed cast shapes just like inventory details", () => {
    for (const cast of ["演员", 123, { name: "演员" }, null, ["有效演员", ["忽略嵌套演员"]]]) {
      item({ sourceTitle: `作品 ${sequence}`, mediaItemId: media(cast).id });
    }
    const state = createWorkSummaryStore(handle.db).get(root)!;
    expect(state.works.flatMap((work) => work.cast)).toEqual(["有效演员"]);
  });

  it("counts only usable Emby poster references in coverage, consistently with the previous page", () => {
    for (const posterPath of [null, "", "legacy/poster.jpg", "emby:", "emby:123"])
      item({ sourceTitle: `作品 ${sequence}`, posterPath });
    expect(createWorkSummaryStore(handle.db).get(root)!.summary).toMatchObject({
      totalFiles: 5,
      posterFiles: 1,
      posterRatio: 20,
    });
  });

  it("refreshes cached summaries after the root scan marker changes or explicit invalidation", () => {
    item({ sourceTitle: "第一部" });
    const store = createWorkSummaryStore(handle.db);
    const first = store.get(root)!;
    expect(store.get(root)).toBe(first);
    item({ sourceTitle: "第二部" });
    handle.db.update(mediaRoots).set({ lastScannedAt: "2026-09-30T01:00:00Z" }).where(eq(mediaRoots.id, rootId)).run();
    expect(store.get(root)!.summary.workCount).toBe(2);
    item({ sourceTitle: "第三部" });
    store.invalidate();
    expect(store.get(root)!.summary.workCount).toBe(3);
  });
});
