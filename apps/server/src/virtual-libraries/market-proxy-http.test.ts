import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabase, type DatabaseHandle } from "@emby-task-center/database/client";
import { submissionUsers } from "@emby-task-center/database/schema";
import { createVirtualLibraryStore } from "./store";
import { createVirtualLibraryMarketService } from "./market-service";
import { createPersonalLibraryOrderService } from "./personal-library-order";
import { createVirtualLibraryProxy, type VirtualLibraryProxy } from "./proxy";
import { writeSettings } from "../settings/store";
import { createEmbyLibraryOrderStore } from "../integrations/emby-library-order-store";
import { DEFAULT_LIBRARY_POSTER_TAG } from "@emby-task-center/contracts/library-poster";

describe("market library authorization and ordering over HTTP", () => {
  const servers: Server[] = [];
  let database: DatabaseHandle;
  let proxy: VirtualLibraryProxy;
  let upstream: string;
  let base: string;
  let memberId: number;
  let owned: string[];
  let shared: string[];
  let seen: string[];
  let config: Record<string, unknown>;
  const natives = ["native-a", "native-b", "native-c"].map((Id) => ({
    Id,
    Name: Id,
    Type: "CollectionFolder",
    Extra: { keep: true },
  }));
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l7sAAAAASUVORK5CYII=",
    "base64",
  );
  async function listen(server: Server) {
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }
  const get = (path: string, token = "alice-token", headers: Record<string, string> = {}) =>
    fetch(base + path, { headers: { ...(token ? { "x-emby-token": token } : {}), ...headers } });
  async function ids(path: string, token?: string) {
    const response = await get(path, token);
    const data = (await response.json()) as { Items: { Id: string }[]; TotalRecordCount: number };
    return { ids: data.Items.map((item) => item.Id), total: data.TotalRecordCount };
  }
  beforeEach(async () => {
    database = createDatabase(":memory:");
    seen = [];
    config = {};
    const now = new Date().toISOString();
    memberId = database.db
      .insert(submissionUsers)
      .values({ email: "alice@test.example", embyUserId: "alice", createdAt: now, updatedAt: now })
      .returning()
      .get().id;
    database.db
      .insert(submissionUsers)
      .values({ email: "bob@test.example", embyUserId: "bob", createdAt: now, updatedAt: now })
      .run();
    const mine = createVirtualLibraryStore(database.db, { ownerMemberId: memberId });
    owned = [mine.create({ name: "mine-a", sortOrder: 0 }).id, mine.create({ name: "mine-b", sortOrder: 1 }).id];
    const admin = createVirtualLibraryStore(database.db);
    shared = [admin.create({ name: "shared-a", sortOrder: 0 }).id, admin.create({ name: "shared-b", sortOrder: 1 }).id];
    const market = createVirtualLibraryMarketService(database.db);
    for (const id of shared) {
      market.publication({ adminId: "primary-admin" }, id, true);
      market.subscribe(`member:${memberId}`, id, true);
    }
    admin.setPoster(shared[0], png, "image/png");
    upstream = await listen(
      createServer((req, res) => {
        const url = new URL(req.url!, "http://fixture");
        seen.push(url.pathname);
        const token = req.headers["x-emby-token"];
        if (req.method === "POST" && url.pathname === "/Users/AuthenticateByName") {
          req.resume();
          res.end(
            JSON.stringify({ AccessToken: String(token), User: { Id: token === "bob-token" ? "bob" : "alice" } }),
          );
          return;
        }
        if (url.pathname.startsWith("/Videos/")) {
          res.end("unchanged-stream");
          return;
        }
        if (token !== "alice-token" && token !== "bob-token") {
          res.writeHead(401).end();
          return;
        }
        const user = token === "alice-token" ? "alice" : "bob";
        if (/^\/Users\/[^/]+$/.test(url.pathname)) {
          res.end(JSON.stringify({ Id: user, Configuration: config }));
          return;
        }
        if (url.pathname.endsWith("/HomeSections")) {
          res.end(
            JSON.stringify([
              { Id: "libraries", SectionType: "userviews" },
              { Id: "latest", SectionType: "latestmedia", ParentId: "native-a" },
            ]),
          );
          return;
        }
        const start = Number(url.searchParams.get("StartIndex") ?? 0);
        // Deliberately cap the unpaged response: the proxy must complete the list before slicing.
        const limit = Number(url.searchParams.get("Limit") ?? 2);
        res.end(JSON.stringify({ Items: natives.slice(start, start + limit), TotalRecordCount: natives.length }));
      }),
    );
    writeSettings(database.db, { "emby.baseUrl": upstream, "emby.apiKey": "admin-never-sent" });
    const reserve = createServer();
    base = await listen(reserve);
    await new Promise<void>((resolve) => reserve.close(() => resolve()));
    servers.splice(servers.indexOf(reserve), 1);
    proxy = createVirtualLibraryProxy({ database: database.db, appPort: 3000 });
    await proxy.configure({ enabled: true, upstream, port: Number(new URL(base).port) });
    for (const token of ["alice-token", "bob-token"]) {
      const response = await fetch(base + "/Users/AuthenticateByName", {
        method: "POST",
        headers: { "x-emby-token": token },
      });
      await response.arrayBuffer();
    }
  });
  afterEach(async () => {
    await proxy?.close();
    for (const server of servers.splice(0)) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    database?.close();
  });
  it("includes only own and enabled published libraries; administrator public ownership grants no bypass", async () => {
    expect((await ids("/Users/alice/Views")).ids).toEqual([...owned, ...natives.map((item) => item.Id), ...shared]);
    expect((await ids("/Users/bob/Views", "bob-token")).ids).toEqual(natives.map((item) => item.Id));
    expect((await get(`/Items/${shared[0]}`, "bob-token")).status).toBe(404);
    expect((await get(`/Items/${shared[0]}?UserId=alice`, "bob-token")).status).toBe(404);
    const tag = createVirtualLibraryStore(database.db).getPoster(shared[0])!.imageTag;
    expect((await get(`/Items/${shared[0]}/Images/Primary?tag=${tag}`, "")).status).toBe(404);
    expect((await get(`/Items/${shared[0]}/Images/Primary?tag=${tag}`, "bob-token")).status).toBe(404);
    expect((await get(`/Items/${shared[0]}/Images/Primary?tag=${tag}`)).status).toBe(200);
  });
  it("serves default posters only within the current library scope, including HEAD and matching tags", async () => {
    const path = `/Items/${shared[1]}/Images/Primary?tag=${DEFAULT_LIBRARY_POSTER_TAG}`;
    const response = await get(path);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    const bytes = Buffer.from(await response.arrayBuffer());
    expect(bytes.subarray(1, 4).toString()).toBe("PNG");
    for (const token of ["", "bob-token"]) expect((await get(path, token)).status).toBe(404);
    const head = await fetch(base + path, { method: "HEAD", headers: { "x-emby-token": "alice-token" } });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect(head.headers.get("content-length")).toBe(String(bytes.length));
    createVirtualLibraryMarketService(database.db).publication({ adminId: "primary-admin" }, shared[1], false);
    expect((await get(path, "alice-token", { "if-none-match": `"${DEFAULT_LIBRARY_POSTER_TAG}"` })).status).toBe(404);
  });
  it("revokes list, known IDs, mixed queries, latest rows and posters immediately after close or unpublish", async () => {
    const market = createVirtualLibraryMarketService(database.db);
    await get("/Users/alice/HomeSections");
    market.subscribe(`member:${memberId}`, shared[0], false);
    market.publication({ adminId: "primary-admin" }, shared[1], false);
    for (const id of shared) {
      for (const path of [
        `/Items/${id}`,
        `/Items?ParentId=${id}`,
        `/Items?Ids=native-a,${id}`,
        `/Items/${id}/Images/Primary`,
        `/Users/alice/Sections/task-center-latest%3A${id}/Items`,
      ])
        expect((await get(path)).status, path).toBe(404);
    }
    expect((await ids("/Users/alice/Views")).ids).toEqual([...owned, ...natives.map((item) => item.Id)]);
    const response = await get("/Users/alice/HomeSections");
    expect(JSON.stringify(await response.json())).not.toContain(shared[0]);
  });
  it("places personal mixed order before admin defaults and paginates the complete authorized set", async () => {
    createEmbyLibraryOrderStore(database.db).activate(upstream, upstream, [shared[0], "native-c"], {});
    const order = ["native-b", shared[1], owned[1], "native-a", owned[0], shared[0], "native-c"];
    createPersonalLibraryOrderService(database.db).write(upstream, "alice", order);
    for (const route of [
      "/Users/alice/Views",
      "/Library/MediaFolders",
      "/Users/alice/Items?IncludeItemTypes=CollectionFolder",
    ]) {
      const all: string[] = [];
      for (let start = 0; start < order.length; start += 2) {
        const page = await ids(`${route}${route.includes("?") ? "&" : "?"}StartIndex=${start}&Limit=2`);
        expect(page.total).toBe(order.length);
        all.push(...page.ids);
      }
      expect(all).toEqual(order);
    }
    expect((await ids("/Users/alice/Sections/libraries/Items")).ids).toEqual(order);
    createVirtualLibraryStore(database.db, { ownerMemberId: memberId }).create({ name: "new" });
    expect((await ids("/Users/alice/Views")).ids.slice(1)).toEqual(order);
  });
  it("preserves identifiable legacy ordering and explicit reset restores the administrator default", async () => {
    config = {
      OrderedViews: ["native-c", owned[1], shared[0], "native-a", owned[0], "native-b", shared[1]],
      MyMediaExcludes: [shared[1]],
    };
    const before = await ids("/Users/alice/Views");
    expect(before.ids).toEqual((config.OrderedViews as string[]).filter((id) => id !== shared[1]));
    const orders = createPersonalLibraryOrderService(database.db);
    orders.reset(upstream, "alice");
    expect((await ids("/Users/alice/Views")).ids.slice(0, 2)).toEqual(owned);
  });
  it("leaves playback free of identity lookups", async () => {
    seen = [];
    expect(await (await get("/Videos/movie/stream?Static=true")).text()).toBe("unchanged-stream");
    expect(seen).toEqual(["/Videos/movie/stream"]);
  });
});
