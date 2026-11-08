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

it("applies one management template to native views and the player proxy", async () => {
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
    if (path === "/Library/VirtualFolders" && token === managementToken) {
      return void json(
        [films, series, privateLibrary, hidden].map(({ Id, Name }) => ({
          ItemId: Id,
          Name,
          CollectionType: "movies",
        })),
      );
    }
    if (path === "/Library/MediaFolders" && token === managementToken) {
      return void json({
        Items: [films, series, privateLibrary, hidden].map(({ Id, Name, Guid }) => ({ Id, Name, Guid })),
      });
    }
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
    const nativeViews = async () => {
      const response = await fetch(`${upstreamUrl}/emby/Users/member/Views`, { headers: playbackHeaders });
      return (await response.json()).Items.map((view: { Id: string }) => view.Id);
    };
    expect(await playerViews()).toEqual([owned, films.Id, privateLibrary.Id, series.Id]);

    const adminRequest = (path: string, method: string, payload: unknown, cookie = "") =>
      fetch(`${appUrl}${path}`, {
        method,
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
    const login = await adminRequest("/api/auth/login", "POST", { password: "order-fixture-password" });
    expect(login.status).toBe(200);
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const catalog = await adminRequest(endpoint, "GET", undefined, cookie);
    expect(await catalog.json()).toMatchObject({
      active: false,
      libraries: expect.arrayContaining([expect.objectContaining({ id: owned, kind: "owned" })]),
    });
    const savedOrder = await adminRequest(
      endpoint,
      "PUT",
      { order: [series.Guid, films.Guid, owned, privateLibrary.Guid] },
      cookie,
    );
    expect(savedOrder.status).toBe(200);
    const single = await adminRequest(`${endpoint}/preview`, "POST", { userIds: [admin.Id] }, cookie);
    const singlePreview = await single.json();
    expect(singlePreview.proxyChanged).toBe(false);
    const singleApply = await adminRequest(
      `${endpoint}/apply`,
      "POST",
      { previewToken: singlePreview.previewToken },
      cookie,
    );
    expect(await singleApply.json()).toMatchObject({ proxyActivated: false });
    expect(await playerViews()).toEqual([owned, films.Id, privateLibrary.Id, series.Id]);

    const preview = await adminRequest(`${endpoint}/preview`, "POST", {}, cookie);
    expect(preview.status).toBe(200);
    const { previewToken, users, proxyChanged } = await preview.json();
    expect(proxyChanged).toBe(true);
    expect(users).toEqual([
      {
        id: admin.Id,
        name: admin.Name,
        isAdministrator: true,
        isDisabled: false,
        status: "unchanged",
        before: [series.Name, films.Name],
        after: [series.Name, films.Name],
        proxyBefore: [series.Name, films.Name, "本地虚拟库"],
        proxyAfter: [series.Name, films.Name, "本地虚拟库"],
      },
      {
        id: member.Id,
        name: member.Name,
        isAdministrator: false,
        isDisabled: false,
        status: "change",
        before: [films.Name, privateLibrary.Name, series.Name],
        after: [series.Name, films.Name, privateLibrary.Name],
        proxyBefore: ["本地虚拟库", films.Name, privateLibrary.Name, series.Name],
        proxyAfter: [series.Name, films.Name, "本地虚拟库", privateLibrary.Name],
      },
    ]);
    expect(managementWrites).toEqual([]);
    expect(await nativeViews()).toEqual([films.Id, privateLibrary.Id, series.Id]);
    expect(await playerViews()).toEqual([owned, films.Id, privateLibrary.Id, series.Id]);

    const applied = await adminRequest(`${endpoint}/apply`, "POST", { previewToken }, cookie);
    expect(applied.status).toBe(200);
    const appliedBody = await applied.json();
    expect(appliedBody.proxyActivated).toBe(true);
    expect(appliedBody.users).toEqual([
      { id: admin.Id, name: admin.Name, isAdministrator: true, isDisabled: false, status: "unchanged" },
      { id: member.Id, name: member.Name, isAdministrator: false, isDisabled: false, status: "updated" },
    ]);
    expect(appliedBody.order).toEqual([series.Guid, films.Guid, owned, privateLibrary.Guid, hidden.Guid]);
    expect(managementWrites).toEqual([
      {
        user: member.Id,
        body: { OrderedViews: [series.Guid, hidden.Guid, films.Guid, privateLibrary.Guid] },
      },
    ]);
    expect(memberPreferences.MyMediaExcludes).toEqual([hidden.Guid]);
    expect(memberPreferences.AudioLanguagePreference).toBe("zho");
    expect(await nativeViews()).toEqual([series.Id, films.Id, privateLibrary.Id]);
    expect(await playerViews()).toEqual([series.Id, films.Id, owned, privateLibrary.Id]);

    const personal = await fetch(`${playerUrl}/Users/member/Configuration/Partial?reqformat=json`, {
      method: "POST",
      headers: { ...playbackHeaders, "content-type": "text/plain" },
      body: JSON.stringify({ OrderedViews: [owned, films.Guid, series.Guid, privateLibrary.Guid] }),
    });
    expect(personal.status).toBe(204);
    expect(await playerViews()).toEqual([series.Id, films.Id, owned, privateLibrary.Id]);

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
