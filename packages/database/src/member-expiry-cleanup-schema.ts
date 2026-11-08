import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const memberExpiryCleanupPolicy = sqliteTable(
  "member_expiry_cleanup_policy",
  {
    id: integer("id").primaryKey(),
    days: integer("days"),
    serverId: text("server_id"),
    revision: text("revision").notNull(),
  },
  (table) => [
    check("member_expiry_cleanup_policy_singleton", sql`${table.id} = 1`),
    check("member_expiry_cleanup_policy_days", sql`${table.days} BETWEEN 1 AND 3650`),
  ],
);

export const memberExpiryCleanupJobs = sqliteTable(
  "member_expiry_cleanup_jobs",
  {
    memberId: integer("member_id").primaryKey(),
    serverId: text("server_id").notNull(),
    embyUserId: text("emby_user_id").notNull(),
    leaseToken: text("lease_token").notNull(),
    leaseUntil: integer("lease_until").notNull(),
  },
  (table) => [
    uniqueIndex("member_expiry_cleanup_jobs_account_idx").on(table.serverId, table.embyUserId),
    index("member_expiry_cleanup_jobs_lease_idx").on(table.leaseUntil),
  ],
);
