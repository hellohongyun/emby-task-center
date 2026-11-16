import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createDatabase } from "@emby-task-center/database/client";
import { expect, it } from "vitest";
import { createApp } from "../app";
import { staticCredentialVerifier } from "../auth/test-session";
import { createEmbyClient } from "../integrations/emby-client";
import { createLibraryService } from "../library/service";
import { writeSettings } from "../settings/store";
import type { TmdbClient } from "../tmdb/client";
import { createVirtualLibraryProxy } from "./proxy";
import { createVirtualLibraryStore } from "./store";
import { seedMarketViewer } from "./market-test-support";

const endpoint = "/api/virtual-library-market/order";
const films = { Id: "101", Guid: "a".repeat(32), Name: "电影", Type: "CollectionFolder" };
const series = { Id: "102", Guid: "b".repeat(32), Name: "电视剧", Type: "CollectionFolder" };
const privateLibrary = { Id: "103", Guid: "c".repeat(32), Name: "专享库", Type: "CollectionFolder" };
const hidden = { Id: "104", Guid: "d".repeat(32), Name: "已隐藏", Type: "CollectionFolder" };
const injected = {
  Id: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee",
  Guid: "e".repeat(32),
  Name: "TgtoDrive 榜单",
  Type: "CollectionFolder",
  UpstreamData: { source: "TgtoDrive" },
};
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

