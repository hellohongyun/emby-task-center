import { createServer, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabase, type DatabaseHandle } from "@emby-task-center/database/client";
import { writeSettings } from "../settings/store";
import { createVirtualLibraryProxy, type VirtualLibraryProxy } from "./proxy";
import { createVirtualLibraryStore } from "./store";

const real = {
  Id: "101",
  Guid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  Name: "Original library",
  ServerId: "original-server",
  Type: "CollectionFolder",
  IsFolder: true,
  UserData: { IsFavorite: true },
};
const sections = [
  { Id: "dynamic-row-917", SectionType: "userviews", Name: "My media", ViewType: "cards" },
  { Id: "resume-dynamic", SectionType: "resume", Name: "Continue watching" },
  { Id: "ttd-dynamic", SectionType: "ttd-feature", Name: "Upstream feature" },
];

describe("modern Emby library discovery through real HTTP", () => {
  let database: DatabaseHandle;
  let proxy: VirtualLibraryProxy;
  let server: Server;
  let base: string;
  let virtualId: string;
  let configuration: Record<string, unknown>;
  const sockets = new Set<Socket>();
  const observed: { path: string; method: string; body: string; contentType: string; token: string }[] = [];

  beforeEach(async () => {
    observed.length = 0;
    database = createDatabase(":memory:");
    virtualId = createVirtualLibraryStore(database.db).create({ name: "Virtual library" }).id;
    configuration = { OrderedViews: [virtualId, real.Guid], MyMediaExcludes: [] };
    server = createServer(async (request, response) => {
      const url = new URL(request.url!, "http://fixture");
      const path = url.pathname.replace(/^\/emby/, "");
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString("utf8");
      const token = String(request.headers["x-emby-token"] ?? "");
      observed.push({
        path: request.url!,
        method: request.method!,
        body,
        contentType: String(request.headers["content-type"] ?? ""),
        token,
      });
      if (token !== "user-token") {
        response.writeHead(401, { "content-type": "application/json", "www-authenticate": "Emby" });
        response.end('{"error":"unauthorized"}');
        return;
      }
      if (request.method === "POST" && path === "/Users/u/Configuration/Partial") {
        configuration = { ...configuration, ...JSON.parse(body) };
        response.writeHead(204).end();
        return;
      }
      let result: unknown;
      if (path === "/Users/u") result = { Id: "u", Configuration: configuration };
      else if (path === "/Users/u/HomeSections") result = sections;
      else if (/\/Sections\/(resume|ttd)-dynamic\/Items$/.test(path)) {
        result = { Items: [{ Id: "upstream-content", Type: "Movie" }], TotalRecordCount: 1, UpstreamOnly: true };
      } else if (url.searchParams.has("Ids")) {
        // Reproduce TTD's ignored Ids behavior: an unrelated default page is returned.
        result = {
          Items: [real, ...Array.from({ length: 25 }, (_, i) => ({ Id: `unrelated-${i}`, Type: "Movie" }))],
          TotalRecordCount: 26,
        };
      } else result = { Items: [real], TotalRecordCount: 1, UpstreamMarker: true };
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(result));
    });
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const upstream = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    writeSettings(database.db, { "emby.baseUrl": upstream, "emby.apiKey": "admin-key-never-forwarded" });
    const reservation = createServer();
    await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
    const port = (reservation.address() as AddressInfo).port;
    await new Promise<void>((resolve) => reservation.close(() => resolve()));
    proxy = createVirtualLibraryProxy({ database: database.db, appPort: 3000 });
    await proxy.configure({ enabled: true, upstream, port });
    base = `http://127.0.0.1:${port}/emby`;
  });

  afterEach(async () => {
    await proxy.close();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    database.close();
  });

  async function get(path: string, token = "user-token") {
    return fetch(`${base}${path}`, { headers: { "x-emby-token": token, connection: "close" } });
  }
  async function ids(path: string) {
    const response = await get(path);
    expect(response.status).toBe(200);
    const result = await response.json();
    return { ...result, ids: result.Items.map((item: { Id: string }) => item.Id) };
  }

  it("preserves HomeSections and injects the dynamically identified home library row", async () => {
    expect(await (await get("/Users/u/HomeSections?displayMode=mobile,desktop")).json()).toEqual(sections);
    const row = await ids("/Users/u/Sections/dynamic-row-917/Items");
    expect(row.ids).toEqual([virtualId, "101"]);
    expect(row.TotalRecordCount).toBe(2);
    expect(row.UpstreamMarker).toBe(true);
    expect(row.Items[1]).toEqual(real);
    expect(observed.every((request) => request.token === "user-token")).toBe(true);
  });

  it("reuses successful HomeSections classification across rows without skipping items authentication", async () => {
    await get("/Users/u/HomeSections");
    expect((await ids("/Users/u/Sections/resume-dynamic/Items")).ids).toEqual(["upstream-content"]);
    expect((await ids("/Users/u/Sections/dynamic-row-917/Items")).ids).toEqual([virtualId, "101"]);
    const homeRequests = () => observed.filter((request) => request.path.endsWith("/HomeSections"));
    expect(homeRequests()).toHaveLength(1);
    expect(observed.some((request) => request.path.endsWith("/Sections/dynamic-row-917/Items"))).toBe(true);
    const denied = await get("/Users/u/Sections/dynamic-row-917/Items", "invalid-token");
    expect(denied.status).toBe(401);
    expect(await denied.json()).toEqual({ error: "unauthorized" });
    expect(homeRequests().filter((request) => request.token === "invalid-token")).toHaveLength(1);
    expect(observed.some((request) => request.token === "invalid-token" && request.path.includes("/Sections/"))).toBe(
      true,
    );
  });

  it("passes text/plain partial configuration unchanged and reads the new Guid-based order", async () => {
    expect((await ids("/Users/u/Views")).ids).toEqual([virtualId, "101"]);
    const body = JSON.stringify({ OrderedViews: [real.Guid, virtualId], HidePlayedInLatest: true });
    const response = await fetch(`${base}/Users/u/Configuration/Partial?reqformat=json`, {
      method: "POST",
      headers: { "content-type": "text/plain", "x-emby-token": "user-token", connection: "close" },
      body,
    });
    expect(response.status).toBe(204);
    expect(observed.at(-1)).toEqual({
      path: "/emby/Users/u/Configuration/Partial?reqformat=json",
      method: "POST",
      contentType: "text/plain",
      token: "user-token",
      body,
    });
    expect(configuration).toMatchObject({ OrderedViews: [real.Guid, virtualId], HidePlayedInLatest: true });
    expect((await ids("/Users/u/Views?IncludeHidden=true&AllowDynamicChildren=false")).ids).toEqual(["101", virtualId]);
    expect((await ids("/Users/u/Sections/dynamic-row-917/Items")).ids).toEqual(["101", virtualId]);
  });

  it("paginates the combined home row after applying user order", async () => {
    const row = await ids("/Users/u/Sections/dynamic-row-917/Items?Limit=1&StartIndex=1");
    expect(row.ids).toEqual(["101"]);
    expect(row.TotalRecordCount).toBe(2);
    const itemsRequest = observed.find((request) => request.path.includes("/Sections/dynamic-row-917/Items"));
    expect(itemsRequest?.path).not.toContain("Limit");
    expect(itemsRequest?.path).not.toContain("StartIndex");
  });

  it("exposes the same virtual library through MediaFolders", async () => {
    const folders = await ids("/Library/MediaFolders?UserId=u");
    expect(folders.ids).toEqual([virtualId, "101"]);
    expect(folders.TotalRecordCount).toBe(2);
  });

  it.each(["/Items", "/Users/u/Items"])("filters ignored upstream Ids responses for mixed lookup %s", async (path) => {
    const items = await ids(`${path}?Ids=${virtualId},101&UserId=u`);
    expect(items.ids).toEqual([virtualId, "101"]);
    expect(items.TotalRecordCount).toBe(2);
    const upstreamLookup = observed.find((request) => new URL(request.path, "http://fixture").searchParams.has("Ids"));
    expect(new URL(upstreamLookup!.path, "http://fixture").searchParams.get("Ids")).toBe("101");
    expect(items.Items.some((item: { Id: string }) => item.Id.startsWith("unrelated-"))).toBe(false);
  });

  it("authenticates virtual-only lookup without asking upstream to resolve virtual IDs", async () => {
    const items = await ids(`/Users/u/Items?Ids=${virtualId}`);
    expect(items.ids).toEqual([virtualId]);
    expect(observed.every((request) => !request.path.includes("Ids="))).toBe(true);
  });

  it.each(["resume", "ttd"])("leaves %s section responses unchanged", async (type) => {
    const row = await (await get(`/Users/u/Sections/${type}-dynamic/Items`)).json();
    expect(row).toEqual({
      Items: [{ Id: "upstream-content", Type: "Movie" }],
      TotalRecordCount: 1,
      UpstreamOnly: true,
    });
  });

  it.each(["/Users/u/Sections/dynamic-row-917/Items", "/Library/MediaFolders?UserId=u", "/Users/u/Items?Ids=VIRTUAL"])(
    "preserves authentication failures for %s",
    async (path) => {
      const response = await get(path.replace("VIRTUAL", virtualId), "invalid-token");
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toBe("Emby");
      expect(await response.json()).toEqual({ error: "unauthorized" });
      expect(observed.every((request) => request.token === "invalid-token")).toBe(true);
    },
  );
});
