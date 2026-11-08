import { sql } from "drizzle-orm";
import type { AppDatabase } from "./client";

export function reconcileRenewalOutbox(database: AppDatabase): void {
  database.run(sql`CREATE TABLE IF NOT EXISTS renewal_email_outbox (
    key TEXT PRIMARY KEY NOT NULL, email TEXT NOT NULL, subject TEXT NOT NULL,
    text TEXT NOT NULL, html TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT NOT NULL, lease_token TEXT, lease_until TEXT,
    sent_at TEXT, last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`);
  database.run(sql`CREATE INDEX IF NOT EXISTS renewal_email_outbox_due_idx
    ON renewal_email_outbox(sent_at,next_attempt_at)`);
}
