import express from "express";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabase, type DatabaseHandle } from "@emby-task-center/database/client";
import { appSettings, submissionUsers } from "@emby-task-center/database/schema";
import { createPublicSessionManager } from "../subscriptions/public-session";
import { registerPersonalLibraryOrderRoutes } from "./personal-library-order";
import { createVirtualLibraryStore } from "../virtual-libraries/store";
import { createVirtualLibraryMarketService } from "../virtual-libraries/market-service";
import { createPersonalLibraryOrderService } from "../virtual-libraries/personal-library-order";
import { prepareMarketSubscriptionOrder } from "../virtual-libraries/personal-library-order-catalog";
import { writeSettings } from "../settings/store";
import { pngPoster } from "../virtual-libraries/poster-fixtures";

describe("personal library order HTTP APIs", () => {
  const servers: Server[] = [];
  let database: DatabaseHandle;
  let base: string;
  let upstream: string;
  let own: string;
  let shared: string;
  let other: string;
  let memberId: number;
  let methods: string[];
  let legacy: string[];
  const session = createPublicSessionManager("fixture-personal-library-order-secret");
  async function listen(server: Server) {
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }
  function send(
    path = "/api/public/virtual-library-order",
    method = "GET",
    value?: unknown,
    email = "alice@test.example",
    admin = false,
  ) {
    return fetch(base + path, {
      method,
      headers: {
        cookie: session.issueCookie(email),
        "content-type": "application/json",
        ...(admin ? { "x-test-admin": "yes" } : {}),
      },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }),
    });
  }
  beforeEach(async () => {
    database = createDatabase(":memory:");
    methods = [];
    legacy = [];
    const now = new Date().toISOString();
    memberId = database.db
      .insert(submissionUsers)
      .values({ email: "alice@test.example", embyUserId: "alice", createdAt: now, updatedAt: now })
      .returning()
      .get().id;
    const bob = database.db
      .insert(submissionUsers)
      .values({ email: "bob@test.example", embyUserId: "bob", createdAt: now, updatedAt: now })
      .returning()
      .get();
    own = createVirtualLibraryStore(database.db, { ownerMemberId: memberId }).create({ name: "mine" }).id;
    other = createVirtualLibraryStore(database.db, { ownerMemberId: bob.id }).create({ name: "secret" }).id;
    shared = createVirtualLibraryStore(database.db).create({ name: "market" }).id;
    const market = createVirtualLibraryMarketService(database.db);
    market.publication({ adminId: "primary-admin" }, shared, true);
    market.subscribe(`member:${memberId}`, shared, true);
    market.saveDefaults({ libraryIds: [], adminEmbyUserId: "admin" });
    upstream = await listen(
      createServer((req, res) => {
        methods.push(req.method!);
        const url = new URL(req.url!, "http://fixture");
        res.setHeader("content-type", "application/json");
        // Simulate an upstream that already includes project IDs; these must be filtered before recombination.
        res.end(
          JSON.stringify(
            url.pathname.endsWith("/Views")
              ? {
                  Items: [
                    { Id: "native-a", Name: "Native A", Guid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" },
                    { Id: "native-b", Name: "Native B", Guid: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb" },
                    { Id: own, Name: "duplicate" },
                    { Id: other, Name: "must not leak" },
                  ],
                }
              : { Id: url.pathname.split("/").at(-1), Configuration: { OrderedViews: legacy } },
          ),
        );
      }),
    );
    writeSettings(database.db, { "emby.baseUrl": upstream, "emby.apiKey": "scope-fixture" });
    const app = express();
    app.use(express.json());
    registerPersonalLibraryOrderRoutes(app, { database: database.db, publicSession: session });
    app.use((req, res, next) => {
      if (req.headers["x-test-admin"] !== "yes") res.status(401).end();
      else next();
    });
    registerPersonalLibraryOrderRoutes(app, { database: database.db });
    base = await listen(createServer(app));
  });
  afterEach(async () => {
    for (const server of servers.splice(0)) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    database?.close();
  });
  it("lists authorized categories once, saves a mixed order for only the current member, and resets", async () => {
    const initial = await (await send()).json();
    expect(initial.order).toEqual([own, "native-a", "native-b", shared]);
    expect(initial.items.map((item: { kind: string }) => item.kind)).toEqual([
      "owned",
      "native",
      "native",
      "subscribed",
    ]);
    expect(initial.hasPersonalOrder).toBe(false);
    const order = [shared, "native-b", own, "native-a"];
    expect((await send(undefined, "PUT", { order })).status).toBe(200);
    expect(await (await send()).json()).toMatchObject({ order, hasPersonalOrder: true });
    expect(await (await send(undefined, "GET", undefined, "bob@test.example")).json()).toMatchObject({
      order: [other, "native-a", "native-b"],
      hasPersonalOrder: false,
    });
    expect((await send(undefined, "DELETE")).status).toBe(200);
    expect(await (await send()).json()).toMatchObject({ order: initial.order, hasPersonalOrder: false });
    expect(methods.every((method) => method === "GET")).toBe(true);
  });
  it("rejects hidden-library claims, duplicate IDs, payload user IDs and anonymous access", async () => {
    for (const body of [{ order: [other] }, { order: [own, own] }, { order: [own], UserId: "bob" }])
      expect((await send(undefined, "PUT", body)).status).toBe(400);
    expect((await fetch(base + "/api/public/virtual-library-order")).status).toBe(401);
    createVirtualLibraryMarketService(database.db).subscribe(`member:${memberId}`, shared, false);
    expect((await send(undefined, "PUT", { order: [shared] })).status).toBe(400);
  });
  it("keeps administrator routes behind the admin gate and defaults independent of saved personal choices", async () => {
    expect((await send("/api/virtual-library-order")).status).toBe(401);
    expect((await send("/api/virtual-library-market/order")).status).toBe(401);
    const personal = ["native-b", shared, "native-a", own];
    await send(undefined, "PUT", { order: personal });
    const template = ["native-b", shared, "native-a"];
    expect((await send("/api/virtual-library-market/order", "PUT", { order: template }, undefined, true)).status).toBe(
      200,
    );
    expect(
      await (await send("/api/virtual-library-market/order", "GET", undefined, undefined, true)).json(),
    ).toMatchObject({ order: template, hasPersonalOrder: false });
    expect(await (await send()).json()).toMatchObject({ order: personal });
    await send(undefined, "DELETE");
    expect(await (await send()).json()).toMatchObject({ order: [own, ...template], hasPersonalOrder: false });
    expect(methods.every((method) => method === "GET")).toBe(true);
  });
  it("inherits recognizable legacy order once and an explicit reset prevents it from resurfacing", async () => {
    legacy = ["native-b", shared, own, "native-a"];
    expect(await (await send()).json()).toMatchObject({ order: legacy, hasPersonalOrder: true });
    await send(undefined, "DELETE");
    expect(await (await send()).json()).toMatchObject({
      order: [own, "native-a", "native-b", shared],
      hasPersonalOrder: false,
    });
    expect(createPersonalLibraryOrderService(database.db).read(upstream, "alice")).toEqual([]);
  });
  it("serves order covers only for visible libraries and revokes access on disabling a subscription", async () => {
    const path = (id: string) => `/api/public/virtual-library-order/${id}/poster`;
    const poster = await send(path(own));
    expect(poster.status).toBe(200);
    expect(poster.headers.get("content-type")).toContain("image/png");
    expect(
      Buffer.from(await poster.arrayBuffer())
        .subarray(0, 8)
        .toString("hex"),
    ).toBe("89504e470d0a1a0a");
    const store = createVirtualLibraryStore(database.db, { all: true });
    store.setPoster(own, pngPoster(120, 240), "image/png");
    const catalog = await (await send()).json();
    expect(catalog.items.find((item: { id: string }) => item.id === own).posterImageTag).toBe(
      store.get(own)!.posterImageTag,
    );
    expect(Buffer.from(await (await send(path(own))).arrayBuffer())).toEqual(store.getPoster(own)!.content);
    expect((await send(path(other))).status).toBe(404);
    expect((await send(path(own), "GET", undefined, "bob@test.example")).status).toBe(404);
    expect((await send(path(shared))).status).toBe(200);
    createVirtualLibraryMarketService(database.db).subscribe(`member:${memberId}`, shared, false);
    expect((await send(path(shared))).status).toBe(404);
    expect((await send(`/api/virtual-library-order/${shared}/poster`)).status).toBe(401);
    const adminPath = `/api/virtual-library-market/order/${shared}/poster`;
    expect((await send(adminPath, "GET", undefined, undefined, true)).status).toBe(200);
    createVirtualLibraryMarketService(database.db).publication({ adminId: "primary-admin" }, shared, false);
    expect((await send(adminPath, "GET", undefined, undefined, true)).status).toBe(404);
  });
  it("materializes the complete sequence before appending a subscription, including after reset", async () => {
    const market = createVirtualLibraryMarketService(database.db);
    market.subscribe(`member:${memberId}`, shared, false);
    createPersonalLibraryOrderService(database.db).reset(upstream, "alice");
    const preparation = await prepareMarketSubscriptionOrder(database.db, "alice");
    market.subscribe(`member:${memberId}`, shared, true);
    preparation.append(shared);
    expect(await (await send()).json()).toMatchObject({
      order: [own, "native-a", "native-b", shared],
      hasPersonalOrder: true,
    });
    const fresh = createVirtualLibraryStore(database.db, { ownerMemberId: memberId }).create({ name: "new" });
    expect((await (await send()).json()).order).toEqual([fresh.id, own, "native-a", "native-b", shared]);
  });
  it("recovers injected-library Guid aliases through the personal API without changing its ID contract", async () => {
    legacy = ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"];
    const key =
      "virtualLibraryOrder." +
      createHash("sha256")
        .update(JSON.stringify([upstream, "alice"]))
        .digest("hex");
    database.db
      .insert(appSettings)
      .values({
        key,
        value: JSON.stringify([
          { id: own, previous: [], next: ["bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"] },
        ]),
        updatedAt: new Date().toISOString(),
      })
      .run();
    const result = await (await send()).json();
    expect(result.order).toEqual([own, "native-b", "native-a", shared]);
    expect(result.items).toContainEqual({ id: "native-b", name: "Native B", kind: "native" });
    expect(result.items.some((item: { guid?: string }) => item.guid)).toBe(false);
    expect(result.hasPersonalOrder).toBe(true);
  });
});
