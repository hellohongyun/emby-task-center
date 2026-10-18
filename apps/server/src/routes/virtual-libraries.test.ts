import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDatabase, type DatabaseHandle } from "@emby-task-center/database/client";
import type { VirtualLibrary } from "@emby-task-center/contracts/virtual-library";
import { VirtualLibrarySourceError } from "../virtual-libraries/source";
import { registerVirtualLibraryRoutes } from "./virtual-libraries";
import { createVirtualLibraryStore } from "../virtual-libraries/store";

describe("virtual library management API", () => {
  let database: DatabaseHandle;
  let server: Server;
  let base: string;
  const item = { itemId: "existing", name: "已存在影片", type: "Movie", year: null, imageTag: null };
  const source = { libraries: vi.fn(), search: vi.fn(), getItems: vi.fn(), lookupItems: vi.fn(), findByTmdb: vi.fn() };
  beforeEach(async () => {
    vi.resetAllMocks();
    database = createDatabase(":memory:");
    source.libraries.mockResolvedValue([{ id: "real-root", name: "原库" }]);
    source.search.mockResolvedValue({ items: [item], total: 1 });
    source.getItems.mockResolvedValue([item]);
    source.lookupItems.mockImplementation(async (ids: string[]) => {
      const store = createVirtualLibraryStore(database.db);
      return store
        .list()
        .flatMap((library) => store.listItems(library.id))
        .filter((entry) => ids.includes(entry.itemId));
    });
    source.findByTmdb.mockResolvedValue([]);
    const app = express();
    app.use(express.json());
    registerVirtualLibraryRoutes(app, { database: database.db, source });
    server = await new Promise<Server>((resolve) => {
      const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/virtual-libraries`;
  });
  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    database.close();
  });
  const body = (method: string, value: unknown) => ({
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(value),
  });

  it("creates, edits and removes only virtual associations through validated original IDs", async () => {
    const created = await fetch(base, body("POST", { name: "精选", collectionType: "mixed" }));
    expect(created.status).toBe(201);
    const { library } = (await created.json()) as { library: VirtualLibrary };
    const added = await fetch(`${base}/${library.id}/items`, body("POST", { itemIds: [item.itemId] }));
    expect(await added.json()).toEqual({ items: [item] });
    expect(source.getItems).toHaveBeenCalledWith([item.itemId]);
    const updated = await fetch(`${base}/${library.id}`, body("PATCH", { name: "新精选" }));
    expect(await updated.json()).toMatchObject({ library: { name: "新精选", collectionType: "mixed", itemCount: 1 } });
    expect(await (await fetch(`${base}/${library.id}/items`)).json()).toEqual({ items: [item] });
    expect((await fetch(`${base}/${library.id}/items/${item.itemId}`, { method: "DELETE" })).status).toBe(204);
    expect(await (await fetch(`${base}/${library.id}/items`)).json()).toEqual({ items: [] });
    expect((await fetch(`${base}/${library.id}`, { method: "DELETE" })).status).toBe(204);
    expect(await (await fetch(base)).json()).toEqual({ libraries: [] });
  });

  it("keeps source routes distinct, validates input and does not store unresolved upstream entries", async () => {
    expect(await (await fetch(`${base}/source-libraries`)).json()).toEqual({
      items: [{ id: "real-root", name: "原库" }],
    });
    expect(await (await fetch(`${base}/source-items?types=Movie,Series&startIndex=7&limit=10`)).json()).toEqual({
      items: [item],
      total: 1,
    });
    expect(source.search).toHaveBeenCalledWith({ types: "Movie,Series", startIndex: 7, limit: 10 });
    expect((await fetch(`${base}/source-items?types=Episode`)).status).toBe(400);
    expect((await fetch(`${base}/source-items?startIndex=-1`)).status).toBe(400);
    expect((await fetch(base, body("POST", { name: " " }))).status).toBe(400);
    expect((await fetch(`${base}/missing/items`, body("POST", { itemIds: ["x"] }))).status).toBe(404);
    expect(source.getItems).not.toHaveBeenCalled();
    const { library } = (await (await fetch(base, body("POST", { name: "测试" }))).json()) as {
      library: VirtualLibrary;
    };
    source.getItems.mockRejectedValue(new VirtualLibrarySourceError("上游失败", 502));
    const failed = await fetch(`${base}/${library.id}/items`, body("POST", { itemIds: ["x"] }));
    expect(failed.status).toBe(502);
    expect(await failed.json()).toEqual({ error: "emby_source_unavailable", message: "上游失败" });
    expect(await (await fetch(`${base}/${library.id}/items`)).json()).toEqual({ items: [] });
  });

  it("uses current upstream types to reject an entire incompatible add batch with an actionable Chinese error", async () => {
    const { library } = (await (
      await fetch(base, body("POST", { name: "电影精选", collectionType: "movies" }))
    ).json()) as {
      library: VirtualLibrary;
    };
    const movie = { ...item, itemId: "movie", name: "可加入电影", type: "Movie" };
    const series = { ...item, itemId: "series", name: "不可加入剧集", type: "Series" };
    source.getItems.mockResolvedValue([movie, series]);
    const rejected = await fetch(
      `${base}/${library.id}/items`,
      body("POST", { itemIds: [movie.itemId, series.itemId] }),
    );
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toEqual({
      error: "virtual_library_type_mismatch",
      message: expect.stringContaining("《不可加入剧集》"),
    });
    expect(source.getItems).toHaveBeenCalledWith([movie.itemId, series.itemId]);
    expect(await (await fetch(`${base}/${library.id}/items`)).json()).toEqual({ items: [] });
    source.getItems.mockResolvedValue([movie]);
    expect((await fetch(`${base}/${library.id}/items`, body("POST", { itemIds: [movie.itemId] }))).status).toBe(200);
    const changed = await fetch(
      `${base}/${library.id}`,
      body("PATCH", { collectionType: "tvshows", name: "不能生效" }),
    );
    expect(changed.status).toBe(400);
    expect(await changed.json()).toEqual({
      error: "virtual_library_type_mismatch",
      message: expect.stringContaining("请改为混合库"),
    });
    expect(await (await fetch(base)).json()).toMatchObject({
      libraries: [{ name: "电影精选", collectionType: "movies" }],
    });
    expect(await (await fetch(`${base}/${library.id}/items`)).json()).toEqual({ items: [movie] });
    expect((await fetch(`${base}/${library.id}`, body("PATCH", { collectionType: "mixed" }))).status).toBe(200);
  });

  it.each(["Season", "Episode", "MusicVideo"])(
    "rejects a new %s mapping atomically while preserving existing work and legacy mappings",
    async (type) => {
      const store = createVirtualLibraryStore(database.db);
      const library = store.create({ name: "精选", collectionType: "mixed", sortOrder: 0 });
      const legacy = { ...item, itemId: "legacy", type: "Season" };
      store.addItems(library.id, [item, legacy]);
      const series = { ...item, itemId: "series", type: "Series" };
      source.getItems.mockResolvedValue([series, { ...item, itemId: "non-work", type }]);
      const rejected = await fetch(`${base}/${library.id}/items`, body("POST", { itemIds: ["series", "non-work"] }));
      expect(rejected.status).toBe(400);
      expect(await rejected.json()).toEqual({
        error: "virtual_library_work_required",
        message: expect.stringContaining("请选择电影或整部剧集"),
      });
      expect(await (await fetch(`${base}/${library.id}/items`)).json()).toEqual({ items: [item, legacy] });
      source.getItems.mockResolvedValue([series]);
      expect((await fetch(`${base}/${library.id}/items`, body("POST", { itemIds: ["series"] }))).status).toBe(200);
    },
  );
});
