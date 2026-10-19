import { createServer, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabase, type DatabaseHandle } from "@emby-task-center/database/client";
import { writeSettings } from "../settings/store";
import { createVirtualLibraryProxy, type VirtualLibraryProxy } from "./proxy";
import { createVirtualLibraryStore } from "./store";

const ttd = { Id: "11111111-1111-5111-8111-111111111111", Guid: "11111111111151118111111111111111", Name: "TTD" };
const native = { Id: "123", Guid: "22222222222252228222222222222222", Name: "Native" };

describe("owned order across an upstream TTD library", () => {
  let database: DatabaseHandle;
  let proxy: VirtualLibraryProxy;
  let server: Server;
  let base: string;
  let owned: string;
  let rejectSave: boolean;
  const configurations = new Map<string, Record<string, unknown>>();
  const writes: { path: string; body: string; contentType: string }[] = [];
  const sockets = new Set<Socket>();

  beforeEach(async () => {
    rejectSave = false;
    configurations.clear();
    writes.length = 0;
    database = createDatabase(":memory:");
    owned = createVirtualLibraryStore(database.db).create({ name: "Owned" }).id;
    server = createServer(async (request, response) => {
      const url = new URL(request.url!, "http://fixture");
      const path = url.pathname.replace(/^\/emby/, "");
      const user = /^\/Users\/([^/]+)/.exec(path)?.[1];
      if (!user || request.headers["x-emby-token"] !== `${user}-token`) {
        response.writeHead(401).end("unauthorized");
        return;
      }
      if (request.method === "POST") {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = Buffer.concat(chunks).toString();
        writes.push({ path: request.url!, body, contentType: String(request.headers["content-type"]) });
        if (rejectSave) {
          response.writeHead(403).end("denied");
          return;
        }
        const next = JSON.parse(body);
        // Real upstream configuration contains our IDs and native GUIDs, but no TTD IDs.
        // Keep this normalization in the fixture so a verbatim echo cannot hide the bug.
        if (Array.isArray(next.OrderedViews))
          next.OrderedViews = next.OrderedViews.filter((id: string) => id !== ttd.Guid && id !== ttd.Id);
        configurations.set(user, { ...configurations.get(user), ...next });
        response.writeHead(204).end();
        return;
      }
      const body =
        path.endsWith("/Views") || path.endsWith("/Sections/tiles/Items")
          ? { Items: [ttd, native], TotalRecordCount: 2, Upstream: "unchanged" }
          : path.endsWith("/HomeSections")
            ? [{ Id: "tiles", SectionType: "userviews" }]
            : { Id: user, Configuration: configurations.get(user) ?? {} };
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
    });
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const upstream = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    writeSettings(database.db, { "emby.baseUrl": upstream });
    const reservation = createServer();
    await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
    const port = (reservation.address() as AddressInfo).port;
    await new Promise<void>((resolve) => reservation.close(() => resolve()));
    proxy = createVirtualLibraryProxy({ database: database.db, appPort: 3000 });
    await proxy.configure({ enabled: true, upstream, port });
    base = `http://127.0.0.1:${port}/emby/Users`;
  });

  afterEach(async () => {
    await proxy.close();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    database.close();
  });

  async function save(order: string[], user = "alice") {
    const body = JSON.stringify({ OrderedViews: order, AudioLanguagePreference: "zho" });
    const response = await fetch(`${base}/${user}/Configuration/Partial?reqformat=json`, {
      method: "POST",
      headers: { "content-type": "text/plain", "x-emby-token": `${user}-token`, connection: "close" },
      body,
    });
    expect(writes.at(-1)).toEqual({
      path: `/emby/Users/${user}/Configuration/Partial?reqformat=json`,
      body,
      contentType: "text/plain",
    });
    return response.status;
  }

  async function views(user = "alice", section = false, limit?: number) {
    const response = await fetch(
      `${base}/${user}/${section ? "Sections/tiles/Items" : "Views?IncludeHidden=true&AllowDynamicChildren=false"}${limit ? `&Limit=${limit}` : ""}`,
      {
        headers: { "x-emby-token": `${user}-token`, connection: "close" },
      },
    );
    const body = await response.json();
    expect(body.Items.filter((item: { Id: string }) => item.Id !== owned)).toEqual([ttd, native]);
    expect(body.Upstream).toBe("unchanged");
    return body.Items.map((item: { Id: string }) => item.Id);
  }

  it("keeps an owned library before TTD after upstream drops TTD from OrderedViews", async () => {
    expect(await save([owned, ttd.Guid, native.Guid])).toBe(204);
    expect(configurations.get("alice")?.OrderedViews).toEqual([owned, native.Guid]);
    expect(await views()).toEqual([owned, ttd.Id, native.Id]);
    expect(await views("alice", false, 100)).toEqual([owned, ttd.Id, native.Id]);
    expect(await views("alice", true)).toEqual([owned, ttd.Id, native.Id]);
    await proxy.close();
    proxy = createVirtualLibraryProxy({ database: database.db, appPort: 3000 });
    await proxy.start();
    expect(await views()).toEqual([owned, ttd.Id, native.Id]);
  });

  it("supports moving back across TTD and isolates other users", async () => {
    await save([owned, ttd.Guid, native.Guid]);
    await save([ttd.Guid, owned, native.Guid]);
    expect(await views()).toEqual([ttd.Id, owned, native.Id]);
    expect(await views("bob")).toEqual([ttd.Id, native.Id, owned]);
  });

  it("does not save a failed upstream preference update locally", async () => {
    await save([ttd.Guid, owned, native.Guid]);
    rejectSave = true;
    expect(await save([owned, ttd.Guid, native.Guid])).toBe(403);
    expect(await views()).toEqual([ttd.Id, owned, native.Id]);
  });
});
