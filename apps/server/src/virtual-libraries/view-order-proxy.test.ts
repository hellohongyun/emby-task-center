import { createServer, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabase, type DatabaseHandle } from "@emby-task-center/database/client";
import { writeSettings } from "../settings/store";
import { createVirtualLibraryProxy, type VirtualLibraryProxy } from "./proxy";
import { createVirtualLibraryStore } from "./store";

describe("virtual library order through real HTTP proxy", () => {
  let database: DatabaseHandle;
  let proxy: VirtualLibraryProxy;
  let server: Server;
  let base: string;
  let virtualId: string;
  const sockets = new Set<Socket>();
  const configurations = new Map<string, Record<string, unknown>>();
  const observed: { path: string; token: string; body: string }[] = [];

  beforeEach(async () => {
    configurations.clear();
    observed.length = 0;
    database = createDatabase(":memory:");
    virtualId = createVirtualLibraryStore(database.db).create({ name: "精选" }).id;
    server = createServer(async (request, response) => {
      const path = new URL(request.url!, "http://fixture").pathname;
      const user = /^\/emby\/Users\/([^/]+)/.exec(path)?.[1];
      const token = String(request.headers["x-emby-token"] ?? "");
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString("utf8");
      observed.push({ path, token, body });
      if (!user || token !== `${user}-token`) {
        response.writeHead(401, { "content-type": "application/json" }).end('{"error":"unauthorized"}');
        return;
      }
      if (request.method === "POST" && path.endsWith("/Configuration")) {
        configurations.set(user, JSON.parse(body));
        response.writeHead(204).end();
        return;
      }
      const result = path.endsWith("/Views")
        ? { Items: [{ Id: "original-a" }, { Id: "original-b" }], TotalRecordCount: 2 }
        : { Id: user, Configuration: configurations.get(user) ?? {} };
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
    base = `http://127.0.0.1:${port}/emby/Users`;
  });

  afterEach(async () => {
    await proxy.close();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    database.close();
  });

  async function save(user: string, order: string[]) {
    const body = JSON.stringify({ OrderedViews: order, AudioLanguagePreference: "zho", HidePlayedInLatest: true });
    const response = await fetch(`${base}/${user}/Configuration`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-emby-token": `${user}-token`, connection: "close" },
      body,
    });
    expect(response.status).toBe(204);
    expect(observed.at(-1)).toEqual({ path: `/emby/Users/${user}/Configuration`, token: `${user}-token`, body });
    expect(configurations.get(user)).toEqual(JSON.parse(body));
  }

  async function views(user: string) {
    const response = await fetch(`${base}/${user}/Views`, {
      headers: { "x-emby-token": `${user}-token`, connection: "close" },
    });
    expect(response.status).toBe(200);
    return (await response.json()).Items.map((item: { Id: string }) => item.Id);
  }

  it("preserves configuration writes and reads persisted per-user order after controller restart", async () => {
    const aliceOrder = ["original-b", virtualId, "original-a"];
    const bobOrder = [virtualId, "original-a", "original-b"];
    await save("alice", aliceOrder);
    await save("bob", bobOrder);
    expect(await views("alice")).toEqual(aliceOrder);
    expect(await views("bob")).toEqual(bobOrder);
    await proxy.close();
    proxy = createVirtualLibraryProxy({ database: database.db, appPort: 3000 });
    await proxy.start();
    expect(await views("alice")).toEqual(aliceOrder);
    expect(await views("bob")).toEqual(bobOrder);
    expect(observed.filter((entry) => entry.path === "/emby/Users/alice")).toHaveLength(2);
    expect(observed.filter((entry) => entry.path === "/emby/Users/bob")).toHaveLength(2);
    expect(observed.every((entry) => entry.token !== "admin-key-never-forwarded")).toBe(true);
  });

  it("passes unauthorized views through without exposing virtual libraries or reading preferences", async () => {
    const response = await fetch(`${base}/alice/Views`, { headers: { "x-emby-token": "bob-token" } });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
    expect(observed).toEqual([{ path: "/emby/Users/alice/Views", token: "bob-token", body: "" }]);
  });
});
