import BetterSqlite3 from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { expect, it } from "vitest";
import { reconcileMemberExpiryCleanup } from "./member-expiry-cleanup-reconcile";
import { memberExpiryCleanupJobs, memberInactivityCleanupPolicy, schema } from "./schema";

it("keeps pre-upgrade cleanup jobs assigned to the expiry rule", () => {
  const sqlite = new BetterSqlite3(":memory:");
  try {
    sqlite.exec(`CREATE TABLE member_expiry_cleanup_jobs (
      member_id INTEGER PRIMARY KEY,
      server_id TEXT NOT NULL,
      emby_user_id TEXT NOT NULL,
      lease_token TEXT NOT NULL,
      lease_until INTEGER NOT NULL
    );
    INSERT INTO member_expiry_cleanup_jobs VALUES (1, 'server', 'user', 'lease', 123);`);
    const database = drizzle(sqlite, { schema });
    reconcileMemberExpiryCleanup(database);
    reconcileMemberExpiryCleanup(database);
    expect(database.select().from(memberExpiryCleanupJobs).get()).toEqual({
      memberId: 1,
      serverId: "server",
      embyUserId: "user",
      leaseToken: "lease",
      leaseUntil: 123,
      kind: "expiry",
    });
    expect(database.select().from(memberInactivityCleanupPolicy).get()).toBeUndefined();
  } finally {
    sqlite.close();
  }
});
