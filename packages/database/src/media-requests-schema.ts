import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const mediaRequests = sqliteTable(
  "media_requests",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    // Preserve history after member deletion, while a recreated email has a new identity.
    memberId: integer("member_id").notNull(),
    memberEmail: text("member_email").notNull(),
    kind: text("kind", { enum: ["request", "supplement"] }).notNull(),
    mediaType: text("media_type", { enum: ["movie", "tv"] }).notNull(),
    tmdbId: integer("tmdb_id").notNull(),
    seasonNumber: integer("season_number"),
    title: text("title").notNull(),
    originalTitle: text("original_title").notNull(),
    releaseYear: integer("release_year"),
    posterUrl: text("poster_url"),
    description: text("description").notNull().default(""),
    status: text("status", { enum: ["pending", "processing", "available", "unavailable"] })
      .notNull()
      .default("pending"),
    adminNote: text("admin_note").notNull().default(""),
    availableAt: text("available_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("media_requests_member_idx").on(table.memberId, table.id),
    index("media_requests_status_idx").on(table.status, table.id),
    index("media_requests_available_idx").on(table.status, table.availableAt),
    uniqueIndex("media_requests_active_identity_idx")
      .on(table.memberId, table.mediaType, table.tmdbId, sql`coalesce(${table.seasonNumber}, -1)`)
      .where(sql`${table.status} IN ('pending', 'processing')`),
  ],
);
