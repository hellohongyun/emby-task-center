import { sql } from "drizzle-orm";
import type { AppDatabase } from "./client";

export function reconcileShare115(database: AppDatabase): void {
  database.transaction(
    (tx) => {
      tx.run(sql`CREATE TABLE IF NOT EXISTS share_115_transfer_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        share_url TEXT NOT NULL,
        share_code TEXT NOT NULL,
        access_code TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'queued'
          CONSTRAINT share_115_jobs_status_check
          CHECK(status IN ('queued','running','saved','already_exists','failed','unconfirmed')),
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT NOT NULL,
        lease_expires_at TEXT,
        target_folder_id TEXT,
        result_code TEXT,
        result_message TEXT,
        share_title TEXT,
        identified_media_json TEXT
      )`);
      tx.run(sql`CREATE TABLE IF NOT EXISTS share_115_submissions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        member_id INTEGER NOT NULL,
        member_email TEXT NOT NULL,
        admin_username TEXT,
        job_id INTEGER NOT NULL REFERENCES share_115_transfer_jobs(id),
        note TEXT NOT NULL DEFAULT '',
        submitted_at TEXT NOT NULL
      )`);
      const submissionColumns = tx.all<{ name: string }>(sql`PRAGMA table_info(share_115_submissions)`);
      if (!submissionColumns.some(({ name }) => name === "admin_username")) {
        tx.run(sql`ALTER TABLE share_115_submissions ADD COLUMN admin_username TEXT`);
      }
      tx.run(sql`CREATE INDEX IF NOT EXISTS share_115_jobs_due_idx
        ON share_115_transfer_jobs(status,next_attempt_at,id)`);
      tx.run(sql`CREATE UNIQUE INDEX IF NOT EXISTS share_115_jobs_active_share_idx
        ON share_115_transfer_jobs(share_code,access_code)
        WHERE status IN ('queued','running','unconfirmed')`);
      tx.run(sql`CREATE INDEX IF NOT EXISTS share_115_submissions_member_idx
        ON share_115_submissions(member_id,submitted_at,id)`);
      tx.run(sql`CREATE INDEX IF NOT EXISTS share_115_submissions_time_idx
        ON share_115_submissions(submitted_at,id)`);
      tx.run(sql`CREATE UNIQUE INDEX IF NOT EXISTS share_115_submissions_job_member_idx
        ON share_115_submissions(job_id,member_id)`);
    },
    { behavior: "immediate" },
  );
}
