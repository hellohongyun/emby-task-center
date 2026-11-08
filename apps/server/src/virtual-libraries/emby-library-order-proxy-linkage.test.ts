import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createDatabase } from "@emby-task-center/database/client";
import { expect, it } from "vitest";
import { createApp } from "../app";
import { staticCredentialVerifier } from "../auth/test-session";
import { createEmbyClient } from "../integrations/emby-client";
import { createLibraryService } from "../library/service";
import type { TmdbClient } from "../tmdb/client";
import { createVirtualLibraryProxy } from "./proxy";
import { createVirtualLibraryStore } from "./store";

const endpoint = "/api/emby/library-order";
const films = { Id: "101", Guid: "a".repeat(32), Name: "电影", Type: "CollectionFolder" };
const series = { Id: "102", Guid: "b".repeat(32), Name: "电视剧", Type: "CollectionFolder" };
const privateLibrary = { Id: "103", Guid: "c".repeat(32), Name: "专享库", Type: "CollectionFolder" };
const hidden = { Id: "104", Guid: "d".repeat(32), Name: "已隐藏", Type: "CollectionFolder" };
const admin = { Id: "admin", Name: "模板", Policy: { IsAdministrator: true } };
const member = { Id: "member", Name: "会员", Policy: { IsAdministrator: false } };
const managementToken = "fixture-management-token";
const playbackToken = "fixture-member-token";

async function listen(server: Server): Promise<string> {
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function close(server: Server) {
  await new Promise<void>((done) => {
    server.close(() => done());
    server.closeAllConnections();
  });
}

it("links management confirmation to native views and the player proxy with independent virtual-library placement", async () => {
  const database = createDatabase(":memory:");
  const owned = createVirtualLibraryStore(database.db).create({ name: "本地虚拟库" }).id;
  const memberPreferences = {
    OrderedViews: [films.Guid, hidden.Guid, privateLibrary.Guid, series.Guid],
    MyMediaExcludes: [hidden.Guid],
    AudioLanguagePreference: "zho",
  };
  const managementWrites: { user: string; body: object }[] = [];
  const upstream = createServer(async (request, response) => {
    const path = new URL(request.url!, "http://fixture").pathname.replace(/^\/emby/, "");
    const token = request.headers["x-emby-token"];
    const json = (body: unknown) =>
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
    if (path === "/Videos/fixture/stream.mp4" && token === playbackToken) {
      if (request.headers.range !== "bytes=0-3") return void response.writeHead(416).end();
      response.writeHead(206, { "content-type": "video/mp4", "content-range": "bytes 0-3/8" }).end("clip");
      return;
    }
    if (path === "/Users" && token === managementToken) return void json([admin, member]);
    const id = /^\/Users\/([^/]+)/.exec(path)?.[1];
    if (!id || (token !== managementToken && (id !== member.Id || token !== playbackToken))) {
      response.writeHead(401).end();
      return;
    }
    if (request.method === "POST" && path.endsWith("/Configuration/Partial")) {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (id !== member.Id) return void response.writeHead(403).end();
      if (token === managementToken) managementWrites.push({ user: id, body });
      Object.assign(memberPreferences, body);
      response.writeHead(204).end();
      return;
    }
    const configuration = id === member.Id ? memberPreferences : { OrderedViews: [series.Guid, films.Guid] };
    if (path.endsWith("/Views")) {
      const available = id === member.Id ? [films, series, privateLibrary] : [films, series];
      const Items = configuration.OrderedViews.flatMap((key) => available.filter(({ Guid }) => Guid === key));
      return void json({ Items, TotalRecordCount: Items.length });
    }
    json({ ...(id === member.Id ? member : admin), Configuration: configuration });
  });
  const upstreamUrl = await listen(upstream);
  const app = createApp({
    database: database.db,
    auth: {
      sessionSecret: "order-proxy-fixture-secret",
      verifyCredentials: staticCredentialVerifier("order-fixture-password"),
    },
    library: createLibraryService([]),
    tmdb: {} as TmdbClient,
    integrationServices: {
      emby: createEmbyClient({ baseUrl: upstreamUrl, apiKey: managementToken }),
      email: {
        configured: false,
        sendNotification: async () => {},
        retryPending: async () => {},
        sendTest: async () => {},
      },
    },
  });
  const appServer = createServer(app);
  const proxy = createVirtualLibraryProxy({ database: database.db, appPort: 3000 });
  try {
    const appUrl = await listen(appServer);
    const reservation = createServer();
    const port = Number(new URL(await listen(reservation)).port);
    await close(reservation);
    await proxy.configure({ enabled: true, upstream: upstreamUrl, port }, false);
    const playerUrl = `http://127.0.0.1:${port}/emby`;
    const playbackHeaders = { "x-emby-token": playbackToken };
    const saved = await fetch(`${playerUrl}/Users/member/Configuration/Partial?reqformat=json`, {
      method: "POST",
      headers: { ...playbackHeaders, "content-type": "text/plain" },
      body: JSON.stringify({ OrderedViews: [owned, ...memberPreferences.OrderedViews] }),
    });
    expect(saved.status).toBe(204);

    const playerViews = async () => {
      const response = await fetch(`${playerUrl}/Users/member/Views`, { headers: playbackHeaders });
      expect(response.status).toBe(200);
      return (await response.json()).Items.map((view: { Id: string }) => view.Id);
    };
    expect(await playerViews()).toEqual([owned, films.Id, privateLibrary.Id, series.Id]);

    const adminPost = (path: string, payload: unknown, cookie = "") =>
      fetch(`${appUrl}${path}`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
    const login = await adminPost("/api/auth/login", { password: "order-fixture-password" });
    expect(login.status).toBe(200);
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const preview = await adminPost(`${endpoint}/preview`, { sourceUserId: admin.Id }, cookie);
    expect(preview.status).toBe(200);
    const { previewToken, users } = await preview.json();
    expect(users).toEqual([
      {
        id: member.Id,
        name: member.Name,
        status: "change",
        before: [films.Name, privateLibrary.Name, series.Name],
        after: [series.Name, films.Name, privateLibrary.Name],
      },
    ]);
    expect(managementWrites).toEqual([]);

    const applied = await adminPost(`${endpoint}/apply`, { previewToken }, cookie);
    expect(applied.status).toBe(200);
    expect(await applied.json()).toEqual({ users: [{ id: member.Id, name: member.Name, status: "updated" }] });
    expect(managementWrites).toEqual([
      {
        user: member.Id,
        body: { OrderedViews: [owned, series.Guid, hidden.Guid, films.Guid, privateLibrary.Guid] },
      },
    ]);
    expect(memberPreferences.MyMediaExcludes).toEqual([hidden.Guid]);
    expect(memberPreferences.AudioLanguagePreference).toBe("zho");
    expect(await playerViews()).toEqual([series.Id, owned, films.Id, privateLibrary.Id]);

    const denied = await fetch(`${playerUrl}/Users/member/Views`, { headers: { "x-emby-token": "wrong" } });
    expect(denied.status).toBe(401);
    const stream = await fetch(`${playerUrl}/Videos/fixture/stream.mp4`, {
      headers: { ...playbackHeaders, range: "bytes=0-3" },
    });
    expect(stream.status).toBe(206);
    expect(stream.headers.get("content-range")).toBe("bytes 0-3/8");
    expect(await stream.text()).toBe("clip");
  } finally {
    await proxy.close();
    await close(appServer);
    await close(upstream);
    database.close();
  }
});
