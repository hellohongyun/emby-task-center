import { afterEach, describe, expect, it } from "vitest";
import { createDatabase, type DatabaseHandle } from "@emby-task-center/database/client";
import { libraryEpisodes, libraryItems, mediaItems } from "@emby-task-center/database/schema";
import type { EmbyClient } from "../integrations/emby-client";
import { createEmbyLibraryReader } from "../integrations/emby-library-reader";
import { createEmbyScan } from "./emby-scanner";
import { computeMissingEpisodes } from "./missing-episode-scan";
import { createLibraryService } from "./service";

const series = (id: string) => ({ id, name: "合并集测试", type: "tv" as const, year: 2020, tmdbId: 100 });
const rawEpisode = (end: unknown = 2) => ({
  Id: "combined",
  Type: "Episode",
  Name: "第一集和第二集",
  ParentIndexNumber: 1,
  IndexNumber: 1,
  IndexNumberEnd: end,
});

describe("Emby combined episode files", () => {
  let database: DatabaseHandle | undefined;
  afterEach(() => database?.close());

  it("requests the inclusive end number and retains one file identity for every covered episode", async () => {
    let fields = "";
    const reader = createEmbyLibraryReader(async (params) => {
      fields = params.get("Fields") ?? "";
      return { Items: [rawEpisode()], TotalRecordCount: 1 };
    });
    const emby = {
      configured: true,
      listLibraryItems: async () => [series("show")],
      listItemEpisodes: reader.listItemEpisodes,
    } as unknown as EmbyClient;
    const result = await createEmbyScan(emby)("emby:fixture");
    expect(fields.split(",")).toContain("IndexNumberEnd");
    expect(result).toMatchObject({ complete: true });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      embyItemId: "combined",
      relativePath: "合并集测试/Season 1/EP01 [combined].strm",
      identity: { episodeNumbers: [1, 2] },
    });
  });

  it.each([undefined, null, 1])("accepts a missing or same-number end %s", async (end) => {
    const reader = createEmbyLibraryReader(async () => ({
      Items: [{ ...rawEpisode(), IndexNumberEnd: end }],
      TotalRecordCount: 1,
    }));
    expect((await reader.listItemEpisodes("show"))[0]!.episodeNumberEnd ?? 1).toBe(1);
  });

  it.each(["2", -1, 0, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, 10_001])(
    "rejects malformed or unbounded end %s without returning a valid prefix",
    async (end) => {
      const reader = createEmbyLibraryReader(async () => ({
        Items: [{ ...rawEpisode(1), Id: "valid" }, rawEpisode(end)],
        TotalRecordCount: 2,
      }));
      await expect(reader.listItemEpisodes("show")).rejects.toThrow("emby_episode_invalid_range");
    },
  );

  it("keeps different ranges starting at the same episode and deduplicates exact copies", async () => {
    const reader = createEmbyLibraryReader(async (params) => ({
      Items:
        params.get("ParentId") === "a"
          ? [{ ...rawEpisode(1), Id: "single" }]
          : [rawEpisode(3), { ...rawEpisode(3), Id: "same-range-copy" }],
      TotalRecordCount: params.get("ParentId") === "a" ? 1 : 2,
    }));
    const emby = {
      configured: true,
      listLibraryItems: async () => [series("a"), series("b"), series("c")],
      listItemEpisodes: reader.listItemEpisodes,
    } as unknown as EmbyClient;
    const { items } = await createEmbyScan(emby)("emby:fixture");
    expect(items.map((item) => item.embyItemId)).toEqual(["single", "combined"]);
    expect(items.map((item) => item.identity.episodeNumbers)).toEqual([[1], [1, 2, 3]]);
    expect(new Set(items.map((item) => item.relativePath)).size).toBe(items.length);
    expect(new Set(items.flatMap((item) => item.identity.episodeNumbers))).toEqual(new Set([1, 2, 3]));
  });

  it("rejects conflicting metadata for one real Emby id instead of duplicating it or losing coverage", async () => {
    const reader = createEmbyLibraryReader(async (params) => ({
      Items: [rawEpisode(params.get("ParentId") === "a" ? 1 : 3)],
      TotalRecordCount: 1,
    }));
    const emby = {
      configured: true,
      listLibraryItems: async () => [series("a"), series("b")],
      listItemEpisodes: reader.listItemEpisodes,
    } as unknown as EmbyClient;
    await expect(createEmbyScan(emby)("emby:fixture")).rejects.toThrow("emby_episode_conflicting_identity");
  });

  it("persists the whole range on rescan, avoids false gaps and retains inventory after an invalid later scan", async () => {
    database = createDatabase(":memory:");
    const timestamp = "2026-01-01T00:00:00.000Z";
    database.db
      .insert(mediaItems)
      .values({ id: 1, title: "合并集测试", tmdbId: 100, mediaType: "tv", createdAt: timestamp, updatedAt: timestamp })
      .run();
    let source = [rawEpisode(1)];
    const reader = createEmbyLibraryReader(async () => ({ Items: source, TotalRecordCount: source.length }));
    const emby = {
      configured: true,
      listLibraryItems: async () => [series("show")],
      listItemEpisodes: reader.listItemEpisodes,
    } as unknown as EmbyClient;
    const library = createLibraryService(
      [{ id: "fixture", name: "测试库", mediaType: "tv", path: "emby:fixture" }],
      createEmbyScan(emby),
      database.db,
    );
    await library.scanRoot("fixture");
    const original = database.db.select().from(libraryItems).get()!;
    expect(
      database.db
        .select()
        .from(libraryEpisodes)
        .all()
        .map((row) => row.episodeNumber),
    ).toEqual([1]);

    source = [rawEpisode(3)];
    await library.scanRoot("fixture");
    const items = database.db.select().from(libraryItems).all();
    const episodes = database.db.select().from(libraryEpisodes).all();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: original.id, embyItemId: "combined", mediaItemId: 1 });
    expect(episodes.map((row) => row.episodeNumber)).toEqual([1, 2, 3]);
    const computation = computeMissingEpisodes(
      [
        {
          seasonNumber: 1,
          episodes: [1, 2, 3].map((episodeNumber) => ({ episodeNumber, name: null, airDate: "2020-01-01" })),
        },
      ],
      new Map([[1, new Set(episodes.map((row) => row.episodeNumber!))]]),
      new Date(2026, 9, 18),
    );
    expect(computation).toMatchObject({ missingCount: 0, storedCount: 3 });

    source = [{ ...rawEpisode(1), Id: "valid-prefix" }, rawEpisode(0)];
    await expect(library.scanRoot("fixture")).rejects.toThrow("emby_episode_invalid_range");
    expect(database.db.select().from(libraryItems).all()).toEqual(items);
    expect(database.db.select().from(libraryEpisodes).all()).toEqual(episodes);
  });
});
