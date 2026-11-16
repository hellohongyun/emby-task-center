import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabase, type DatabaseHandle } from "@emby-task-center/database/client";
import { upstreamVirtualLibraries } from "@emby-task-center/database/schema";
import { createVirtualLibraryStore } from "./store";
import { adminMarketSubscriber, createVirtualLibraryMarketService } from "./market-service";
import { createPersonalLibraryOrderService } from "./personal-library-order";
import { createVirtualLibraryProxy, type VirtualLibraryProxy } from "./proxy";
import { writeSettings } from "../settings/store";

describe("selective TgtoDrive discovery through the actual HTTP proxy", () => {
  const servers: Server[] = [];
  const native = Array.from({ length: 25 }, (_, index) => ({
    Id: `native-${index}`,
    Name: `Native ${index}`,
    Type: "CollectionFolder",
  }));
  const external = Array.from({ length: 15 }, (_, index) => ({
    Id: `external-${index}`,
    Name: `External ${index}`,
    Type: "CollectionFolder",
  }));
  const film = { Id: "source-film", Name: "Original film", Type: "Movie", SourceMetadata: { keep: true } };
  const sections = [
    { Id: "libraries", SectionType: "userviews" },
    { Id: "native-latest", SectionType: "latestmedia", ParentItem: native[0] },
    ...external.map((item) => ({
      Id: `tgto123-virtual-library-${item.Id}`,
      Name: item.Name,
      SectionType: "tgto123-virtual-library",
      ParentItem: item,
    })),
  ];
  let database: DatabaseHandle;
  let proxy: VirtualLibraryProxy;
  let base: string;
  let order: string[];
  let upstreamTokens: unknown[];

  async function listen(server: Server) {
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }
  async function get(path: string) {
    return fetch(base + path, { headers: { "x-emby-token": "player-token" } });
  }
  beforeEach(async () => {
    database = createDatabase(":memory:");
    upstreamTokens = [];
    const owned = createVirtualLibraryStore(database.db);
    const ownIds = Array.from({ length: 8 }, (_, index) => owned.create({ name: `Own ${index}` }).id);
    const upstream = await listen(
      createServer((request, response) => {
        const url = new URL(request.url!, "http://fixture");
        const token = request.headers["x-emby-token"];
        upstreamTokens.push(token);
        response.setHeader("content-type", "application/json");
        if (token !== "player-token") return void response.writeHead(401).end();
        if (request.method === "POST" && url.pathname === "/Users/AuthenticateByName") {
          request.resume();
          return void response.end(JSON.stringify({ AccessToken: token, User: { Id: "admin" } }));
        }
        if (url.pathname === "/Users/admin")
          return void response.end(
            JSON.stringify({ Id: "admin", Configuration: {}, Policy: { IsAdministrator: true } }),
          );
        if (url.pathname === "/Users/admin/HomeSections") return void response.end(JSON.stringify(sections));
        const sectionId = /^\/Users\/admin\/Sections\/([^/]+)\/Items$/.exec(url.pathname)?.[1];
        const parent =
          url.searchParams.get("ParentId") ??
          (sectionId ? sections.find((s) => s.Id === sectionId)?.ParentItem?.Id : undefined);
        if (parent) {
          const items = parent === "external-8" ? [film] : [];
          return void response.end(
            JSON.stringify(url.pathname.endsWith("/Latest") ? items : { Items: items, TotalRecordCount: items.length }),
          );
        }
        // The source returns its full Views list despite Limit=30, while explicit
        // root Items still contains only the physical CollectionFolders.
        const items = url.pathname === "/Items" ? native : [...native, ...external];
        response.end(JSON.stringify({ Items: items, TotalRecordCount: items.length }));
      }),
    );
    writeSettings(database.db, { "emby.baseUrl": upstream, "emby.apiKey": "service-key-never-sent" });
    const now = new Date().toISOString();
    database.db
      .insert(upstreamVirtualLibraries)
      .values(
        external.map((item) => ({
          id: `market-${item.Id}`,
          upstream,
          sourceId: item.Id,
          name: item.Name,
          createdAt: now,
          updatedAt: now,
        })),
      )
      .run();
    const market = createVirtualLibraryMarketService(database.db);
    market.patchDefaults({ adminEmbyUserId: "admin" });
    for (const index of [8, 9]) market.subscribe(adminMarketSubscriber, `market-external-${index}`, true);
    order = [...ownIds, ...native.map((item) => item.Id), "external-8", "external-9"];
    createPersonalLibraryOrderService(database.db).write(upstream, "admin", order);
    const reserve = createServer();
    base = await listen(reserve);
    await new Promise<void>((resolve) => reserve.close(() => resolve()));
    servers.splice(servers.indexOf(reserve), 1);
    proxy = createVirtualLibraryProxy({ database: database.db, appPort: 3000 });
    await proxy.configure({ enabled: true, upstream, port: Number(new URL(base).port) });
    await (
      await fetch(base + "/Users/AuthenticateByName", { method: "POST", headers: { "x-emby-token": "player-token" } })
    ).arrayBuffer();
  });
  afterEach(async () => {
    await proxy?.close();
    for (const server of servers.splice(0)) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    database?.close();
  });

  it.each([
    "/Users/admin/Views?Limit=30",
    "/Library/MediaFolders?UserId=admin&Limit=30",
    "/Items?UserId=admin&IncludeItemTypes=CollectionFolder&Recursive=false&Limit=30",
    "/Users/admin/Sections/libraries/Items?Limit=30",
  ])("retains all 35 allowed libraries including subscriptions at the end: %s", async (path) => {
    const response = await get(path);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.Items.map((item: { Id: string }) => item.Id)).toEqual(order);
    expect(body.TotalRecordCount).toBe(35);
    expect(upstreamTokens.every((token) => token === "player-token")).toBe(true);
  });

  it("preserves enabled home rows and original film DTOs, while revoking a disabled library", async () => {
    const response = await get("/Users/admin/HomeSections");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.filter((row: { SectionType: string }) => row.SectionType === "tgto123-virtual-library")).toEqual(
      sections.slice(10, 12),
    );
    for (const path of [
      "/Users/admin/Items?ParentId=external-8",
      "/Users/admin/Sections/tgto123-virtual-library-external-8/Items",
    ]) {
      const items = await get(path);
      expect(items.status).toBe(200);
      expect(await items.json()).toEqual({ Items: [film], TotalRecordCount: 1 });
    }
    const latest = await get("/Users/admin/Items/Latest?ParentId=external-8");
    expect(await latest.json()).toEqual([film]);
    expect((await get("/Users/admin/Items?ParentId=external-0")).status).toBe(404);
    expect((await get("/Users/admin/Sections/tgto123-virtual-library-external-0/Items")).status).toBe(404);
    createVirtualLibraryMarketService(database.db).subscribe(adminMarketSubscriber, "market-external-8", false);
    expect((await get("/Users/admin/Items?ParentId=external-8")).status).toBe(404);
    const remaining = await (await get("/Users/admin/HomeSections")).json();
    expect(remaining.some((row: { Id: string }) => row.Id === "tgto123-virtual-library-external-8")).toBe(false);
  });

  it("preserves an upstream empty library without inventing contents", async () => {
    const response = await get("/Users/admin/Items?ParentId=external-9");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ Items: [], TotalRecordCount: 0 });
  });
});
