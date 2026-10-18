import express from "express";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createDatabase, type DatabaseHandle } from "@emby-task-center/database/client";
import { libraryItems, mediaItems, mediaRoots } from "@emby-task-center/database/schema";
import { registerPublicLibraryRoutes } from "./public-library";
import { createPublicLibraryReader } from "./public-library-reader";

const filters = {
  type: "all",
  status: "all",
  resolution: "all",
  codec: "",
  genre: "",
  actor: "",
  yearFrom: null,
  yearTo: null,
  query: "",
};
const now = "2026-01-01";
describe("public inventory availability", () => {
  let directory: string;
  let handle: DatabaseHandle;
  let active: number;
  let disabled: number;
  let server: Server | undefined;
  let closeReader: (() => Promise<void>) | undefined;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "emby-public-active-"));
    handle = createDatabase(join(directory, "app.sqlite"));
    const root = (name: string, enabled: boolean) =>
      handle.db
        .insert(mediaRoots)
        .values({ name, containerPath: name, mediaType: "mixed", enabled, createdAt: now, updatedAt: now })
        .returning()
        .get().id;
    active = root("active", true);
    disabled = root("disabled", false);
  });
  afterEach(async () => {
    if (server) await new Promise<void>((done) => server!.close(() => done()));
    await closeReader?.();
    server = undefined;
    closeReader = undefined;
    handle.close();
    rmSync(directory, { recursive: true, force: true });
  });
  function media(title: string, tmdbId: number) {
    return handle.db
      .insert(mediaItems)
      .values({ title, tmdbId, mediaType: "movie", genres: [title], createdAt: now, updatedAt: now })
      .returning()
      .get();
  }
  function stock(root: number, title: string, mediaId: number | null, tags: string[] = []) {
    return handle.db
      .insert(libraryItems)
      .values({
        mediaRootId: root,
        mediaItemId: mediaId,
        sourceTitle: title,
        sourceYear: 2020,
        relativePath: title + crypto.randomUUID(),
        tags,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
  }
  it("counts only active copies and excludes disabled tags, facets and legacy ids", () => {
    const shared = media("shared", 9001);
    const old = media("old", 9002);
    stock(active, "shared", shared.id, ["1080p", "H264"]);
    stock(disabled, "shared", shared.id, ["2160p", "HEVC"]);
    stock(disabled, "old", old.id);
    const unknown = stock(disabled, "unknown", null);
    stock(active, "unknown", null);
    const reader = createPublicLibraryReader({ database: handle.db }, null);
    const page = reader.list(filters, "latest", 40, 0);
    expect(page.total).toBe(2);
    expect(page.items.find((item) => item.id === "mi:" + shared.id)).toMatchObject({
      fileCount: 1,
      resolution: "1080p",
      codecs: ["1080p", "H264"],
    });
    expect(page.facets.resolutions).toEqual(["1080p"]);
    expect(page.facets.genres).toEqual(["shared"]);
    expect(reader.list({ ...filters, codec: "HEVC" }, "latest", 40, 0).total).toBe(0);
    expect(reader.detail("mi:" + old.id)).toBeUndefined();
    expect(reader.detail("mi:9002")).toBeUndefined();
    expect(reader.detail("li:" + unknown.id)).toBeUndefined();
    expect(reader.detail("li:unknown:2020")?.fileCount).toBe(1);
    expect(reader.detail("mi:9001")?.fileCount).toBe(1);
    expect(handle.db.get<{ total: number }>(sql`SELECT count(*) AS total FROM library_items`)!.total).toBe(5);
  });
  it("immediately rebuilds availability on both connections without timestamp changes", () => {
    const first = media("first", 9001);
    stock(active, "first", first.id, ["1080p"]);
    const reader = createPublicLibraryReader({ database: handle.db }, null);
    expect(reader.list(filters, "latest", 40, 0).total).toBe(1);
    handle.db.update(mediaRoots).set({ enabled: false }).where(eq(mediaRoots.id, active)).run();
    expect(reader.list(filters, "latest", 40, 0)).toMatchObject({
      total: 0,
      items: [],
      facets: { types: { all: 0 }, resolutions: [] },
    });
    expect(reader.detail("mi:9001")).toBeUndefined();
    const other = createDatabase(join(directory, "app.sqlite"));
    try {
      other.db.update(mediaRoots).set({ enabled: true }).where(eq(mediaRoots.id, active)).run();
      expect(reader.list(filters, "latest", 40, 0).total).toBe(1);
      other.db.update(mediaRoots).set({ enabled: false }).where(eq(mediaRoots.id, active)).run();
      expect(reader.list(filters, "latest", 40, 0).total).toBe(0);
    } finally {
      other.close();
    }
    expect(handle.db.get<{ total: number }>(sql`SELECT count(*) AS total FROM library_items`)!.total).toBe(1);
  });
  it("hides disabled inventory from every endpoint and restores it on enable", async () => {
    const old = media("old", 9002);
    stock(disabled, "old", old.id);
    const unknown = stock(disabled, "unknown", null);
    const app = express();
    closeReader = registerPublicLibraryRoutes(app, { database: handle.db });
    server = app.listen(0);
    await new Promise<void>((done) => server!.once("listening", done));
    const base = "http://127.0.0.1:" + (server.address() as AddressInfo).port + "/api/public/library/";
    const get = async (path: string) => {
      const response = await fetch(base + path);
      return { status: response.status, body: await response.json() };
    };
    expect((await get("search?q=old")).body).toEqual({ items: [] });
    expect((await get("search?q=unknown")).body).toEqual({ items: [] });
    expect((await get("recent")).body).toEqual({ items: [] });
    expect((await get("status?tmdbId=9002")).body).toEqual({ inLibrary: false, items: [] });
    expect((await get("status?title=old")).body).toEqual({ inLibrary: false, items: [] });
    expect((await get("list")).body).toMatchObject({ total: 0, items: [] });
    expect((await get("detail?id=mi:9002")).status).toBe(404);
    expect((await get("detail?id=li:" + unknown.id)).status).toBe(404);
    handle.db.update(mediaRoots).set({ enabled: true }).where(eq(mediaRoots.id, disabled)).run();
    expect((await get("search?q=old")).body).toMatchObject({ items: [{ title: "old" }] });
    expect((await get("recent")).body).toMatchObject({ items: [{ title: "old" }] });
    expect((await get("status?tmdbId=9002")).body).toMatchObject({ inLibrary: true });
    expect((await get("list")).body).toMatchObject({ total: 2 });
    expect((await get("detail?id=li:" + unknown.id)).status).toBe(200);
    expect(handle.db.get<{ total: number }>(sql`SELECT count(*) AS total FROM library_items`)!.total).toBe(2);
  });
});
