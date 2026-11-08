import { sql } from "drizzle-orm";
import type { AppDatabase } from "./client";

export function reconcileMemberExpiryCleanup(database: AppDatabase) {
  database.run(sql`CREATE TABLE IF NOT EXISTS member_expiry_cleanup_policy (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    days INTEGER CHECK (days BETWEEN 1 AND 3650),
    server_id TEXT,
    revision TEXT NOT NULL
  )`);
  database.run(sql`CREATE TABLE IF NOT EXISTS member_expiry_cleanup_jobs (
    member_id INTEGER PRIMARY KEY,
    server_id TEXT NOT NULL,
    emby_user_id TEXT NOT NULL,
    lease_token TEXT NOT NULL,
    lease_until INTEGER NOT NULL
  )`);
  database.run(sql`CREATE UNIQUE INDEX IF NOT EXISTS member_expiry_cleanup_jobs_account_idx
    ON member_expiry_cleanup_jobs (server_id, emby_user_id)`);
  database.run(sql`CREATE INDEX IF NOT EXISTS member_expiry_cleanup_jobs_lease_idx
    ON member_expiry_cleanup_jobs (lease_until)`);
}
