import express from "express";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabase, type DatabaseHandle } from "@emby-task-center/database/client";
import { createVirtualLibraryStore } from "../virtual-libraries/store";
import { registerMarketAdminRoutes } from "./virtual-library-market-admin";
import { writeSettings } from "../settings/store";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jGZkAAAAASUVORK5CYII=",
  "base64",
);
describe("administrator read-only user-library film posters", () => {
  let database: DatabaseHandle;
  const servers: Server[] = [];
  let base: string, libraryId: string, adminLibraryId: string;
  let missing: boolean;
  let contentType: string;
  let calls: { path: string; token: unknown }[];
  async function listen(server: Server) {
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }
  const path = (itemId = "123", id = libraryId) =>
    `${base}/api/virtual-library-market/user-libraries/${id}/items/${encodeURIComponent(itemId)}/poster`;
  const admin = { headers: { "x-fixture-admin": "yes" } };
  beforeEach(async () => {
    database = createDatabase(":memory:");
    calls = [];
    missing = false;
    contentType = "image/png";
    const upstream = await listen(
      createServer((req, res) => {
        const url = new URL(req.url!, "http://fixture");
        calls.push({ path: url.pathname, token: req.headers["x-emby-token"] });
        if (missing) return void res.writeHead(404).end();
        res.writeHead(200, { "Content-Type": contentType }).end(png);
      }),
    );
    writeSettings(database.db, { "emby.baseUrl": upstream, "emby.apiKey": "fixture-image-only" });
    const owner = createVirtualLibraryStore(database.db, { ownerMemberId: 1 });
    libraryId = owner.create({ name: "user private" }).id;
    owner.addItems(libraryId, [
      { itemId: "123", name: "Movie", type: "Movie", year: 2026, imageTag: "stored-tag" },
      { itemId: "film-uuid-id", name: "Series", type: "Series", year: null, imageTag: null },
    ]);
    adminLibraryId = createVirtualLibraryStore(database.db).create({ name: "admin own" }).id;
    const app = express();
    app.use("/api/virtual-library-market", (req, res, next) =>
      req.headers["x-fixture-admin"] === "yes" ? next() : void res.status(401).end(),
    );
    registerMarketAdminRoutes(app, database.db, "/api/virtual-library-market");
    base = await listen(createServer(app));
  });
  afterEach(async () => {
    for (const server of servers.splice(0)) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    database.close();
  });
  it("serves actual associated-film artwork without changing library metadata or associations", async () => {
    const store = createVirtualLibraryStore(database.db, { all: true });
    const before = { library: store.get(libraryId), items: store.listItems(libraryId) };
    const response = await fetch(path(), admin);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("image/png");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(png);
    expect(calls).toEqual([{ path: "/emby/Items/123/Images/Primary", token: "fixture-image-only" }]);
    expect({ library: store.get(libraryId), items: store.listItems(libraryId) }).toEqual(before);
  });
  it("supports opaque source IDs and missing historical image tags", async () => {
    expect((await fetch(path("film-uuid-id"), admin)).status).toBe(200);
    expect(calls[0].path).toBe("/emby/Items/film-uuid-id/Images/Primary");
  });
  it("does not serve active SVG documents through the authenticated image endpoint", async () => {
    contentType = "image/svg+xml";
    expect((await fetch(path(), admin)).status).toBe(404);
  });
  it("rejects anonymous users, unrelated IDs, administrator-owned libraries and public-route guesses before fetching", async () => {
    expect((await fetch(path())).status).toBe(401);
    expect((await fetch(path("other"), admin)).status).toBe(404);
    expect((await fetch(path("123", adminLibraryId), admin)).status).toBe(404);
    expect((await fetch(path("123", "missing"), admin)).status).toBe(404);
    expect((await fetch(path().replace("/api/", "/api/public/"), admin)).status).toBe(404);
    expect(calls).toEqual([]);
  });
  it("revokes artwork access when the association is removed and leaves missing-image fallback to the page", async () => {
    missing = true;
    expect((await fetch(path(), admin)).status).toBe(404);
    const store = createVirtualLibraryStore(database.db, { all: true });
    store.removeItem(libraryId, "123");
    calls = [];
    expect((await fetch(path(), admin)).status).toBe(404);
    expect(calls).toEqual([]);
  });
});
