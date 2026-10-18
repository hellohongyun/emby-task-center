import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabase, type DatabaseHandle } from "@emby-task-center/database/client";
import { libraryItems, libraryScanRuns, mediaRoots } from "@emby-task-center/database/schema";
import { createLibraryService } from "./service";
import type { ScannedMediaItem, ScanOutput } from "./scan-types";

const root = { id: "fixture", name: "测试库", mediaType: "movie" as const, path: "emby:fixture" };
const movie = (id: string): ScannedMediaItem => ({
  relativePath: `电影 ${id}/电影 ${id}.strm`,
  embyItemId: id,
  identity: {
    physicalSeason: null,
    parsedSeason: null,
    episodeNumbers: [],
    absoluteEpisodeNumbers: [],
    numberingMode: "unresolved",
    warning: null,
  },
});
describe("scan completeness safeguards", () => {
  let database: DatabaseHandle;
  let output: ScanOutput;
  beforeEach(() => {
    database = createDatabase(":memory:");
    output = { items: [movie("a"), movie("b")], complete: true };
  });
  afterEach(() => database.close());
  const service = () => createLibraryService([root], async () => output, database.db);

  it("preserves unseen records for legacy array results, even if nonempty", async () => {
    const library = service();
    await library.scanRoot(root.id);
    output = [movie("a")];
    await library.scanRoot(root.id);
    expect(
      database.db
        .select()
        .from(libraryItems)
        .all()
        .map((r) => r.embyItemId),
    ).toEqual(["a", "b"]);
  });
  it("rejects explicit incomplete batches without overwriting any inventory", async () => {
    const library = service();
    await library.scanRoot(root.id);
    const before = database.db.select().from(libraryItems).all();
    output = { items: [{ ...movie("a"), relativePath: "截断/改名.strm" }], complete: false };
    await expect(library.scanRoot(root.id)).rejects.toThrow("library_scan_incomplete");
    expect(database.db.select().from(libraryItems).all()).toEqual(before);
    expect(database.db.select().from(mediaRoots).get()?.lastScanStatus).toBe("failed");
    expect(database.db.select().from(libraryScanRuns).all()).toHaveLength(2);
  });
  it("allows cleanup only after a certified complete nonempty scan", async () => {
    const library = service();
    await library.scanRoot(root.id);
    output = { items: [movie("a")], complete: true };
    await library.scanRoot(root.id);
    expect(
      database.db
        .select()
        .from(libraryItems)
        .all()
        .map((r) => r.embyItemId),
    ).toEqual(["a"]);
  });
  it("retains the existing protection against empty-result cleanup", async () => {
    const library = service();
    await library.scanRoot(root.id);
    output = { items: [], complete: true };
    await library.scanRoot(root.id);
    expect(database.db.select().from(libraryItems).all()).toHaveLength(2);
  });
});
