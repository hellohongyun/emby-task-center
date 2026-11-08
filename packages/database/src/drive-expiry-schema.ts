import { sql } from "drizzle-orm";
import { check, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const driveExpirySettings = sqliteTable(
  "drive_expiry_settings",
  {
    id: integer("id").primaryKey(),
    date: text("date").notNull(),
    expiresAt: text("expires_at").notNull(),
  },
  (table) => [check("drive_expiry_settings_singleton", sql`${table.id} = 1`)],
);
