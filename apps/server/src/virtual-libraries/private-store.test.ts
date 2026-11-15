import { afterEach, describe, expect, it } from "vitest";
import { createDatabase } from "@emby-task-center/database/client";
import { migrate } from "@emby-task-center/database/migrate";
import { sql } from "drizzle-orm";
import { createVirtualLibraryStore } from "./store";

const database = createDatabase(":memory:");
afterEach(() => database.close());
describe("private virtual library scopes", () => {
  it("isolates reads and mutations and preserves public libraries across reconciliation", () => {
    const publicStore = createVirtualLibraryStore(database.db);
    const alice = createVirtualLibraryStore(database.db, { ownerMemberId: 1 });
    const bob = createVirtualLibraryStore(database.db, { ownerMemberId: 2 });
    const common = publicStore.create({ name: "公共" });
    const privateLibrary = alice.create({ name: "私人", sortOrder: 2 });
    const item = { itemId: "movie", name: "影片", type: "Movie", year: null, imageTag: null };
    alice.addItems(privateLibrary.id, [item]);
    expect(publicStore.list().map((entry) => entry.id)).toEqual([common.id]);
    expect(bob.list()).toEqual([]);
    for (const outsider of [publicStore, bob]) {
      expect(outsider.get(privateLibrary.id)).toBeUndefined();
      expect(() => outsider.listItems(privateLibrary.id)).toThrow();
      expect(() => outsider.getPoster(privateLibrary.id)).toThrow();
      expect(() => outsider.setPoster(privateLibrary.id, Buffer.from("bad"))).toThrow("不存在");
      expect(() => outsider.update(privateLibrary.id, { name: "越权" })).toThrow();
      expect(() => outsider.addItems(privateLibrary.id, [item])).toThrow();
      expect(() => outsider.removeItem(privateLibrary.id, item.itemId)).toThrow();
      expect(outsider.remove(privateLibrary.id)).toBe(false);
      expect(outsider.replaceItem(privateLibrary.id, item.itemId, item)).toBe(false);
    }
    bob.removeItemEverywhere(item.itemId);
    expect(alice.listItems(privateLibrary.id)).toEqual([item]);
    migrate(database.db);
    migrate(database.db);
    expect(publicStore.get(common.id)?.ownerMemberId).toBeNull();
    expect(alice.get(privateLibrary.id)?.ownerMemberId).toBe(1);
    expect(
      database.db
        .all(sql`PRAGMA table_info(virtual_libraries)`)
        .filter((c: unknown) => (c as { name: string }).name === "owner_member_id"),
    ).toHaveLength(1);
    expect(createVirtualLibraryStore(database.db, { all: true }).list()).toHaveLength(2);
  });
});
