import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDatabase, type DatabaseHandle } from "@emby-task-center/database/client";
import { libraryEpisodes, libraryItems, libraryScanRuns, mediaRoots } from "@emby-task-center/database/schema";
import type { EmbyClient } from "../integrations/emby-client";
import { embyEpisodeNumbers } from "../integrations/emby-episode-range";
import { createEmbyLibraryReader } from "../integrations/emby-library-reader";
import { createEmbyScan } from "./emby-scanner";
import { createLibraryService } from "./service";

const special = (id: string, fields: Record<string, unknown> = {}) => ({
  Id: id,
  Type: "Episode",
  Name: "特别篇",
  ParentIndexNumber: 0,
  ...fields,
});
const combined = { Id: "combined", Type: "Episode", ParentIndexNumber: 1, IndexNumber: 1, IndexNumberEnd: 2 };
const series = (id: string) => ({ id, name: "特别篇测试", type: "tv" as const, year: 2020, tmdbId: 100 });
function readerFor(items: Record<string, unknown>[]) {
  return createEmbyLibraryReader(async () => ({ Items: items, TotalRecordCount: items.length }));
}
function scanFor(itemsBySeries: Record<string, Record<string, unknown>[]>) {
  const reader = createEmbyLibraryReader(async (params) => {
    const items = itemsBySeries[params.get("ParentId")!]!;
    return { Items: items, TotalRecordCount: items.length };
  });
  return createEmbyScan({
    configured: true,
    listLibraryItems: async () => Object.keys(itemsBySeries).map(series),
    listItemEpisodes: reader.listItemEpisodes,
  } as unknown as EmbyClient);
}

describe("Emby unnumbered season-zero specials", () => {
  let database: DatabaseHandle | undefined;
  let directory: string | undefined;
  afterEach(() => {
    database?.close();
    database = undefined;
    if (directory) rmSync(directory, { recursive: true, force: true });
    directory = undefined;
  });

  it.each([{}, { IndexNumber: null }, { IndexNumberEnd: null }, { IndexNumber: null, IndexNumberEnd: null }])(
    "accepts only explicit S00 with both episode bounds absent: %j",
    async (fields) => {
      const episodes = await readerFor([special("special", fields)]).listItemEpisodes("show");
      expect(episodes).toHaveLength(1);
      expect(episodes[0]).toMatchObject({ id: "special", seasonNumber: 0, episodeNumber: null });
      expect(embyEpisodeNumbers(episodes[0]!)).toEqual([]);
    },
  );

  it.each([
    { ParentIndexNumber: 1 },
    { ParentIndexNumber: null },
    { ParentIndexNumber: undefined },
    { ParentIndexNumber: "0" },
    { IndexNumber: -1 },
    { IndexNumber: "1" },
    { IndexNumber: 1.5 },
    { IndexNumberEnd: 2 },
    { IndexNumber: null, IndexNumberEnd: 2 },
    { IndexNumber: null, IndexNumberEnd: "2" },
    { IndexNumber: null, IndexNumberEnd: -1 },
  ])("rejects malformed regular episodes and invalid S00 bounds atomically: %j", async (fields) => {
    const reader = readerFor([combined, special("invalid", fields)]);
    await expect(reader.listItemEpisodes("show")).rejects.toThrow(/emby_episode_invalid_/);
  });

  it("retains numbered season-zero episodes and expands regular combined files", async () => {
    const episodes = await readerFor([special("zero", { IndexNumber: 0 }), combined]).listItemEpisodes("show");
    expect(episodes[0]).toMatchObject({ seasonNumber: 0, episodeNumber: 0 });
    expect(embyEpisodeNumbers(episodes[0]!)).toEqual([0]);
    expect(embyEpisodeNumbers(episodes[1]!)).toEqual([1, 2]);
  });

  it.each([
    { seasonNumber: 1, episodeNumber: null },
    { seasonNumber: null, episodeNumber: null },
    { seasonNumber: 0, episodeNumber: null, episodeNumberEnd: 1 },
    { seasonNumber: 0, episodeNumber: -1 },
    { seasonNumber: 0, episodeNumber: "1" },
    { seasonNumber: 0, episodeNumber: 1, episodeNumberEnd: 0 },
  ])("range helper remains strict for non-special and malformed inputs: %j", (episode) => {
    expect(() => embyEpisodeNumbers(episode as Parameters<typeof embyEpisodeNumbers>[0])).toThrow(
      /emby_episode_invalid_/,
    );
  });

  it("retains different unnumbered special IDs while deduplicating the same real file", async () => {
    const scan = scanFor({
      a: [special("special-a"), combined],
      b: [special("special-a"), special("special-b", { IndexNumber: null })],
    });
    const batch = await scan("emby:fixture");
    expect(batch.complete).toBe(true);
    expect(batch.items).toHaveLength(3);
    expect(batch.items.map((item) => item.embyItemId).sort()).toEqual(["combined", "special-a", "special-b"]);
    expect(new Set(batch.items.map((item) => item.relativePath)).size).toBe(3);
    for (const item of batch.items.filter((item) => item.embyItemId?.startsWith("special-"))) {
      expect(item.identity).toMatchObject({
        episodeNumbers: [],
        absoluteEpisodeNumbers: [],
        warning: "emby_special_episode_number_missing",
      });
      expect([null, 0]).toContain(item.identity.parsedSeason);
      expect([null, 0]).toContain(item.identity.physicalSeason);
    }
    expect(batch.items.find((item) => item.embyItemId === "combined")!.identity).toMatchObject({
      parsedSeason: 1,
      episodeNumbers: [1, 2],
      warning: null,
    });
  });

  it("persists unnumbered files without fabricating episode zero or disturbing normal episode rows", async () => {
    directory = mkdtempSync(join(tmpdir(), "emby-unnumbered-specials-"));
    const filePath = join(directory, "inventory.db");
    database = createDatabase(filePath);
    const scan = scanFor({ a: [special("special-a"), special("special-b"), combined] });
    const library = createLibraryService(
      [{ id: "fixture", name: "测试库", mediaType: "tv", path: "emby:fixture" }],
      scan,
      database.db,
    );
    await library.scanRoot("fixture");
    const before = database.db.select().from(libraryItems).all();
    expect(before).toHaveLength(3);
    expect(before.filter((row) => row.scanWarning === "emby_special_episode_number_missing")).toHaveLength(2);
    expect(database.db.select().from(mediaRoots).get()).toMatchObject({ lastScanStatus: "completed" });
    expect(database.db.select().from(libraryScanRuns).get()).toMatchObject({ discoveredCount: 3, error: null });
    const numbered = database.db.select().from(libraryEpisodes).all();
    expect(numbered).toHaveLength(2);
    expect(numbered.map((row) => row.episodeNumber).sort()).toEqual([1, 2]);
    expect(numbered.every((row) => row.parsedSeason === 1)).toBe(true);
    expect(new Set(numbered.map((row) => row.libraryItemId))).toEqual(
      new Set([before.find((row) => row.embyItemId === "combined")!.id]),
    );

    await library.scanRoot("fixture");
    expect(
      database.db
        .select()
        .from(libraryItems)
        .all()
        .map((row) => row.id),
    ).toEqual(before.map((row) => row.id));
    expect(database.db.select().from(libraryEpisodes).all()).toEqual(numbered);
    database.close();
    database = createDatabase(filePath);
    expect(database.db.select().from(libraryItems).all()).toHaveLength(3);
    expect(
      database.db
        .select()
        .from(libraryEpisodes)
        .all()
        .map((row) => row.episodeNumber)
        .sort(),
    ).toEqual([1, 2]);
  });
});
