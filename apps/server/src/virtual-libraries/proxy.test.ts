import { createServer, request as httpRequest, type Server } from "node:http";
import { connect, type AddressInfo, type Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabase, type DatabaseHandle } from "@emby-task-center/database/client";
import { writeSettings } from "../settings/store";
import { createVirtualLibraryProxy, type VirtualLibraryProxy } from "./proxy";
import { readVirtualProxyConfig } from "./proxy-settings";
import { createVirtualLibraryStore } from "./store";

describe("virtual proxy lifecycle and real upstream behavior", () => {
  let database: DatabaseHandle;
  let proxy: VirtualLibraryProxy;
  const servers: Server[] = [];
  const sockets = new Set<Socket>();
  let upstream: string;
  let deletionStatus: number;
  let observed: { method?: string; url?: string; token?: string };
  let infoStatus: number;
  let info: Record<string, unknown>;
  let browseReply: { status: number; headers: Record<string, string>; body: string } | undefined;
  async function listen(server: Server, host = "127.0.0.1") {
    servers.push(server);
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) => server.listen(0, host, resolve));
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
    deletionStatus = 401;
    infoStatus = 200;
    info = {
      Id: "original-server",
      LocalAddress: "http://original:8096",
      WanAddress: "https://original.test",
      LocalAddresses: ["http://original:8096"],
      WebSocketPortNumber: 8096,
      OtherUrl: "https://cdn.test/play?token=opaque",
    };
    observed = {};
    browseReply = undefined;
    const server = createServer((request, response) => {
      observed = { method: request.method, url: request.url, token: String(request.headers["x-emby-token"] ?? "") };
      if (request.url?.endsWith("/Views") && browseReply) {
        response.writeHead(browseReply.status, browseReply.headers).end(browseReply.body);
        return;
      }
      if (request.method === "DELETE") {
        response.writeHead(deletionStatus).end();
        return;
      }
      if (request.url?.includes("/System/Info")) {
        response.writeHead(infoStatus, { "content-type": "application/json" }).end(JSON.stringify(info));
        return;
      }
      if (request.url === "/hold") {
        response.writeHead(200);
        response.write("ongoing");
        return;
      }
      response.end("upstream-ok");
    });
    server.on("upgrade", (_request, socket) => {
      socket.write("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n");
      socket.on("data", (chunk) => socket.write(chunk));
      socket.once("end", () => socket.end());
    });
    upstream = `http://127.0.0.1:${await listen(server)}`;
    writeSettings(database.db, { "emby.baseUrl": upstream, "emby.apiKey": "administrator-key-never-forwarded" });
    proxy = createVirtualLibraryProxy({ database: database.db, appPort: 3000 });
  });
  afterEach(async () => {
    await proxy.close();
    for (const socket of sockets) socket.destroy();
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
    database.close();
  });

  it("does not listen by default and preserves disabled configuration on startup", async () => {
    expect(readVirtualProxyConfig(database.db).enabled).toBe(false);
    await proxy.start();
    expect(proxy.status()).toEqual({ running: false, port: null, error: null });
    expect(readVirtualProxyConfig(database.db).enabled).toBe(false);
  });

  it("persists configurations across controller restarts and preserves active listener after an occupied-port failure", async () => {
    const port = await freePort();
    const config = { enabled: true, upstream, port };
    await proxy.configure(config);
    expect(readVirtualProxyConfig(database.db)).toEqual(config);
    expect(await (await fetch(`http://127.0.0.1:${port}/ping`)).text()).toBe("upstream-ok");
    const busy = await listen(createServer(), "::");
    await expect(proxy.configure({ ...config, port: busy })).rejects.toThrow();
    expect(proxy.status()).toMatchObject({ running: true, port });
    expect(readVirtualProxyConfig(database.db)).toEqual(config);
    expect(await (await fetch(`http://127.0.0.1:${port}/ping`)).text()).toBe("upstream-ok");
    await proxy.close();
    proxy = createVirtualLibraryProxy({ database: database.db, appPort: 3000 });
    await proxy.start();
    expect(proxy.status()).toEqual({ running: true, port, error: null });
    await proxy.configure({ ...config, enabled: false });
    expect(proxy.status().running).toBe(false);
    expect(readVirtualProxyConfig(database.db).enabled).toBe(false);
  });

  it("forwards original DELETE and credentials, removing associations only when upstream succeeds", async () => {
    const store = createVirtualLibraryStore(database.db);
    const first = store.create({ name: "一" });
    const second = store.create({ name: "二" });
    const item = { itemId: "original", name: "原影片", type: "Movie", year: null, imageTag: null };
    store.addItems(first.id, [item]);
    store.addItems(second.id, [item]);
    const port = await freePort();
    await proxy.configure({ enabled: true, upstream, port });
    const url = `http://127.0.0.1:${port}/emby/Items/original?DeleteFileLocation=true&api_key=user-key`;
    expect((await fetch(url, { method: "DELETE", headers: { "x-emby-token": "user-key" } })).status).toBe(401);
    expect(store.listItems(first.id)).toEqual([item]);
    expect(observed).toEqual({
      method: "DELETE",
      url: "/emby/Items/original?DeleteFileLocation=true&api_key=user-key",
      token: "user-key",
    });
    deletionStatus = 204;
    expect((await fetch(url, { method: "DELETE", headers: { "x-emby-token": "user-key" } })).status).toBe(204);
    expect(store.listItems(first.id)).toEqual([]);
    expect(store.listItems(second.id)).toEqual([]);
  });

  it("leaves original server info and links unchanged regardless of forwarding headers or status", async () => {
    const port = await freePort();
    await proxy.configure({ enabled: true, upstream, port });
    const url = `http://127.0.0.1:${port}/emby/System/Info/Public`;
    const direct = await (await fetch(url)).json();
    expect(direct).toEqual(info);
    const forwarded = await (
      await fetch(url, { headers: { "x-forwarded-host": "entry.test:8443", "x-forwarded-proto": "https" } })
    ).json();
    expect(forwarded).toEqual(info);
    infoStatus = 401;
    expect(await (await fetch(url)).json()).toEqual(info);
    expect(observed.token).toBe("");
  });

  it("closes ongoing playback and upgraded connections when stopped", async () => {
    const port = await freePort();
    await proxy.configure({ enabled: true, upstream, port });
    const connections: Promise<void>[] = [];
    async function openConnection(path: string, upgrade = false) {
      const socket = connect(port, "127.0.0.1");
      sockets.add(socket);
      connections.push(new Promise<void>((resolve) => socket.once("close", () => resolve())));
      const ready = new Promise<void>((resolve, reject) => {
        socket.once("data", () => resolve());
        socket.once("error", reject);
      });
      socket.write(
        `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n${upgrade ? "Connection: Upgrade\r\nUpgrade: websocket\r\n" : ""}\r\n`,
      );
      await ready;
    }
    await openConnection("/hold");
    await openConnection("/embywebsocket", true);
    const allClosed = [...sockets].map(
      (socket) => new Promise<void>((resolve) => socket.once("close", () => resolve())),
    );
    await proxy.close();
    await Promise.all([...connections, ...allClosed]);
    expect(proxy.status().running).toBe(false);
    expect(
      await fetch(`http://127.0.0.1:${port}/ping`).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
  });

  it("preserves original browsing failures, redirect links, headers and non-JSON bodies", async () => {
    createVirtualLibraryStore(database.db).create({ name: "精选" });
    const port = await freePort();
    await proxy.configure({ enabled: true, upstream, port });
    for (const status of [302, 401]) {
      browseReply = {
        status,
        headers: {
          location: "/original/login?next=unchanged",
          "content-type": "text/html",
          "www-authenticate": 'Emby realm="original"',
          "x-original": "keep",
        },
        body: "<html>请登录 & continue</html>",
      };
      const response = await fetch(`http://127.0.0.1:${port}/emby/Users/user/Views`, { redirect: "manual" });
      expect(response.status).toBe(status);
      expect(response.headers.get("location")).toBe(browseReply.headers.location);
      expect(response.headers.get("content-type")).toBe("text/html");
      expect(response.headers.get("x-original")).toBe("keep");
      expect(await response.text()).toBe(browseReply.body);
    }
  });

  it("contains malformed proxy requests without affecting the existing process or next request", async () => {
    const port = await freePort();
    await proxy.configure({ enabled: true, upstream, port });
    const status = await new Promise<number>((resolve, reject) => {
      const request = httpRequest({ host: "127.0.0.1", port, path: "http://[" }, (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode!));
      });
      request.on("error", reject);
      request.end();
    });
    expect(status).toBe(502);
    expect(await (await fetch(`http://127.0.0.1:${port}/ping`)).text()).toBe("upstream-ok");
  });
});
