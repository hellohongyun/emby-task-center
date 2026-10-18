import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabase, type DatabaseHandle } from "@emby-task-center/database/client";
import { writeSettings } from "../settings/store";
import { createVirtualLibraryProxy, type VirtualLibraryProxy } from "./proxy";
import { createVirtualLibraryStore } from "./store";

const oldItem = {
  itemId: "old-series",
  name: "仙逆",
  type: "Series",
  tmdbId: "223911",
  year: 2023,
  imageTag: "old-poster",
};
const newDto = {
  Id: "new-series",
  Name: "仙逆",
  Type: "Series",
  ProviderIds: { Tmdb: "223911" },
  ProductionYear: 2023,
  ImageTags: { Primary: "new-poster" },
  MediaSources: [{ Id: "source-original", Path: "https://media.example/play?opaque=original", Protocol: "Http" }],
  ExternalUrls: [{ Name: "原始地址", Url: "https://origin.example/title/223911" }],
};
const deniedBody = "original upstream: authentication required";

describe("virtual proxy repairs mappings with client credentials", () => {
  let database: DatabaseHandle;
  let proxy: VirtualLibraryProxy;
  let store: ReturnType<typeof createVirtualLibraryStore>;
  let libraryId: string;
  let origin: string;
  const servers: Server[] = [];
  let observed: Array<{ url: URL; token: string }>;

  async function listen(server: Server) {
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return (server.address() as AddressInfo).port;
  }
  async function freePort() {
    const server = createServer();
    const port = await listen(server);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    servers.splice(servers.indexOf(server), 1);
    return port;
  }

  beforeEach(async () => {
    database = createDatabase(":memory:");
    store = createVirtualLibraryStore(database.db);
    const library = store.create({ name: "动漫精选", collectionType: "tvshows" });
    libraryId = library.id;
    store.addItems(libraryId, [oldItem]);
    observed = [];
    const upstreamServer = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://upstream.local");
      const token = String(request.headers["x-emby-token"] ?? "");
      observed.push({ url, token });
      if (token !== "client-token") {
        response.writeHead(401, { "content-type": "text/plain", "www-authenticate": "Emby original challenge" });
        response.end(deniedBody);
        return;
      }
      if (url.pathname.endsWith("/Images/Primary")) {
        response.writeHead(200, { "content-type": "image/jpeg" }).end("original-poster-bytes");
        return;
      }
      let items = [newDto];
      const ids = url.searchParams.get("Ids");
      if (ids) items = ids.split(",").includes(newDto.Id) ? [newDto] : [];
      if (url.searchParams.has("AnyProviderIdEquals")) {
        items =
          url.searchParams.get("AnyProviderIdEquals") === "Tmdb.223911" &&
          url.searchParams.get("IncludeItemTypes") === "Series"
            ? [newDto]
            : [];
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ Items: items, TotalRecordCount: items.length }));
    });
    const upstream = `http://127.0.0.1:${await listen(upstreamServer)}`;
    writeSettings(database.db, { "emby.baseUrl": upstream, "emby.apiKey": "admin-key-must-not-be-used" });
    proxy = createVirtualLibraryProxy({ database: database.db, appPort: 3000 });
    const port = await freePort();
    await proxy.configure({ enabled: true, upstream, port });
    origin = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await proxy.close();
    for (const server of servers) server.closeAllConnections();
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
    database.close();
  });

  function clientFetch(path: string, token = "client-token") {
    return fetch(`${origin}${path}`, { headers: { "x-emby-token": token } });
  }
  function expectRepair() {
    expect(store.listItems(libraryId)).toEqual([{ ...oldItem, itemId: "new-series", imageTag: "new-poster" }]);
    const identityQueries = observed.filter(({ url }) => url.searchParams.has("AnyProviderIdEquals"));
    expect(identityQueries).toHaveLength(1);
    expect(identityQueries[0]?.url.searchParams.get("AnyProviderIdEquals")).toBe("Tmdb.223911");
    expect(identityQueries[0]?.url.searchParams.get("IncludeItemTypes")).toBe("Series");
    expect(observed.length).toBeGreaterThan(1);
    expect(observed.every(({ token }) => token === "client-token")).toBe(true);
  }

  it("repairs a missing Series and returns its original playback DTO for a virtual ParentId", async () => {
    const response = await clientFetch(`/emby/Users/client/Items?ParentId=${libraryId}&IncludeItemTypes=Series`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ Items: [newDto], TotalRecordCount: 1 });
    expectRepair();
    const finalQuery = observed.at(-1)!.url;
    expect(finalQuery.pathname).toBe("/emby/Users/client/Items");
    expect(finalQuery.searchParams.get("Ids")).toBe("new-series");
    expect(finalQuery.searchParams.has("ParentId")).toBe(false);
  });

  it.each(["detail", "cover"])("repairs before serving a virtual %s", async (entry) => {
    const path =
      entry === "detail" ? `/emby/Users/client/Items/${libraryId}` : `/emby/Items/${libraryId}/Images/Primary`;
    const response = await clientFetch(path);
    expect(response.status).toBe(200);
    if (entry === "detail") expect(await response.json()).toMatchObject({ Id: libraryId, Type: "CollectionFolder" });
    else {
      expect(await response.text()).toBe("original-poster-bytes");
      expect(observed.at(-1)!.url.pathname).toBe("/emby/Items/new-series/Images/Primary");
    }
    expectRepair();
  });

  it("preserves upstream 401 and mapping for a rejected client without substituting the admin key", async () => {
    const response = await clientFetch(`/emby/Users/client/Items?ParentId=${libraryId}`, "denied-client");
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe("Emby original challenge");
    expect(await response.text()).toBe(deniedBody);
    expect(store.listItems(libraryId)).toEqual([oldItem]);
    expect(observed.length).toBeGreaterThan(0);
    expect(observed.every(({ token }) => token === "denied-client")).toBe(true);
    expect(observed.some(({ url }) => url.searchParams.has("AnyProviderIdEquals"))).toBe(false);
  });

  it("does not perform identity queries for ordinary requests", async () => {
    const paths = [
      "/emby/Users/client/Items?ParentId=original-library",
      "/emby/Users/client/Items/original-series",
      "/emby/Items/original-series/PlaybackInfo?MediaSourceId=original-source",
    ];
    for (const path of paths) {
      const response = await clientFetch(path);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ Items: [newDto], TotalRecordCount: 1 });
    }
    expect(observed.map(({ url }) => `${url.pathname}${url.search}`)).toEqual(paths);
    expect(observed.every(({ token }) => token === "client-token")).toBe(true);
    expect(store.listItems(libraryId)).toEqual([oldItem]);
  });
});
