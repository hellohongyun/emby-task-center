import { blob, index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const virtualLibraries = sqliteTable("virtual_libraries", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  collectionType: text("collection_type", { enum: ["movies", "tvshows", "mixed"] })
    .notNull()
    .default("mixed"),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const virtualLibraryItems = sqliteTable(
  "virtual_library_items",
  {
    libraryId: text("library_id")
      .notNull()
      .references(() => virtualLibraries.id, { onDelete: "cascade" }),
    itemId: text("item_id").notNull(),
    name: text("name").notNull(),
    type: text("type").notNull(),
    year: integer("year"),
    imageTag: text("image_tag"),
    tmdbId: text("tmdb_id"),
    position: integer("position").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.libraryId, table.itemId] }),
    index("virtual_library_items_item_idx").on(table.itemId),
  ],
);

export const virtualLibraryPosters = sqliteTable("virtual_library_posters", {
  libraryId: text("library_id")
    .primaryKey()
    .references(() => virtualLibraries.id, { onDelete: "cascade" }),
  content: blob("content", { mode: "buffer" }).notNull(),
  contentType: text("content_type", { enum: ["image/jpeg", "image/png", "image/webp"] }).notNull(),
  width: integer("width").notNull(),
  height: integer("height").notNull(),
  imageTag: text("image_tag").notNull(),
  updatedAt: text("updated_at").notNull(),
});
