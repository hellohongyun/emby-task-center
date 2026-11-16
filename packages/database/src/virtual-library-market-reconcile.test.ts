import BetterSqlite3 from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { describe, expect, it } from "vitest";
import { schema } from "./schema";
import { reconcileVirtualLibraryMarket } from "./virtual-library-market-reconcile";

describe("market migration preserves libraries and initializes legacy subscriptions once", () => {
  it("keeps identities, source links and private ownership; never restores a later opt-out", () => {
    const sqlite = new BetterSqlite3(":memory:");
    try {
      sqlite.exec(`
        PRAGMA foreign_keys=ON;
        CREATE TABLE submission_users (id INTEGER PRIMARY KEY);
        INSERT INTO submission_users VALUES (1),(2);
        CREATE TABLE virtual_libraries (
          id TEXT PRIMARY KEY,name TEXT,owner_member_id INTEGER,collection_type TEXT,
          sort_order INTEGER,created_at TEXT,updated_at TEXT);
        INSERT INTO virtual_libraries VALUES ('public','公共',NULL,'mixed',3,'created','updated'),('private','私人',1,'movies',2,'created','updated');
        CREATE TABLE virtual_library_items (library_id TEXT,item_id TEXT);
        INSERT INTO virtual_library_items VALUES ('public','film-1'),('private','film-2');
        CREATE TABLE virtual_library_posters (library_id TEXT,content BLOB);
        INSERT INTO virtual_library_posters VALUES ('public',X'010203');
      `);
      const database = drizzle(sqlite, { schema });
      reconcileVirtualLibraryMarket(database);
      reconcileVirtualLibraryMarket(database);
      expect(
        sqlite.prepare("SELECT id,owner_member_id,owner_admin_id,published FROM virtual_libraries ORDER BY id").all(),
      ).toEqual([
        { id: "private", owner_member_id: 1, owner_admin_id: null, published: 0 },
        { id: "public", owner_member_id: null, owner_admin_id: "primary-admin", published: 1 },
      ]);
      expect(
        sqlite
          .prepare("SELECT subscriber_id,library_id FROM virtual_library_subscriptions ORDER BY subscriber_id")
          .all(),
      ).toEqual([
        { subscriber_id: "member:1", library_id: "public" },
        { subscriber_id: "member:2", library_id: "public" },
      ]);
      expect(sqlite.prepare("SELECT item_id FROM virtual_library_items ORDER BY item_id").all()).toEqual([
        { item_id: "film-1" },
        { item_id: "film-2" },
      ]);
      expect(sqlite.prepare("SELECT content FROM virtual_library_posters").get()).toEqual({
        content: Buffer.from([1, 2, 3]),
      });
      sqlite.exec(
        "UPDATE virtual_library_subscriptions SET enabled=0 WHERE subscriber_id='member:1'; INSERT INTO submission_users VALUES (3)",
      );
      reconcileVirtualLibraryMarket(database);
      expect(
        sqlite.prepare("SELECT enabled FROM virtual_library_subscriptions WHERE subscriber_id='member:1'").get(),
      ).toEqual({ enabled: 0 });
      expect(
        sqlite.prepare("SELECT COUNT(1) n FROM virtual_library_subscriptions WHERE subscriber_id='member:3'").get(),
      ).toEqual({ n: 0 });
    } finally {
      sqlite.close();
    }
  });
  it("rolls back column changes if a legacy migration cannot initialize subscriptions", () => {
    const sqlite = new BetterSqlite3(":memory:");
    try {
      sqlite.exec(
        "CREATE TABLE virtual_libraries (id TEXT PRIMARY KEY,owner_member_id INTEGER); CREATE TABLE submission_users (invalid TEXT)",
      );
      const database = drizzle(sqlite, { schema });
      expect(() => reconcileVirtualLibraryMarket(database)).toThrow();
      expect(
        sqlite
          .prepare("PRAGMA table_info(virtual_libraries)")
          .all()
          .map((row) => (row as { name: string }).name),
      ).toEqual(["id", "owner_member_id"]);
    } finally {
      sqlite.close();
    }
  });
});
