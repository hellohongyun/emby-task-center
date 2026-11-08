import { sql } from "drizzle-orm";
import type { AppDatabase } from "./client";

export function reconcileDriveExpiry(database: AppDatabase): void {
  database.transaction((tx) => {
    tx.run(sql`CREATE TABLE IF NOT EXISTS drive_expiry_settings (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      date TEXT NOT NULL,
      expires_at TEXT NOT NULL
    )`);
    const columns = tx.all<{ name: string }>(sql`PRAGMA table_info(submission_users)`);
    if (columns.length === 0) return;
    if (!columns.some((column) => column.name === "deferred_membership_ms")) {
      tx.run(sql`ALTER TABLE submission_users ADD COLUMN deferred_membership_ms INTEGER NOT NULL DEFAULT 0`);
    }
    if (!columns.some((column) => column.name === "follows_drive_expiry")) {
      tx.run(sql`ALTER TABLE submission_users ADD COLUMN follows_drive_expiry INTEGER NOT NULL DEFAULT 0`);
    }
    if (!columns.some((column) => column.name === "drive_expiry_sync_pending")) {
      tx.run(sql`ALTER TABLE submission_users ADD COLUMN drive_expiry_sync_pending INTEGER NOT NULL DEFAULT 0`);
    }
  });
}
