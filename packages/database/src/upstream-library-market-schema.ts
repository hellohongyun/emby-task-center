import { index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/** External libraries remain upstream-owned; no local content associations are created. */
export const upstreamVirtualLibraries = sqliteTable(
  "upstream_virtual_libraries",
  {
    id: text("id").primaryKey(),
    upstream: text("upstream").notNull(),
    sourceId: text("source_id").notNull(),
    sourceGuid: text("source_guid"),
    name: text("name").notNull(),
    collectionType: text("collection_type", { enum: ["movies", "tvshows", "mixed"] })
      .notNull()
      .default("mixed"),
    posterImageTag: text("poster_image_tag"),
    posterAspectRatio: real("poster_aspect_ratio"),
    published: integer("published", { mode: "boolean" }).notNull().default(true),
    available: integer("available", { mode: "boolean" }).notNull().default(true),
    publicationVersion: integer("publication_version").notNull().default(0),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("upstream_virtual_libraries_source_idx").on(table.upstream, table.sourceId),
    index("upstream_virtual_libraries_upstream_idx").on(table.upstream),
  ],
);

export const upstreamVirtualLibrarySubscriptions = sqliteTable(
  "upstream_virtual_library_subscriptions",
  {
    subscriberId: text("subscriber_id").notNull(),
    libraryId: text("library_id")
      .notNull()
      .references(() => upstreamVirtualLibraries.id, { onDelete: "cascade" }),
    publicationVersion: integer("publication_version").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.subscriberId, table.libraryId] })],
);
