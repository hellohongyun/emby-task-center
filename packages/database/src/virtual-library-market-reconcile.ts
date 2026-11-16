import { sql } from "drizzle-orm";
import type { AppDatabase } from "./client";

/** No network calls: keep source data intact and migrate legacy public visibility once. */
export function reconcileVirtualLibraryMarket(database: AppDatabase): void {
  database.transaction(() => reconcile(database));
}

function reconcile(database: AppDatabase): void {
  const columns = database.all<{ name: string }>(sql`PRAGMA table_info(virtual_libraries)`);
  const has = (name: string) => columns.some((column) => column.name === name);
  const legacy = !has("owner_admin_id");
  if (legacy) database.run(sql`ALTER TABLE virtual_libraries ADD COLUMN owner_admin_id TEXT`);
  if (!has("published"))
    database.run(sql`ALTER TABLE virtual_libraries ADD COLUMN published INTEGER NOT NULL DEFAULT 0`);
  if (!has("publication_version"))
    database.run(sql`ALTER TABLE virtual_libraries ADD COLUMN publication_version INTEGER NOT NULL DEFAULT 0`);
  database.run(sql`CREATE TABLE IF NOT EXISTS virtual_library_subscriptions (
    subscriber_id TEXT NOT NULL,
    library_id TEXT NOT NULL REFERENCES virtual_libraries(id) ON DELETE CASCADE,
    publication_version INTEGER NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (subscriber_id, library_id)
  )`);
  database.run(sql`CREATE TABLE IF NOT EXISTS virtual_library_user_orders (
    upstream TEXT NOT NULL,
    user_id TEXT NOT NULL,
    order_json TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (upstream, user_id)
  )`);
  if (!legacy) return;
  database.transaction(() => {
    database.run(sql`UPDATE virtual_libraries SET owner_admin_id='primary-admin',published=1
      WHERE owner_member_id IS NULL`);
    const members = database.get(sql`SELECT 1 FROM sqlite_master WHERE type='table' AND name='submission_users'`);
    if (members)
      database.run(sql`INSERT OR IGNORE INTO virtual_library_subscriptions
      (subscriber_id,library_id,publication_version,enabled,updated_at)
      SELECT 'member:' || u.id,l.id,l.publication_version,1,strftime('%Y-%m-%dT%H:%M:%fZ','now')
      FROM submission_users u CROSS JOIN virtual_libraries l
      WHERE l.owner_admin_id='primary-admin' AND l.published=1`);
  });
}
