import { sql } from "drizzle-orm";
import type { AppDatabase } from "./client";

/** Accept explicit ISO instants only; invalid calendar dates are never normalized into eligibility. */
function historicalInstant(value: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return null;
  const [, y, m, d, h, minute, second] = match;
  const calendar = new Date(0);
  calendar.setUTCFullYear(Number(y), Number(m) - 1, Number(d));
  if (
    calendar.getUTCFullYear() !== Number(y) ||
    calendar.getUTCMonth() !== Number(m) - 1 ||
    calendar.getUTCDate() !== Number(d) ||
    Number(h) > 23 ||
    Number(minute) > 59 ||
    Number(second) > 59
  )
    return null;
  const instant = Date.parse(value);
  return Number.isFinite(instant) ? new Date(instant).toISOString() : null;
}

export function reconcileMediaRequests(database: AppDatabase): void {
  database.transaction(
    (tx) => {
      tx.run(sql`CREATE TABLE IF NOT EXISTS media_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      member_id INTEGER NOT NULL,
      member_email TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('request','supplement')),
      media_type TEXT NOT NULL CHECK(media_type IN ('movie','tv')),
      tmdb_id INTEGER NOT NULL CHECK(tmdb_id > 0),
      season_number INTEGER CHECK(season_number IS NULL OR season_number >= 0),
      title TEXT NOT NULL,
      original_title TEXT NOT NULL,
      release_year INTEGER,
      poster_url TEXT,
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','available','unavailable')),
      admin_note TEXT NOT NULL DEFAULT '',
      available_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`);
      const columns = tx.all<{ name: string }>(sql`PRAGMA table_info(media_requests)`);
      if (!columns.some((column) => column.name === "available_at")) {
        tx.run(sql`ALTER TABLE media_requests ADD COLUMN available_at TEXT`);
        const legacy = tx.all<{ id: number; updated_at: string }>(
          sql`SELECT id,updated_at FROM media_requests WHERE status = 'available'`,
        );
        for (const row of legacy) {
          const timestamp = historicalInstant(row.updated_at);
          if (timestamp) tx.run(sql`UPDATE media_requests SET available_at = ${timestamp} WHERE id = ${row.id}`);
        }
      }
      tx.run(sql`CREATE INDEX IF NOT EXISTS media_requests_member_idx ON media_requests(member_id,id)`);
      tx.run(sql`CREATE INDEX IF NOT EXISTS media_requests_status_idx ON media_requests(status,id)`);
      tx.run(sql`CREATE INDEX IF NOT EXISTS media_requests_available_idx ON media_requests(status,available_at)`);
      tx.run(sql`CREATE UNIQUE INDEX IF NOT EXISTS media_requests_active_identity_idx
      ON media_requests(member_id,media_type,tmdb_id,coalesce(season_number,-1))
      WHERE status IN ('pending','processing')`);
    },
    { behavior: "immediate" },
  );
}
