import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabase, type DatabaseHandle } from "@emby-task-center/database/client";
import { libraryEpisodes, libraryItems, mediaItems, mediaRoots } from "@emby-task-center/database/schema";
import { createLibraryService, type LibraryRootConfig } from "./service";
import { createWorkSummaryStore } from "./work-summaries";

const timestamp = "2026-10-17T00:00:00.000Z";
const root: LibraryRootConfig = { id: "test", name: "混合库", mediaType: "mixed", path: "emby:test" };

describe("library work identity", () => {
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

  function media(tmdbId: number | null, mediaType: "tv" | "movie" = "tv") {
    return handle.db
      .insert(mediaItems)
      .values({
        title: `作品 ${++sequence}`,
        tmdbId,
        mediaType,
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .returning()
      .get();
  }

  function item(
    title: string,
    options: { mediaId?: number; year?: number | null; tv?: boolean; rootId?: number } = {},
  ) {
    const row = handle.db
      .insert(libraryItems)
      .values({
        mediaRootId: options.rootId ?? rootId,
        relativePath: `item-${++sequence}.strm`,
        sourceTitle: title,
        sourceYear: options.year ?? null,
        mediaItemId: options.mediaId ?? null,
        recognitionStatus: options.mediaId ? "matched" : "unresolved",
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .returning()
      .get();
    if (options.tv)
      handle.db
        .insert(libraryEpisodes)
        .values({
          libraryItemId: row.id,
          parsedSeason: 1,
          episodeNumber: sequence,
          numberingMode: "seasonal",
          createdAt: timestamp,
        })
        .run();
    return row.id;
  }

  it("groups translated titles and differing years by TMDB while keeping all source rows in details", () => {
    const canonical = media(123);
    const ids = [
      item("中文剧名", { mediaId: canonical.id, year: 2023, tv: true }),
      item("Original Title", { mediaId: canonical.id, year: 2024, tv: true }),
    ];
    const otherRoot = handle.db
      .insert(mediaRoots)
      .values({
        name: "其他库",
        mediaType: "mixed",
        containerPath: "emby:other",
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .returning()
      .get();
    item("中文剧名", { mediaId: canonical.id, year: 2023, tv: true, rootId: otherRoot.id });
    const store = createWorkSummaryStore(handle.db);
    const state = store.get(root)!;
    expect(state.summary).toMatchObject({ totalFiles: 2, workCount: 1, matchedFiles: 2 });
    expect(state.works[0]).toMatchObject({ key: "tmdb|tv|123", fileCount: 2 });
    expect(store.page(root, state.works)[0]!.items).toHaveLength(1);
    expect(
      store
        .details(root, state.works[0]!.key)!
        .map((row) => row.databaseId)
        .sort(),
    ).toEqual(ids.sort());
    expect(handle.db.select().from(libraryItems).all()).toHaveLength(3);
    expect(handle.db.select().from(libraryEpisodes).all()).toHaveLength(3);
  });

  it("separates same-title works with distinct IDs and separates movie/TV namespaces", () => {
    const tv = media(123);
    const otherTv = media(456);
    const movie = media(123, "movie");
    const expected = new Map([
      ["tmdb|tv|123", item("同名", { mediaId: tv.id, year: 2024 })],
      ["tmdb|tv|456", item("同名", { mediaId: otherTv.id, year: 2024, tv: true })],
      ["tmdb|movie|123", item("同名", { mediaId: movie.id, year: 2024, tv: true })],
      ["tv|同名|2024", item("同名", { year: 2024, tv: true })],
    ]);
    const store = createWorkSummaryStore(handle.db);
    expect(store.get(root)!.summary).toMatchObject({ workCount: 4, totalFiles: 4 });
    for (const [key, id] of expected) {
      expect(store.details(root, key)!.map((row) => row.databaseId)).toEqual([id]);
    }
  });

  it("uses authoritative media types without TMDB and keeps contradictory episode identities in their own details", () => {
    const tv = media(null);
    const movie = media(null, "movie");
    const tvId = item("同名", { mediaId: tv.id, year: 2024 });
    const movieId = item("同名", { mediaId: movie.id, year: 2024, tv: true });
    const store = createWorkSummaryStore(handle.db);
    expect(
      store
        .get(root)!
        .works.map((work) => ({ key: work.key, isTv: work.isTv }))
        .sort((a, b) => a.key.localeCompare(b.key)),
    ).toEqual([
      { key: "movie|同名|2024", isTv: false },
      { key: "tv|同名|2024", isTv: true },
    ]);
    expect(store.details(root, "tv|同名|2024")!.map((row) => row.databaseId)).toEqual([tvId]);
    expect(store.details(root, "movie|同名|2024")!.map((row) => row.databaseId)).toEqual([movieId]);
    expect(handle.db.select().from(libraryEpisodes).all()).toHaveLength(1);
  });

  it("keeps title/year fallback for absent or invalid TMDB values without absorbing identified works", () => {
    const invalid = [null, 0, -1, 1.5].map((id) => media(id));
    const known = media(789);
    const fallback = [item("ÉCOLE", { year: 2024, tv: true })];
    for (const row of invalid) fallback.push(item("école", { mediaId: row.id, year: 2024, tv: true }));
    const identified = item("ÉCOLE", { mediaId: known.id, year: 2024, tv: true });
    const anotherYear = item("école", { year: 2023, tv: true });
    const store = createWorkSummaryStore(handle.db);
    expect(store.get(root)!.summary).toMatchObject({ workCount: 3, totalFiles: 7 });
    expect(
      store
        .details(root, "tv|école|2024")!
        .map((row) => row.databaseId)
        .sort(),
    ).toEqual(fallback.sort());
    expect(store.details(root, "tmdb|tv|789")!.map((row) => row.databaseId)).toEqual([identified]);
    expect(store.details(root, "tv|école|2023")!.map((row) => row.databaseId)).toEqual([anotherYear]);
  });
});
