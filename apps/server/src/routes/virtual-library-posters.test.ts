import { type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabase, type DatabaseHandle } from "@emby-task-center/database/client";
import { createVirtualLibraryStore } from "../virtual-libraries/store";
import { registerVirtualLibraryRoutes } from "./virtual-libraries";
import { pngPoster } from "../virtual-libraries/poster-fixtures";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jGZkAAAAASUVORK5CYII=",
  "base64",
);
describe("custom virtual library poster API", () => {
  let handle: DatabaseHandle;
  let server: Server;
  let base: string;
  let id: string;
  beforeEach(async () => {
    handle = createDatabase(":memory:");
    id = createVirtualLibraryStore(handle.db).create({ name: "封面测试" }).id;
    const app = express();
    app.use(express.json({ limit: "32kb" }));
    registerVirtualLibraryRoutes(app, { database: handle.db });
    server = await new Promise<Server>((resolve) => {
      const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/virtual-libraries`;
  });
  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    handle.close();
  });
  const put = (path: string, content: Buffer = png, type = "image/png") =>
    fetch(path, { method: "PUT", headers: { "content-type": type }, body: new Uint8Array(content) });

  it("uploads and reads original bytes, conditionally caches and removes only the poster", async () => {
    const path = `${base}/${id}/poster`;
    expect((await fetch(path)).status).toBe(404);
    const response = await put(path);
    expect(response.status).toBe(200);
    const { library } = (await response.json()) as { library: { posterImageTag: string; posterAspectRatio: number } };
    expect(library.posterAspectRatio).toBe(1);
    const image = await fetch(path);
    expect(image.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await image.arrayBuffer())).toEqual(png);
    expect(image.headers.get("etag")).toBe(`"${library.posterImageTag}"`);
    expect((await fetch(path, { headers: { "if-none-match": image.headers.get("etag")! } })).status).toBe(304);
    const head = await fetch(path, { method: "HEAD" });
    expect(head.headers.get("content-length")).toBe(String(png.length));
    expect(await head.text()).toBe("");
    expect(await (await fetch(path, { method: "DELETE" })).json()).toMatchObject({
      library: { id, posterImageTag: null },
    });
    expect((await fetch(path)).status).toBe(404);
    expect(createVirtualLibraryStore(handle.db).get(id)).toBeDefined();
  });

  it("rejects unsupported, malformed, mismatched and oversized uploads and preserves prior bytes", async () => {
    const path = `${base}/${id}/poster`;
    await put(path);
    expect((await put(path, Buffer.from("<svg></svg>"), "image/svg+xml")).status).toBe(415);
    expect((await put(path, Buffer.from("not a picture"))).status).toBe(400);
    expect((await put(path, png, "image/jpeg")).status).toBe(400);
    const oversized = await put(path, Buffer.alloc(5 * 1024 * 1024 + 1));
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toMatchObject({ error: "poster_too_large" });
    expect(Buffer.from(await (await fetch(path)).arrayBuffer())).toEqual(png);
    expect((await put(`${base}/unknown/poster`)).status).toBe(404);
    expect((await fetch(`${base}/unknown/poster`, { method: "DELETE" })).status).toBe(404);
  });

  it("accepts a valid image larger than the global JSON body limit", async () => {
    const content = pngPoster();
    expect(content.length).toBeGreaterThan(32 * 1024);
    const path = `${base}/${id}/poster`;
    expect((await put(path, content)).status).toBe(200);
    expect(Buffer.from(await (await fetch(path)).arrayBuffer())).toEqual(content);
  });
});
