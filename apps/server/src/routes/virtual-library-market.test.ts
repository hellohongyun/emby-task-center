import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDatabase, type DatabaseHandle } from "@emby-task-center/database/client";
import { submissionUsers } from "@emby-task-center/database/schema";
import { createVirtualLibraryStore } from "../virtual-libraries/store";
import { createPublicSessionManager } from "../subscriptions/public-session";
import { getSubmissionUserByEmail } from "../subscriptions/membership";
import { registerVirtualLibraryMarketRoutes } from "./virtual-library-market";
import { createVirtualLibraryMarketService } from "../virtual-libraries/market-service";

const order = vi.hoisted(() => ({ append: vi.fn(), prepare: vi.fn() }));
vi.mock("../virtual-libraries/personal-library-order-catalog", () => ({
  prepareMarketSubscriptionOrder: order.prepare,
}));
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l7sAAAAASUVORK5CYII=",
  "base64",
);
describe("market API", () => {
  let db: DatabaseHandle, server: Server, base: string, id: string;
  let cookie: (email: string) => string;
  const request = (email: string, method = "GET", body?: unknown) => ({
    method,
    headers: { cookie: cookie(email), "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  beforeEach(async () => {
    db = createDatabase(":memory:");
    order.prepare.mockReset().mockResolvedValue({ append: order.append });
    order.append.mockClear();
    const now = new Date().toISOString();
    const ids = ["alice", "bob", "unbound"].map(
      (name) =>
        db.db
          .insert(submissionUsers)
          .values({
            email: `${name}@example.test`,
            embyUserId: name === "unbound" ? null : name,
            createdAt: now,
            updatedAt: now,
          })
          .returning()
          .get().id,
    );
    const own = createVirtualLibraryStore(db.db, { ownerMemberId: ids[0] });
    id = own.create({ name: "private" }).id;
    own.addItems(id, [{ itemId: "real", name: "secret-film", type: "Movie", year: null, imageTag: null }]);
    own.setPoster(id, png, "image/png");
    const session = createPublicSessionManager("fixture", (email) => getSubmissionUserByEmail(db.db, email));
    cookie = (email) => session.issueCookie(email).split(";")[0];
    const app = express();
    app.use(express.json());
    registerVirtualLibraryMarketRoutes(app, { database: db.db, publicSession: session });
    app.use("/api/virtual-library-market", (req, res, next) =>
      req.headers["x-fixture-admin"] === "yes" ? next() : void res.status(401).end(),
    );
    registerVirtualLibraryMarketRoutes(app, { database: db.db });
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  });
  const pub = "/api/public/virtual-library-market";
  const admin = "/api/virtual-library-market";
  it("serves built-in previews and read-only artwork while retaining publication and administrator gates", async () => {
    createVirtualLibraryStore(db.db, { all: true }).removePoster(id);
    const path = base + pub + `/${id}/poster`;
    expect((await fetch(path, request("bob@example.test"))).status).toBe(404);
    const inspect = base + admin + `/user-libraries/${id}/poster`;
    expect((await fetch(inspect)).status).toBe(401);
    const inspected = await fetch(inspect, { headers: { "x-fixture-admin": "yes" } });
    expect(inspected.status).toBe(200);
    expect(inspected.headers.get("content-type")).toContain("image/png");
    const bytes = Buffer.from(await inspected.arrayBuffer());
    expect(bytes.subarray(1, 4).toString()).toBe("PNG");
    await fetch(base + pub + `/owned/${id}/publication`, request("alice@example.test", "PUT", { published: true }));
    const response = await fetch(path, request("bob@example.test"));
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
  });
  it("requires member and administrator authentication", async () => {
    expect((await fetch(base + pub)).status).toBe(401);
    expect((await fetch(base + pub, request("unbound@example.test"))).status).toBe(403);
    expect((await fetch(base + admin + "/user-libraries")).status).toBe(401);
    expect(
      (
        await fetch(
          base + pub + "/defaults",
          request("bob@example.test", "PUT", { libraryIds: [], adminEmbyUserId: null }),
        )
      ).status,
    ).toBe(404);
  });
  it("keeps publication author-only and permits previews without granting editing rights", async () => {
    expect(
      (await fetch(base + pub + `/owned/${id}/publication`, request("bob@example.test", "PUT", { published: true })))
        .status,
    ).toBe(404);
    expect(
      (await fetch(base + pub + `/owned/${id}/publication`, request("alice@example.test", "PUT", { published: true })))
        .status,
    ).toBe(200);
    const list = await (await fetch(base + pub, request("bob@example.test"))).json();
    expect(list.libraries[0]).toMatchObject({ id, enabled: false, owned: false, itemCount: 0 });
    expect(JSON.stringify(list)).not.toMatch(/secret-film|ownerMemberId|ownerAdminId|alice@example/);
    expect((await fetch(base + pub + `/${id}/poster`, request("bob@example.test"))).status).toBe(200);
    expect((await fetch(base + pub + `/${id}/items`, request("bob@example.test"))).status).toBe(404);
    for (let i = 0; i < 2; i++)
      expect(
        (await fetch(base + pub + `/${id}/subscription`, request("bob@example.test", "PUT", { enabled: true }))).status,
      ).toBe(200);
    expect(order.prepare).toHaveBeenCalledTimes(1);
    expect(order.append).toHaveBeenCalledWith(id);
    await fetch(base + pub + `/owned/${id}/publication`, request("alice@example.test", "PUT", { published: false }));
    expect((await fetch(base + pub + `/${id}/poster`, request("bob@example.test"))).status).toBe(404);
    expect(
      (await fetch(base + pub + `/${id}/subscription`, request("bob@example.test", "PUT", { enabled: true }))).status,
    ).toBe(404);
  });
  it("provides authenticated read-only user inspection and selected defaults", async () => {
    const headers = { "x-fixture-admin": "yes", "content-type": "application/json" };
    const list = await (await fetch(base + admin + "/user-libraries", { headers })).json();
    expect(list.libraries[0]).toMatchObject({ id, ownerEmail: "alice@example.test" });
    expect((await fetch(base + admin + `/user-libraries/${id}/items`, { headers })).status).toBe(200);
    expect((await fetch(base + admin + `/user-libraries/${id}/poster`, { headers })).status).toBe(200);
    expect((await fetch(base + admin + `/user-libraries/${id}/items`, { headers, method: "DELETE" })).status).toBe(404);
    expect(
      (
        await fetch(base + admin + `/owned/${id}/publication`, {
          headers,
          method: "PUT",
          body: JSON.stringify({ published: true }),
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await fetch(base + admin + "/defaults", {
          headers,
          method: "PUT",
          body: JSON.stringify({ libraryIds: [id], adminEmbyUserId: null }),
        })
      ).status,
    ).toBe(400);
    await fetch(base + pub + `/owned/${id}/publication`, request("alice@example.test", "PUT", { published: true }));
    const saved = await fetch(base + admin + "/defaults", {
      headers,
      method: "PUT",
      body: JSON.stringify({ libraryIds: [id], adminEmbyUserId: "admin-emby" }),
    });
    expect(await saved.json()).toEqual({ libraryIds: [id], adminEmbyUserId: "admin-emby" });
  });
  it("rolls back subscription when persisting the personal order fails", async () => {
    await fetch(base + pub + `/owned/${id}/publication`, request("alice@example.test", "PUT", { published: true }));
    order.append.mockImplementationOnce(() => {
      throw new Error("fixture storage failure");
    });
    expect(
      (await fetch(base + pub + `/${id}/subscription`, request("bob@example.test", "PUT", { enabled: true }))).status,
    ).toBe(500);
    const list = await (await fetch(base + pub, request("bob@example.test"))).json();
    expect(list.libraries[0]).toMatchObject({ enabled: false });
  });
  it("uses one effective subscription across administrator and member views of the same Emby account", async () => {
    const headers = { "x-fixture-admin": "yes", "content-type": "application/json" };
    await fetch(base + pub + `/owned/${id}/publication`, request("alice@example.test", "PUT", { published: true }));
    await fetch(base + admin + "/defaults", {
      headers,
      method: "PUT",
      body: JSON.stringify({ libraryIds: [], adminEmbyUserId: "bob" }),
    });
    const market = createVirtualLibraryMarketService(db.db);
    const memberEnabled = async () =>
      (await (await fetch(base + pub, request("bob@example.test"))).json()).libraries[0].enabled;
    const adminEnabled = async () => (await (await fetch(base + admin, { headers })).json()).libraries[0].enabled;
    await fetch(base + pub + `/${id}/subscription`, request("bob@example.test", "PUT", { enabled: true }));
    expect(await adminEnabled()).toBe(true);
    expect(market.resolveAccess("bob")?.visibleLibraryIds).toContain(id);
    await fetch(base + admin + `/${id}/subscription`, {
      headers,
      method: "PUT",
      body: JSON.stringify({ enabled: false }),
    });
    expect(await memberEnabled()).toBe(false);
    expect(market.resolveAccess("bob")?.visibleLibraryIds).not.toContain(id);
    await fetch(base + admin + `/${id}/subscription`, {
      headers,
      method: "PUT",
      body: JSON.stringify({ enabled: true }),
    });
    expect(await memberEnabled()).toBe(true);
    expect(order.prepare).toHaveBeenLastCalledWith(db.db, "bob");
    await fetch(base + pub + `/${id}/subscription`, request("bob@example.test", "PUT", { enabled: false }));
    expect(await adminEnabled()).toBe(false);
    expect(market.resolveAccess("bob")?.visibleLibraryIds).not.toContain(id);
  });
  it("marks cross-role self-owned libraries as always visible without granting source editing", async () => {
    const market = createVirtualLibraryMarketService(db.db);
    const adminId = createVirtualLibraryStore(db.db).create({ name: "admin-own" }).id;
    const bob = getSubmissionUserByEmail(db.db, "bob@example.test")!;
    const bobId = createVirtualLibraryStore(db.db, { ownerMemberId: bob.id }).create({ name: "member-own" }).id;
    market.publication({ adminId: "primary-admin" }, adminId, true);
    market.publication({ memberId: bob.id }, bobId, true);
    market.saveDefaults({ libraryIds: [], adminEmbyUserId: "bob" });
    const headers = { "x-fixture-admin": "yes", "content-type": "application/json" };
    const adminList = await (await fetch(base + admin, { headers })).json();
    const memberList = await (await fetch(base + pub, request("bob@example.test"))).json();
    expect(adminList.libraries.find((l: { id: string }) => l.id === bobId)).toMatchObject({
      owned: false,
      enabled: true,
      canSubscribe: false,
    });
    expect(memberList.libraries.find((l: { id: string }) => l.id === adminId)).toMatchObject({
      owned: false,
      enabled: true,
      canSubscribe: false,
    });
    expect(
      (
        await fetch(base + admin + `/${bobId}/subscription`, {
          headers,
          method: "PUT",
          body: JSON.stringify({ enabled: false }),
        })
      ).status,
    ).toBe(409);
    expect(
      (await fetch(base + pub + `/${adminId}/subscription`, request("bob@example.test", "PUT", { enabled: false })))
        .status,
    ).toBe(409);
    expect(
      (
        await fetch(base + admin + `/owned/${bobId}/publication`, {
          headers,
          method: "PUT",
          body: JSON.stringify({ published: false }),
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await fetch(
          base + pub + `/owned/${adminId}/publication`,
          request("bob@example.test", "PUT", { published: false }),
        )
      ).status,
    ).toBe(404);
  });
});
