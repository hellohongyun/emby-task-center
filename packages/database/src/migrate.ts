import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { migrate as runMigrations } from "drizzle-orm/better-sqlite3/migrator";
import { applyPostMigrationReconciliation } from "./reconcile";
import type { AppDatabase } from "./client";

const defaultMigrationsFolder = resolve(dirname(fileURLToPath(import.meta.url)), "../drizzle");
const duplicateRemediationMessage =
  "Duplicate library episode identities block migration. Rebuild derived library inventory " +
  "(library_items and library_episodes) and run a rescan; do not delete media_items or media_tasks.";

function hasDuplicateEpisodeIdentities(database: AppDatabase): boolean {
  const table = database.get<{ present: number }>(sql`
    SELECT 1 AS present
    FROM sqlite_master
    WHERE type = 'table' AND name = 'library_episodes'
  `);
  if (!table) return false;

  return Boolean(
    database.get<{ duplicate: number }>(sql`
      SELECT 1 AS duplicate
      FROM library_episodes
      WHERE library_item_id IS NOT NULL
        AND parsed_season IS NOT NULL
        AND episode_number IS NOT NULL
        AND absolute_episode_number IS NOT NULL
      GROUP BY library_item_id, parsed_season, episode_number, absolute_episode_number
      HAVING COUNT(*) > 1
      LIMIT 1
    `),
  );
}

export function migrate(database: AppDatabase, migrationsFolder = defaultMigrationsFolder): void {
  if (hasDuplicateEpisodeIdentities(database)) {
    throw new Error(duplicateRemediationMessage);
  }
  // Drizzle runs every migration inside a single transaction. SQLite only allows
  // changing PRAGMA foreign_keys outside a transaction, so table rebuilds that
  // drop and recreate an FK-parent table (e.g. 0011 media_items) cannot turn FK
  // checks off from inside the migration SQL. Disable enforcement around the
  // whole migration run instead, then re-enable and verify integrity.
  database.run(sql`PRAGMA foreign_keys = OFF`);
  try {
    runMigrations(database, { migrationsFolder });
  } finally {
    database.run(sql`PRAGMA foreign_keys = ON`);
  }
  // 迁移后对账（P5：已拆到 reconcile.ts，建表/补列/种子数据都在那里）。
  applyPostMigrationReconciliation(database);

  const violations = database.all<{ table: string; rowid: number; parent: string; fkid: number }>(
    sql`PRAGMA foreign_key_check`,
  );
  if (violations.length > 0) {
    throw new Error(`Foreign key check failed after migrations: ${JSON.stringify(violations.slice(0, 5))}`);
  }
}
