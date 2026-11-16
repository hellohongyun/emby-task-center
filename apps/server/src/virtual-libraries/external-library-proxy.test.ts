import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabase, type DatabaseHandle } from "@emby-task-center/database/client";
import { createVirtualLibraryStore } from "./store";
import { createVirtualProxyHandler } from "./proxy-handler";

describe("registered upstream market libraries over HTTP", () => {
  let database: DatabaseHandle;
  const servers: Server[] = [];
  let base: string;
  let enabled: boolean;
  let seen: { path: string; token: unknown }[];
  const virtual = {
    Id: "ttd-library",
    Guid: "ttd-guid",
    Name: "TgtoDrive",
    Type: "CollectionFolder",
    Ttd: { keep: true },
  };
  const native = (Id: string) => ({ Id, Name: Id, Type: "CollectionFolder" });
  const all = [native("native-a"), virtual, native("native-b")];
  async function listen(server: Server) {
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }
  function get(path: string, token = "alice-token", method = "GET") {
    return fetch(base + path, { method, headers: token ? { "X-Emby-Token": token } : {} });
  }
  async function list(path: string) {
    const response = await get(path);
    expect(response.status).toBe(200);
    return response.json() as Promise<{ Items: { Id: string }[]; TotalRecordCount: number }>;
  }
  beforeEach(async () => {
    database = createDatabase(":memory:");
    enabled = false;
    seen = [];
    const upstream = await listen(
      createServer((request, response) => {
        const url = new URL(request.url!, "http://fixture");
        const token = request.headers["x-emby-token"];
        seen.push({ path: url.pathname + url.search, token });
        response.setHeader("Content-Type", "application/json");
        if (url.pathname === "/Users/AuthenticateByName") {
          request.resume();
          return void response.end(JSON.stringify({ AccessToken: token, User: { Id: "alice" } }));
        }
        if (token !== "alice-token") return void response.writeHead(401).end();
        if (url.pathname === "/Users/alice")
          return void response.end(JSON.stringify({ Id: "alice", Configuration: {} }));
        if (url.pathname.endsWith("/HomeSections"))
          return void response.end(
            JSON.stringify([
              { Id: "library-row", SectionType: "userviews" },
              { Id: "opaque-latest-row", SectionType: "latestmedia", ParentItem: virtual },
              { Id: "native-row", SectionType: "latestmedia", ParentId: "native-a" },
            ]),
          );
        if (url.pathname.includes("/Images/") || url.pathname.startsWith("/Videos/")) {
          response.setHeader("Content-Type", "application/octet-stream");
          return void response.end("original-binary");
        }
        if (/\/Items\/[^/]+$/.test(url.pathname) && !url.pathname.includes("/Sections/"))
          return void response.end(JSON.stringify(virtual));
        if (url.pathname.includes("opaque-latest-row") || url.searchParams.has("ParentId"))
          return void response.end(JSON.stringify({ Items: [{ Id: "film", Type: "Movie" }], TotalRecordCount: 1 }));
        const start = Number(url.searchParams.get("StartIndex") ?? 0);
        const limit = Math.min(Number(url.searchParams.get("Limit") ?? 2), 2);
        response.end(
          JSON.stringify({ Items: all.slice(start, start + limit), TotalRecordCount: all.length, Opaque: "keep" }),
        );
      }),
    );
    const store = createVirtualLibraryStore(database.db, { all: true });
    base = await listen(
      createServer(
        createVirtualProxyHandler(
          store,
          () => upstream,
          "external-market-fixture",
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          (id) =>
            id === "alice"
              ? {
                  subscriberId: "member:1",
                  ownLibraryIds: [],
                  visibleLibraryIds: [],
                  personalOrder: [virtual.Id, "native-b", "native-a"],
                }
              : undefined,
          (id) => ({ libraries: [{ id: virtual.Id, aliases: [virtual.Guid], enabled: id === "alice" && enabled }] }),
        ),
      ),
    );
    await (await get("/Users/AuthenticateByName", "alice-token", "POST")).arrayBuffer();
  });
  afterEach(async () => {
    for (const server of servers.reverse().splice(0)) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    database.close();
  });
  it("filters and orders complete discovery lists before paging, with no project-created library", async () => {
    for (const path of [
      "/Users/alice/Views",
      "/Library/MediaFolders?UserId=alice",
      "/Users/alice/Items?IncludeItemTypes=CollectionFolder",
      "/Users/alice/Sections/library-row/Items",
    ]) {
      const separator = path.includes("?") ? "&" : "?";
      const first = await list(path + separator + "Limit=1&StartIndex=0");
      expect(first.Items.map((item) => item.Id)).toEqual(["native-b"]);
      expect(first.TotalRecordCount).toBe(2);
      const second = await list(path + separator + "Limit=1&StartIndex=1");
      expect(second.Items.map((item) => item.Id)).toEqual(["native-a"]);
    }
    enabled = true;
    const body = await list("/Users/alice/Views");
    expect(body.Items.map((item) => item.Id)).toEqual([virtual.Id, "native-b", "native-a"]);
    expect(body.Items[0]).toEqual(virtual);
    expect(body.TotalRecordCount).toBe(3);
  });
  it("immediately blocks direct IDs, aliases, posters and cached opaque home sections after disabling", async () => {
    enabled = true;
    expect((await get("/Users/alice/HomeSections")).status).toBe(200);
    expect((await get("/Users/alice/Sections/opaque-latest-row/Items")).status).toBe(200);
    enabled = false;
    const sections = await (await get("/Users/alice/HomeSections")).json();
    expect(sections.map((row: { Id: string }) => row.Id)).toEqual(["library-row", "native-row"]);
    for (const path of [
      "/Items/ttd-library",
      "/Items/ttd-guid",
      "/emby/Items/ttd-library",
      "/Users/alice/Items?ParentId=ttd-guid",
      "/Items/ttd-library/Images/Primary?tag=known",
      "/Users/alice/Sections/opaque-latest-row/Items",
      "/Items?Ids=native-a,ttd-library",
    ])
      expect((await get(path)).status, path).toBe(404);
    expect((await get("/Items/ttd-library/Images/Thumb", "alice-token", "HEAD")).status).toBe(404);
    expect((await get("/Items/ttd-library", "")).status).toBe(404);
    expect((await get("/Items/ttd-library?UserId=alice", "fake-token")).status).toBe(404);
  });
  it("preserves enabled source images, parameters and playback with the original client token", async () => {
    enabled = true;
    expect(await (await get("/Items/ttd-library/Images/Primary?tag=upstream-tag")).text()).toBe("original-binary");
    expect((await get("/Items?ParentId=ttd-library&OpaqueOption=keep%2Bthis")).status).toBe(200);
    enabled = false;
    expect(await (await get("/Videos/film/stream?MediaSourceId=original")).text()).toBe("original-binary");
    expect(seen.some((entry) => entry.path.includes("OpaqueOption=keep%2Bthis"))).toBe(true);
    expect(seen.every((entry) => entry.token === "alice-token" || entry.token === "fake-token")).toBe(true);
  });
});
