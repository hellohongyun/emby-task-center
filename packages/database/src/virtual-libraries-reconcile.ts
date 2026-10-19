import { sql } from "drizzle-orm";
import type { AppDatabase } from "./client";

export function reconcileVirtualLibraries(database: AppDatabase): void {
  database.run(sql`CREATE TABLE IF NOT EXISTS virtual_libraries (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    collection_type TEXT NOT NULL DEFAULT 'mixed',
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  database.run(sql`CREATE TABLE IF NOT EXISTS virtual_library_items (
    library_id TEXT NOT NULL REFERENCES virtual_libraries(id) ON DELETE CASCADE,
    item_id TEXT NOT NULL,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    year INTEGER,
    image_tag TEXT,
    tmdb_id TEXT,
    position INTEGER NOT NULL,
    PRIMARY KEY (library_id, item_id)
  )`);
  const columns = database.all<{ name: string }>(sql`PRAGMA table_info(virtual_library_items)`);
  if (!columns.some((column) => column.name === "tmdb_id")) {
    database.run(sql`ALTER TABLE virtual_library_items ADD COLUMN tmdb_id TEXT`);
  }
  database.run(sql`CREATE INDEX IF NOT EXISTS virtual_library_items_item_idx ON virtual_library_items(item_id)`);
  database.run(sql`CREATE TABLE IF NOT EXISTS virtual_library_posters (
    library_id TEXT PRIMARY KEY NOT NULL REFERENCES virtual_libraries(id) ON DELETE CASCADE,
    content BLOB NOT NULL,
    content_type TEXT NOT NULL,
    width INTEGER NOT NULL,
    height INTEGER NOT NULL,
    image_tag TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
}
