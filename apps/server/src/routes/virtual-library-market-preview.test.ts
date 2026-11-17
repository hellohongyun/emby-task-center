import express from "express";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createDatabase, type DatabaseHandle } from "@emby-task-center/database/client";
import {
  submissionUsers,
  upstreamVirtualLibraries,
  virtualLibrarySubscriptions,
} from "@emby-task-center/database/schema";
import { createVirtualLibraryStore } from "../virtual-libraries/store";
import { createVirtualLibraryMarketService } from "../virtual-libraries/market-service";
import { createPublicSessionManager } from "../subscriptions/public-session";
import { getSubmissionUserByEmail } from "../subscriptions/membership";
import { registerVirtualLibraryMarketRoutes } from "./virtual-library-market";
import { writeSettings } from "../settings/store";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jGZkAAAAASUVORK5CYII=",
  "base64",
);
describe("market preview read-only HTTP boundaries", () => {
  let db: DatabaseHandle, base: string, upstream: string, id: string, ownerId: number;
  let cookie: string;
  let calls: string[], visible: boolean;
  let onImage: (() => void) | undefined;
  let catalogDelay: boolean;
  const servers: Server[] = [];
  async function listen(server: Server) {
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }
  const pub = "/api/public/virtual-library-market";
  const admin = { headers: { "x-admin": "yes" } };
  const request = () => ({ headers: { cookie } });
  beforeEach(async () => {
    db = createDatabase(":memory:");
    onImage = undefined;
    catalogDelay = false;
    calls = [];
    visible = true;
    upstream = await listen(
      createServer(async (req, res) => {
        calls.push(req.url!);
        const url = new URL(req.url!, "http://fixture");
        if (url.pathname.endsWith("/Images/Primary")) {
          onImage?.();
          return void res.writeHead(200, { "content-type": "image/png" }).end(png);
        }
        res.setHeader("Content-Type", "application/json");
        if (catalogDelay) await new Promise((resolve) => setTimeout(resolve, 30));
        if (url.pathname.endsWith("/Views"))
          return void res.end(JSON.stringify({ Items: visible ? [{ Id: "ttd-root" }] : [] }));
        if (url.pathname.endsWith("/Items")) {
          if (!url.pathname.startsWith("/Users/viewer/") || url.searchParams.get("ParentId") !== "ttd-root")
            return void res.writeHead(403).end();
          return void res.end(
            JSON.stringify({ Items: [{ Id: "ttd-film", Name: "System Movie", Type: "Movie" }], TotalRecordCount: 1 }),
          );
        }
        res.writeHead(404).end();
      }),
    );
    writeSettings(db.db, {
      "emby.baseUrl": upstream,
      "emby.apiKey": "fixture",
      "virtualLibraryProxy.upstream": upstream,
    });
    const now = new Date().toISOString();
    const members = ["owner", "viewer"].map((name) =>
      db.db
        .insert(submissionUsers)
        .values({
          email: `${name}@example.test`,
          embyUserId: name,
          qqNumber: name === "owner" ? "123456" : null,
          createdAt: now,
          updatedAt: now,
        })
        .returning()
        .get(),
    );
    ownerId = members[0].id;
    const own = createVirtualLibraryStore(db.db, { ownerMemberId: ownerId });
    id = own.create({ name: "Published collection" }).id;
    own.addItems(
      id,
      ["first", "second", "third"].map((itemId) => ({
        itemId,
        name: itemId,
        type: "Movie",
        year: 2026,
        imageTag: null,
      })),
    );
    createVirtualLibraryMarketService(db.db).publication({ memberId: ownerId }, id, true);
    db.db
      .insert(upstreamVirtualLibraries)
      .values({
        id: "ttd-market",
        upstream,
        sourceId: "ttd-root",
        name: "System",
        collectionType: "movies",
        published: true,
        available: true,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    const session = createPublicSessionManager("fixture-preview", (email) => getSubmissionUserByEmail(db.db, email));
    cookie = session.issueCookie("viewer@example.test").split(";")[0];
    const app = express();
    registerVirtualLibraryMarketRoutes(app, { database: db.db, publicSession: session });
    app.use("/api/virtual-library-market", (req, res, next) =>
      req.headers["x-admin"] === "yes" ? next() : void res.status(401).end(),
    );
    registerVirtualLibraryMarketRoutes(app, { database: db.db });
    base = await listen(createServer(app));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const server of servers.splice(0)) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    db.close();
  });
  it("previews unenabled libraries with SQL pagination, no repairs, subscriptions or private author data", async () => {
    const before = createVirtualLibraryStore(db.db, { all: true }).listItems(id);
    const path = `${base}${pub}/${id}/details?startIndex=1&limit=1`;
    expect((await fetch(path)).status).toBe(401);
    const response = await fetch(path, request());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const data = await response.json();
    expect(data).toMatchObject({
      total: 3,
      startIndex: 1,
      limit: 1,
      items: [{ itemId: "second" }],
      library: { enabled: false, authorName: "用户" },
    });
    expect(data.items).toHaveLength(1);
    expect(data.library.authorAvatarUrl).toBe(`${pub}/${id}/author-avatar`);
    expect(JSON.stringify(data)).not.toMatch(/owner@example|123456|ownerMemberId|ownerAdminId/);
    expect(createVirtualLibraryStore(db.db, { all: true }).listItems(id)).toEqual(before);
    expect(db.db.select().from(virtualLibrarySubscriptions).all()).toEqual([]);
    expect(calls).toEqual([]);
    for (const query of ["limit=101", "startIndex=-1", "limit=1.2", "limit=bad"])
      expect((await fetch(`${base}${pub}/${id}/details?${query}`, request())).status).toBe(400);
  });
  it("revokes details and exact-association posters after unpublish, author invalidation and removal", async () => {
    const details = `${base}${pub}/${id}/details`,
      poster = `${base}${pub}/${id}/items/first/poster`;
    expect((await fetch(poster, request())).status).toBe(200);
    expect((await fetch(poster.replace("first", "unrelated"), request())).status).toBe(404);
    const store = createVirtualLibraryStore(db.db, { all: true });
    store.removeItem(id, "first");
    calls = [];
    expect((await fetch(poster, request())).status).toBe(404);
    expect(calls).toEqual([]);
    db.db.update(submissionUsers).set({ enabled: false }).where(eq(submissionUsers.id, ownerId)).run();
    expect((await fetch(details, request())).status).toBe(404);
    expect((await fetch(poster.replace("first", "second"), request())).status).toBe(404);
    db.db.update(submissionUsers).set({ enabled: true }).where(eq(submissionUsers.id, ownerId)).run();
    createVirtualLibraryMarketService(db.db).publication({ memberId: ownerId }, id, false);
    expect((await fetch(details, request())).status).toBe(404);
    expect((await fetch(`${base}/api/virtual-library-market/${id}/details`, admin)).status).toBe(404);
  });
  it("uses only the viewer's dynamic upstream scope and requires binding for administrators", async () => {
    const path = `${base}${pub}/ttd-market/details?limit=1`;
    expect((await fetch(path, request())).status).toBe(200);
    expect(calls.some((url) => url.startsWith("/Users/viewer/Items?"))).toBe(true);
    expect(calls.join(" ")).not.toMatch(/Users\/owner/);
    expect((await fetch(`${base}/api/virtual-library-market/ttd-market/details`, admin)).status).toBe(403);
    expect((await fetch(`${base}${pub}/ttd-market/items/ttd-film/poster`, request())).status).toBe(200);
    expect((await fetch(`${base}${pub}/ttd-market/items/unrelated/poster`, request())).status).toBe(404);
    visible = false;
    expect((await fetch(path, request())).status).toBe(404);
    visible = true;
    db.db
      .update(upstreamVirtualLibraries)
      .set({ published: false })
      .where(eq(upstreamVirtualLibraries.id, "ttd-market"))
      .run();
    expect((await fetch(path, request())).status).toBe(404);
  });
  it("rechecks associations and authors after image transport, including expiry and missing binding", async () => {
    const poster = `${base}${pub}/${id}/items/first/poster`;
    onImage = () => createVirtualLibraryStore(db.db, { all: true }).removeItem(id, "first");
    expect((await fetch(poster, request())).status).toBe(404);
    onImage = () => db.db.update(submissionUsers).set({ enabled: false }).where(eq(submissionUsers.id, ownerId)).run();
    expect((await fetch(poster.replace("first", "second"), request())).status).toBe(404);
    db.db
      .update(submissionUsers)
      .set({ enabled: true, subscriptionExpiresAt: "2000-01-01T00:00:00Z" })
      .where(eq(submissionUsers.id, ownerId))
      .run();
    expect((await fetch(`${base}${pub}/${id}/details`, request())).status).toBe(404);
    db.db
      .update(submissionUsers)
      .set({ subscriptionExpiresAt: null, embyUserId: null })
      .where(eq(submissionUsers.id, ownerId))
      .run();
    expect((await fetch(`${base}${pub}/${id}/details`, request())).status).toBe(404);
  });
  it("normalizes configured /emby prefixes when reading local artwork", async () => {
    writeSettings(db.db, { "emby.baseUrl": `${upstream}/emby` });
    expect((await fetch(`${base}${pub}/${id}/items/first/poster`, request())).status).toBe(200);
    expect(calls).toEqual(["/emby/Items/first/Images/Primary"]);
  });
  it("coalesces concurrent viewer catalog reads but reauthorizes every later batch", async () => {
    catalogDelay = true;
    const path = `${base}${pub}/ttd-market/items/ttd-film/poster`;
    const responses = await Promise.all(Array.from({ length: 8 }, () => fetch(path, request())));
    expect(responses.every((response) => response.status === 200)).toBe(true);
    expect(calls.filter((url) => url.includes("/Views"))).toHaveLength(1);
    expect(calls.filter((url) => url.includes("/Users/viewer/Items?"))).toHaveLength(1);
    visible = false;
    expect((await fetch(path, request())).status).toBe(404);
    expect(calls.filter((url) => url.includes("/Views"))).toHaveLength(2);
  });
  it("proxies real profile avatars without exposing QQ and rechecks publication despite a warm cache", async () => {
    const realFetch = globalThis.fetch;
    const avatarCalls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      if (String(url).startsWith("https://q1.qlogo.cn/")) {
        avatarCalls.push(String(url));
        return new Response(png, { headers: { "Content-Type": "image/png" } });
      }
      return realFetch(url, init);
    });
    const path = `${base}${pub}/${id}/author-avatar`;
    expect((await fetch(path)).status).toBe(401);
    expect((await fetch(path, request())).status).toBe(200);
    expect((await fetch(path, request())).status).toBe(200);
    expect(avatarCalls).toHaveLength(1);
    createVirtualLibraryMarketService(db.db).publication({ memberId: ownerId }, id, false);
    expect((await fetch(path, request())).status).toBe(404);
    expect((await fetch(`${base}/api/virtual-library-market/user-libraries/${id}/author-avatar`, admin)).status).toBe(
      200,
    );
    expect(avatarCalls).toHaveLength(1);
  });
});
