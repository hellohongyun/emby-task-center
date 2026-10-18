import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabase, type DatabaseHandle } from "@emby-task-center/database/client";
import { libraryEpisodes, libraryItems, libraryScanRuns } from "@emby-task-center/database/schema";
import { synchronizeRoots } from "./root-state";
import { persistScan } from "./scan-persistence";
import type { LibraryRootConfig } from "./service";
import type { ScannedMediaItem } from "./scan-types";

const root: LibraryRootConfig = { id: "tv", name: "电视剧", mediaType: "tv", path: "emby:fixture-tv" };
const firstAt = "2026-09-29T00:00:00.000Z";
const nextAt = "2026-09-30T00:00:00.000Z";

function episode(number: number): ScannedMediaItem {
  return {
    relativePath: `Fixture/Season 01/Fixture S01E0${number}.strm`,
    embyItemId: `episode-${number}`,
    tmdbId: 70523,
    sourceTitleHint: "Fixture",
    sourceYearHint: 2017,
    posterPath: "emby:series-1",
    identity: {
      physicalSeason: 1,
      parsedSeason: 1,
      numberingMode: "seasonal",
      episodeNumbers: [number],
      absoluteEpisodeNumbers: [],
      warning: null,
    },
  };
}

describe("differential scan persistence", () => {
  let handle: DatabaseHandle;
  let initial: ScannedMediaItem[];

  beforeEach(() => {
    handle = createDatabase(":memory:");
    synchronizeRoots(handle.db, [root]);
    initial = [episode(1), episode(2)];
    persistScan(handle.db, root, initial, firstAt, [root]);
    handle.db.run(sql`CREATE TABLE scan_write_audit (table_name TEXT, operation TEXT, row_id INTEGER)`);
    // 用 SQLite 触发器记录实际写入；仅比较最终值无法发现「值没变但仍全量 UPDATE」的回退。
    for (const table of ["library_items", "library_episodes"]) {
      for (const operation of ["INSERT", "UPDATE", "DELETE"]) {
        const record = operation === "DELETE" ? "OLD" : "NEW";
        handle.db.run(
          sql.raw(`CREATE TRIGGER audit_${table}_${operation} AFTER ${operation} ON ${table}
          BEGIN INSERT INTO scan_write_audit VALUES ('${table}', '${operation}', ${record}.id); END`),
        );
      }
    }
  });

  afterEach(() => handle.close());

  const snapshot = () => ({
    items: handle.db.select().from(libraryItems).all(),
    episodes: handle.db.select().from(libraryEpisodes).all(),
  });
  const writes = () =>
    handle.db.all<{ table_name: string; operation: string; row_id: number }>(sql`SELECT * FROM scan_write_audit`);

  it("does not write either inventory table for identical scans and preserves ids and timestamps", () => {
    const before = snapshot();
    persistScan(handle.db, root, structuredClone(initial), nextAt, [root]);
    expect(writes()).toEqual([]);
    expect(snapshot()).toEqual(before);
    expect(handle.db.select().from(libraryScanRuns).all()).toHaveLength(2);
  });

  it("updates only the changed poster row without rebuilding any episodes", () => {
    const before = snapshot();
    const updated = structuredClone(initial);
    updated[0]!.posterPath = "emby:new-poster";
    persistScan(handle.db, root, updated, nextAt, [root]);
    const after = snapshot();
    expect(writes()).toEqual([{ table_name: "library_items", operation: "UPDATE", row_id: before.items[0]!.id }]);
    expect(after.episodes).toEqual(before.episodes);
    expect(after.items[1]).toEqual(before.items[1]);
    expect(after.items[0]).toEqual({ ...before.items[0], posterPath: "emby:new-poster", updatedAt: nextAt });
  });

  it("changes episode identities only for the affected item", () => {
    const before = snapshot();
    const updated = structuredClone(initial);
    updated[0]!.identity.episodeNumbers = [3];
    persistScan(handle.db, root, updated, nextAt, [root]);
    const after = snapshot();
    const changedId = before.items[0]!.id;
    const untouchedId = before.items[1]!.id;
    expect(after.items).toEqual(before.items);
    expect(after.episodes.filter((row) => row.libraryItemId === untouchedId)).toEqual(
      before.episodes.filter((row) => row.libraryItemId === untouchedId),
    );
    expect(after.episodes.filter((row) => row.libraryItemId === changedId)).toMatchObject([
      { episodeNumber: 3, parsedSeason: 1, createdAt: nextAt },
    ]);
    expect(writes().map(({ table_name, operation }) => ({ table_name, operation }))).toEqual([
      { table_name: "library_episodes", operation: "DELETE" },
      { table_name: "library_episodes", operation: "INSERT" },
    ]);
  });

  it("keeps the same library row and episodes when Emby renames an item", () => {
    const before = snapshot();
    const updated = structuredClone(initial);
    updated[0]!.relativePath = "Renamed/Season 01/Renamed S01E01.strm";
    updated[0]!.sourceTitleHint = "Renamed";
    persistScan(handle.db, root, updated, nextAt, [root]);
    const after = snapshot();
    expect(after.items[0]).toEqual({
      ...before.items[0],
      relativePath: updated[0]!.relativePath,
      sourceTitle: "Renamed",
      updatedAt: nextAt,
    });
    expect(after.items[1]).toEqual(before.items[1]);
    expect(after.episodes).toEqual(before.episodes);
    expect(writes()).toEqual([{ table_name: "library_items", operation: "UPDATE", row_id: before.items[0]!.id }]);
  });
});
