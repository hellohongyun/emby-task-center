import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { virtualLibraries } from "./virtual-libraries-schema";

/** Subscriber identity may belong to a member or the explicit administrator principal. */
export const virtualLibrarySubscriptions = sqliteTable(
  "virtual_library_subscriptions",
  {
    subscriberId: text("subscriber_id").notNull(),
    libraryId: text("library_id")
      .notNull()
      .references(() => virtualLibraries.id, { onDelete: "cascade" }),
    publicationVersion: integer("publication_version").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.subscriberId, table.libraryId] })],
);

export const virtualLibraryUserOrders = sqliteTable(
  "virtual_library_user_orders",
  {
    upstream: text("upstream").notNull(),
    userId: text("user_id").notNull(),
    order: text("order_json", { mode: "json" }).$type<string[]>().notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.upstream, table.userId] })],
);
