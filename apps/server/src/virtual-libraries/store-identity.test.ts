import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabase, type DatabaseHandle } from "@emby-task-center/database/client";
import { createVirtualLibraryStore } from "./store";

describe("virtual library stable identity", () => {
  let database: DatabaseHandle;
  beforeEach(() => {
    database = createDatabase(":memory:");
  });
  afterEach(() => database.close());
  const original = { itemId: "old", name: "剧集", type: "Series", year: 2023, imageTag: "old-tag", tmdbId: "123" };
  const resolved = { ...original, itemId: "new", imageTag: "new-tag" };

  it("normalizes provider IDs and retains a previously known identity on metadata-only adds", () => {
    const store = createVirtualLibraryStore(database.db);
    const library = store.create({ name: "精选" });
    store.addItems(library.id, [{ ...original, tmdbId: " 00123 " }]);
    expect(store.listItems(library.id)).toEqual([original]);
    store.addItems(library.id, [{ ...original, tmdbId: undefined }]);
    expect(store.listItems(library.id)).toEqual([original]);
    store.addItems(library.id, [{ ...original, itemId: "invalid", tmdbId: "123abc" }]);
    expect(store.listItems(library.id)[1]).not.toHaveProperty("tmdbId");
  });

  it("replaces a rebuilt item ID in place without changing other libraries or membership order", () => {
    const store = createVirtualLibraryStore(database.db);
    const first = store.create({ name: "一" });
    const second = store.create({ name: "二" });
    const other = { ...original, itemId: "other", tmdbId: "456" };
    store.addItems(first.id, [other, original, { ...other, itemId: "last" }]);
    store.addItems(second.id, [original]);
    expect(store.replaceItem(first.id, "old", resolved, original)).toBe(true);
    expect(store.listItems(first.id).map((item) => item.itemId)).toEqual(["other", "new", "last"]);
    expect(store.listItems(first.id)[1]).toEqual(resolved);
    expect(store.listItems(second.id)).toEqual([original]);
  });

  it.each([false, true])(
    "merges an already mapped target and retains the earliest position (target first: %s)",
    (targetFirst) => {
      const store = createVirtualLibraryStore(database.db);
      const library = store.create({ name: "精选" });
      const middle = { ...original, itemId: "middle", tmdbId: "456" };
      store.addItems(library.id, targetFirst ? [resolved, middle, original] : [original, middle, resolved]);
      expect(store.replaceItem(library.id, "old", resolved)).toBe(true);
      expect(store.listItems(library.id).map((item) => item.itemId)).toEqual(["new", "middle"]);
    },
  );

  it("refuses mismatched identities and stale snapshots, and never restores removed memberships", () => {
    const store = createVirtualLibraryStore(database.db);
    const library = store.create({ name: "精选" });
    store.addItems(library.id, [original]);
    expect(store.replaceItem(library.id, "old", { ...resolved, type: "Movie" })).toBe(false);
    expect(store.replaceItem(library.id, "old", { ...resolved, tmdbId: "999" })).toBe(false);
    expect(store.replaceItem(library.id, "old", { ...resolved, tmdbId: undefined })).toBe(false);
    store.addItems(library.id, [{ ...original, name: "用户已更新" }]);
    expect(store.replaceItem(library.id, "old", resolved, original)).toBe(false);
    store.removeItem(library.id, "old");
    expect(store.replaceItem(library.id, "old", resolved)).toBe(false);
    expect(store.listItems(library.id)).toEqual([]);
    store.remove(library.id);
    expect(store.replaceItem(library.id, "old", resolved)).toBe(false);
  });

  it("backfills a legacy identity in place and protects a conflicting existing target", () => {
    const store = createVirtualLibraryStore(database.db);
    const library = store.create({ name: "精选" });
    const legacy = { ...original, tmdbId: undefined };
    store.addItems(library.id, [legacy]);
    expect(store.replaceItem(library.id, "old", original, legacy)).toBe(true);
    expect(store.listItems(library.id)).toEqual([original]);
    store.addItems(library.id, [{ ...resolved, tmdbId: "456" }]);
    expect(store.replaceItem(library.id, "old", resolved)).toBe(false);
    expect(store.listItems(library.id)).toHaveLength(2);
  });
});
