import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabase, type DatabaseHandle } from "@emby-task-center/database/client";
import { virtualLibraries, virtualLibraryItems } from "@emby-task-center/database/schema";
import { eq } from "drizzle-orm";
import { migrate } from "@emby-task-center/database/migrate";
import { createVirtualLibraryStore } from "./store";
import { VirtualLibraryTypeMismatchError } from "./type-validation";

describe("virtual library store", () => {
  let database: DatabaseHandle;
  beforeEach(() => {
    database = createDatabase(":memory:");
  });
  afterEach(() => database.close());
  const movie = { itemId: "movie", name: "原电影", type: "Movie", year: 2026, imageTag: "tag" };
  const episode = { itemId: "episode", name: "原单集", type: "Episode", year: null, imageTag: null };

  it("keeps memberships independent, accepts any original item type and preserves stable duplicate order", () => {
    const store = createVirtualLibraryStore(database.db);
    const first = store.create({ name: "精选", collectionType: "mixed", sortOrder: 9 });
    const second = store.create({ name: "其他", sortOrder: -1 });
    expect(first.id).toMatch(/^[a-f0-9]{32}$/);
    store.addItems(first.id, [movie, episode, movie]);
    store.addItems(second.id, [movie]);
    store.addItems(first.id, [{ ...movie, name: "上游改名" }]);
    expect(store.listItems(first.id).map((item) => item.itemId)).toEqual(["movie", "episode"]);
    expect(store.get(first.id)?.itemCount).toBe(2);
    expect(store.listItems(first.id)[0].name).toBe("上游改名");
    expect(store.list().map((library) => library.id)).toEqual([second.id, first.id]);
    expect(store.update(first.id, { name: "新名称" })).toMatchObject({ collectionType: "mixed", sortOrder: 9 });
    store.removeItem(first.id, movie.itemId);
    expect(store.listItems(second.id)).toEqual([movie]);
    store.remove(first.id);
    expect(store.listItems(second.id)).toEqual([movie]);
    store.removeItemEverywhere(movie.itemId);
    expect(store.get(second.id)?.itemCount).toBe(0);
    expect(database.db.select().from(virtualLibraryItems).all()).toEqual([]);
  });

  it("preserves persisted virtual data when reconciliation runs repeatedly", () => {
    const store = createVirtualLibraryStore(database.db);
    const library = store.create({ name: "保留" });
    store.addItems(library.id, [movie]);
    migrate(database.db);
    migrate(database.db);
    expect(store.list()).toEqual([{ ...library, updatedAt: store.get(library.id)!.updatedAt, itemCount: 1 }]);
    expect(store.listItems(library.id)).toEqual([movie]);
  });

  it("rolls back the entire membership batch on a database constraint failure", () => {
    const store = createVirtualLibraryStore(database.db);
    const library = store.create({ name: "事务" });
    expect(() => store.addItems(library.id, [movie, { ...episode, name: null as unknown as string }])).toThrow();
    expect(store.listItems(library.id)).toEqual([]);
    expect(() => store.addItems("missing", [movie])).toThrow("虚拟媒体库不存在");
  });

  it("accepts only movies for movie libraries and preserves every row when a mixed batch is rejected", () => {
    const store = createVirtualLibraryStore(database.db);
    const library = store.create({ name: "电影库", collectionType: "movies" });
    store.addItems(library.id, [movie]);
    const before = store.get(library.id);
    expect(() => store.addItems(library.id, [{ ...movie, name: "不应覆盖" }, episode])).toThrow(
      VirtualLibraryTypeMismatchError,
    );
    expect(() => store.addItems(library.id, [episode])).toThrow("《原单集》");
    expect(() => store.addItems(library.id, [episode])).toThrow("请改为混合库");
    expect(store.listItems(library.id)).toEqual([movie]);
    expect(store.get(library.id)).toEqual(before);
  });

  it("accepts series, seasons and episodes for TV libraries and rejects movies and unknown types", () => {
    const store = createVirtualLibraryStore(database.db);
    const library = store.create({ name: "剧集库", collectionType: "tvshows" });
    const series = { ...episode, itemId: "series", type: "Series" };
    const season = { ...episode, itemId: "season", type: "Season" };
    store.addItems(library.id, [series, season, episode]);
    expect(store.listItems(library.id)).toEqual([series, season, episode]);
    expect(() => store.addItems(library.id, [movie])).toThrow(VirtualLibraryTypeMismatchError);
    expect(() => store.addItems(library.id, [{ ...movie, type: "" }])).toThrow(VirtualLibraryTypeMismatchError);
    expect(store.listItems(library.id)).toEqual([series, season, episode]);
  });

  it("allows any original item type in mixed libraries", () => {
    const store = createVirtualLibraryStore(database.db);
    const library = store.create({ name: "混合库", collectionType: "mixed" });
    const unknown = { ...movie, itemId: "unknown", type: "" };
    const musicVideo = { ...movie, itemId: "music-video", type: "MusicVideo" };
    expect(store.addItems(library.id, [movie, episode, unknown, musicVideo])).toEqual([
      movie,
      episode,
      unknown,
      musicVideo,
    ]);
  });

  it("rejects incompatible type changes atomically and permits changing to mixed", () => {
    const store = createVirtualLibraryStore(database.db);
    const library = store.create({ name: "电影库", collectionType: "movies" });
    store.addItems(library.id, [movie]);
    const before = store.get(library.id);
    expect(() => store.update(library.id, { name: "不可写入", collectionType: "tvshows", sortOrder: 9 })).toThrow(
      VirtualLibraryTypeMismatchError,
    );
    expect(store.get(library.id)).toEqual(before);
    expect(store.listItems(library.id)).toEqual([movie]);
    expect(store.update(library.id, { collectionType: "mixed" })).toMatchObject({ collectionType: "mixed" });
    store.addItems(library.id, [episode]);
    expect(() => store.update(library.id, { collectionType: "movies" })).toThrow(VirtualLibraryTypeMismatchError);
    expect(store.listItems(library.id)).toEqual([movie, episode]);
  });

  it("preserves legacy incompatible memberships and allows name, order and unchanged type edits", () => {
    const store = createVirtualLibraryStore(database.db);
    const library = store.create({ name: "历史库", collectionType: "mixed" });
    store.addItems(library.id, [movie]);
    database.db
      .update(virtualLibraries)
      .set({ collectionType: "tvshows" })
      .where(eq(virtualLibraries.id, library.id))
      .run();
    expect(store.update(library.id, { name: "历史库改名", sortOrder: 3 })).toMatchObject({
      name: "历史库改名",
      collectionType: "tvshows",
      sortOrder: 3,
    });
    expect(store.update(library.id, { collectionType: "tvshows" })).toMatchObject({ collectionType: "tvshows" });
    expect(store.listItems(library.id)).toEqual([movie]);
    expect(store.update(library.id, { collectionType: "mixed" })).toMatchObject({ collectionType: "mixed" });
    expect(store.listItems(library.id)).toEqual([movie]);
  });
});
