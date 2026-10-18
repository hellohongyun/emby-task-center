import BetterSqlite3 from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { schema } from "./schema";
import { reconcileVirtualLibraries } from "./virtual-libraries-reconcile";

describe("virtual library identity schema upgrade", () => {
  it("adds nullable TMDB identity to a populated legacy table without replacing rows", () => {
    const sqlite = new BetterSqlite3(":memory:");
    try {
      const database = drizzle(sqlite, { schema });
      database.run(sql`CREATE TABLE virtual_library_items (
        library_id TEXT NOT NULL, item_id TEXT NOT NULL, name TEXT NOT NULL,
        type TEXT NOT NULL, year INTEGER, image_tag TEXT, position INTEGER NOT NULL,
        PRIMARY KEY (library_id, item_id)
      )`);
      database.run(
        sql`INSERT INTO virtual_library_items VALUES ('library', 'old', '原剧集', 'Series', 2023, 'tag', 7)`,
      );
      reconcileVirtualLibraries(database);
      reconcileVirtualLibraries(database);
      expect(database.get(sql`SELECT * FROM virtual_library_items`)).toEqual({
        library_id: "library",
        item_id: "old",
        name: "原剧集",
        type: "Series",
        year: 2023,
        image_tag: "tag",
        position: 7,
        tmdb_id: null,
      });
      const columns = database.all<{ name: string }>(sql`PRAGMA table_info(virtual_library_items)`);
      expect(columns.filter((column) => column.name === "tmdb_id")).toHaveLength(1);
    } finally {
      sqlite.close();
    }
  });
});
