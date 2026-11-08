import { createDatabase, type DatabaseHandle } from "@emby-task-center/database/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEmbyLibraryOrderStore } from "./emby-library-order-store";

describe("Emby library order persistence", () => {
  let database: DatabaseHandle;

  beforeEach(() => {
    database = createDatabase(":memory:");
  });

  afterEach(() => database.close());

  it("round-trips an order for the current base URL and ignores another server", () => {
    const store = createEmbyLibraryOrderStore(database.db);
    expect(store.read("https://emby.test/")).toBeNull();
    const saved = store.save("https://emby.test/", ["a", "b"], { a: "电影", b: "剧集" });
    expect(saved.baseUrl).toBe("https://emby.test");
    expect(store.read("https://emby.test")).toEqual(saved);
    expect(store.read("https://other.test")).toBeNull();
    expect(store.read("https://emby.test")).toMatchObject({ order: ["a", "b"], names: { a: "电影" } });
  });

  it("replaces the saved order and rejects malformed stored JSON", () => {
    const store = createEmbyLibraryOrderStore(database.db);
    store.save("https://emby.test", ["a"], { a: "电影" });
    store.save("https://emby.test", ["b", "a"], { a: "电影", b: "剧集" });
    expect(store.read("https://emby.test")?.order).toEqual(["b", "a"]);

    database.db.run("UPDATE app_settings SET value = '{broken' WHERE key = 'emby.libraryOrder'");
    expect(store.read("https://emby.test")).toBeNull();
  });
});
