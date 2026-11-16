import { sql } from "drizzle-orm";
import type { AppDatabase } from "./client";

export function reconcileUpstreamLibraryMarket(database: AppDatabase) {
  database.transaction(() => {
    database.run(sql`CREATE TABLE IF NOT EXISTS upstream_virtual_libraries (
      id TEXT PRIMARY KEY, upstream TEXT NOT NULL, source_id TEXT NOT NULL, source_guid TEXT,
      name TEXT NOT NULL, collection_type TEXT NOT NULL DEFAULT 'mixed',
      poster_image_tag TEXT, poster_aspect_ratio REAL,
      published INTEGER NOT NULL DEFAULT 1, available INTEGER NOT NULL DEFAULT 1,
      publication_version INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`);
    database.run(sql`CREATE UNIQUE INDEX IF NOT EXISTS upstream_virtual_libraries_source_idx
      ON upstream_virtual_libraries (upstream, source_id)`);
    database.run(sql`CREATE INDEX IF NOT EXISTS upstream_virtual_libraries_upstream_idx
      ON upstream_virtual_libraries (upstream)`);
    database.run(sql`CREATE TABLE IF NOT EXISTS upstream_virtual_library_subscriptions (
      subscriber_id TEXT NOT NULL, library_id TEXT NOT NULL REFERENCES upstream_virtual_libraries(id) ON DELETE CASCADE,
      publication_version INTEGER NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL,
      PRIMARY KEY (subscriber_id, library_id)
    )`);
  });
}