it("preserves personal mixed-library order while defaults change without writing upstream user settings", async () => {
  const database = createDatabase(":memory:");
  const owned = createVirtualLibraryStore(database.db).create({ name: "本地虚拟库" }).id;
  const memberPreferences = {
    OrderedViews: [films.Guid, hidden.Guid, privateLibrary.Guid, series.Guid],
    MyMediaExcludes: [hidden.Guid],
    AudioLanguagePreference: "zho",
  };
  const managementWrites: { user: string; body: object; throughTgtoDrive: boolean }[] = [];
  const handle =
    (throughTgtoDrive: boolean): RequestListener =>
    async (request, response) => {
      const url = new URL(request.url!, "http://fixture");
      const path = url.pathname.replace(/^\/emby/, "");
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
        const Items = [films, series, privateLibrary, hidden, ...(throughTgtoDrive ? [injected] : [])];
        return void json({ Items });
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
        if (token === managementToken) managementWrites.push({ user: id, body, throughTgtoDrive });
        if (Array.isArray(body.OrderedViews)) {
          body.OrderedViews = body.OrderedViews.filter((key: string) => key !== injected.Guid && key !== injected.Id);
        }
        Object.assign(memberPreferences, body);
        response.writeHead(204).end();
        return;
      }
      const configuration = id === member.Id ? memberPreferences : { OrderedViews: [series.Guid, films.Guid] };
      if (path.endsWith("/Views")) {
        const available = id === member.Id ? [films, series, privateLibrary, hidden] : [films, series];
        const visible =
          url.searchParams.get("IncludeHidden") === "true" ? available : available.filter((view) => view !== hidden);
        const externalViews = throughTgtoDrive && url.searchParams.get("IncludeExternalContent") !== "false";
        const Items = [
          ...(externalViews ? [injected] : []),
          ...configuration.OrderedViews.flatMap((key) => visible.filter(({ Guid }) => Guid === key)),
        ];
        return void json({ Items, TotalRecordCount: Items.length });
      }
      json({ ...(id === member.Id ? member : admin), Configuration: configuration });
    };
  const upstream = createServer(handle(false));
  const tgtoDrive = createServer(handle(true));
  const upstreamUrl = await listen(upstream);
  const tgtoDriveUrl = await listen(tgtoDrive);
  writeSettings(database.db, { "emby.baseUrl": upstreamUrl, "emby.apiKey": managementToken });
  seedMarketViewer(database.db, tgtoDriveUrl, member.Id, playbackToken, [owned]);
  let proxy = createVirtualLibraryProxy({ database: database.db, appPort: 3000 });
  const app = createApp({
    database: database.db,
    virtualLibraryProxy: proxy,
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
  try {
    const appUrl = await listen(appServer);
    const reservation = createServer();
    const port = Number(new URL(await listen(reservation)).port);
    await close(reservation);
    await proxy.configure({ enabled: true, upstream: tgtoDriveUrl, port });
    const playerUrl = `http://127.0.0.1:${port}/emby`;
    const playbackHeaders = { "x-emby-token": playbackToken, connection: "close" };
    const saved = await fetch(`${playerUrl}/Users/member/Configuration/Partial?reqformat=json`, {
      method: "POST",
      headers: { ...playbackHeaders, "content-type": "text/plain" },
      body: JSON.stringify({ OrderedViews: [injected.Guid, owned, ...memberPreferences.OrderedViews] }),
    });
    expect(saved.status).toBe(204);

    const playerViews = async (homeSettings = false) => {
      const query = homeSettings ? "?IncludeHidden=true&AllowDynamicChildren=false" : "";
      const response = await fetch(`${playerUrl}/Users/member/Views${query}`, { headers: playbackHeaders });
      expect(response.status).toBe(200);
      const { Items } = await response.json();
      expect(Items.find((view: { Id: string }) => view.Id === injected.Id)).toEqual(injected);
      return Items.map((view: { Id: string }) => view.Id);
    };
    const nativeViews = async () => {
      const response = await fetch(`${upstreamUrl}/emby/Users/member/Views`, { headers: playbackHeaders });
      return (await response.json()).Items.map((view: { Id: string }) => view.Id);
    };
    const before = [injected.Id, owned, films.Id, privateLibrary.Id, series.Id];
    expect(await playerViews()).toEqual(before);
    expect(await playerViews(true)).toEqual([injected.Id, owned, films.Id, hidden.Id, privateLibrary.Id, series.Id]);

    const adminRequest = (path: string, method: string, payload: unknown, cookie = "") =>
      fetch(`${appUrl}${path}`, {
        method,
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
    const login = await adminRequest("/api/auth/login", "POST", { password: "order-fixture-password" });
    expect(login.status).toBe(200);
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const anonymous = await adminRequest(endpoint, "GET", undefined);
    expect(anonymous.status).toBe(401);
    const defaults = await adminRequest(
      "/api/virtual-library-market/defaults",
      "PUT",
      { libraryIds: [owned], adminEmbyUserId: member.Id },
      cookie,
    );
    expect(defaults.status).toBe(200);
    const catalog = await adminRequest(endpoint, "GET", undefined, cookie);
    expect(await catalog.json()).toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({ id: owned }),
        expect.objectContaining({ id: injected.Id }),
      ]),
    });
    const originalPreferences = structuredClone(memberPreferences);
    const firstTemplate = [series.Id, films.Id, owned, injected.Id, privateLibrary.Id];
    expect((await adminRequest(endpoint, "PUT", { order: firstTemplate }, cookie)).status).toBe(200);
    // Existing identifiable personal settings remain authoritative after a default change.
    expect(await playerViews()).toEqual(before);
    expect(memberPreferences).toEqual(originalPreferences);
    expect(managementWrites).toEqual([]);
    const ownOrder = [privateLibrary.Id, injected.Id, films.Id, series.Id, owned];
    const personal = await adminRequest("/api/virtual-library-order", "PUT", { order: ownOrder }, cookie);
    expect(personal.status).toBe(200);
    expect((await personal.json()).order).toEqual(ownOrder);
    expect(await playerViews()).toEqual(ownOrder);
    expect((await adminRequest(endpoint, "PUT", { order: [...firstTemplate].reverse() }, cookie)).status).toBe(200);
    expect(await playerViews()).toEqual(ownOrder);
    await proxy.close();
    proxy = createVirtualLibraryProxy({ database: database.db, appPort: 3000 });
    await proxy.start();
    expect(await playerViews()).toEqual(ownOrder);
    expect(await nativeViews()).toEqual([films.Id, privateLibrary.Id, series.Id]);
    expect(managementWrites).toEqual([]);
    const retired = await adminRequest("/api/emby/library-order/apply", "POST", { previewToken: "old-token" }, cookie);
    expect(retired.status).toBe(404);

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
    await close(tgtoDrive);
    await close(upstream);
    database.close();
  }
});
