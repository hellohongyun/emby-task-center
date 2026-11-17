import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabase, type DatabaseHandle } from "@emby-task-center/database/client";
import { submissionUsers, upstreamVirtualLibraries } from "@emby-task-center/database/schema";
import { createVirtualLibraryStore } from "./store";
import { adminMarketSubscriber, createVirtualLibraryMarketService } from "./market-service";
import { createVirtualLibraryProxy, type VirtualLibraryProxy } from "./proxy";
import { writeSettings } from "../settings/store";
import type { PrivateDiagnostic } from "./private-diagnostics";

describe("bound administrator discovery without a portal member", () => {
  const servers: Server[] = [];
  let database: DatabaseHandle;
  let proxy: VirtualLibraryProxy;
  let base: string;
  let ownId: string;
  let otherId: string;
  let diagnostics: PrivateDiagnostic[];
  const native = { Id: "native", Name: "Native", Type: "CollectionFolder" };
  const external = { Id: "source-library", Name: "External", Type: "CollectionFolder" };

  async function listen(server: Server) {
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }
  function get(path: string, token: string) {
    return fetch(base + path, { headers: { "x-emby-token": token } });
  }
  async function ids(path: string, token = "admin-token") {
    const response = await get(path, token);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { Items: { Id: string }[] };
    return body.Items.map((item) => item.Id);
  }
  async function login(token: string) {
    const response = await fetch(base + "/Users/AuthenticateByName", {
      method: "POST",
      headers: { "x-emby-token": token },
    });
    expect(response.status).toBe(200);
    await response.arrayBuffer();
  }
  beforeEach(async () => {
    database = createDatabase(":memory:");
    diagnostics = [];
    const now = new Date().toISOString();
    const member = database.db
      .insert(submissionUsers)
      .values({ email: "member@test.example", embyUserId: "member", createdAt: now, updatedAt: now })
      .returning()
      .get();
    ownId = createVirtualLibraryStore(database.db).create({ name: "Admin private" }).id;
    otherId = createVirtualLibraryStore(database.db, { ownerMemberId: member.id }).create({
      name: "Member private",
    }).id;
    const upstream = await listen(
      createServer((request, response) => {
        const url = new URL(request.url!, "http://fixture");
        const token = request.headers["x-emby-token"];
        const user = token === "admin-token" || token === "admin-old-token" ? "admin" : "member";
        response.setHeader("content-type", "application/json");
        if (request.method === "POST" && url.pathname === "/Users/AuthenticateByName") {
          request.resume();
          response.end(JSON.stringify({ AccessToken: token, User: { Id: user } }));
          return;
        }
        if (!["admin-token", "admin-old-token", "member-token"].includes(String(token))) {
          response.writeHead(401).end();
          return;
        }
        if (/^\/Users\/[^/]+$/.test(url.pathname)) {
          // An upstream administrator may read another user's profile: that never proves token ownership.
          const requested = url.pathname.split("/").at(-1);
          if (user !== "admin" && requested !== user) return void response.writeHead(403).end();
          response.end(
            JSON.stringify({ Id: requested, Policy: { IsAdministrator: user === "admin" }, Configuration: {} }),
          );
          return;
        }
        const items = url.pathname.endsWith("/Views") ? [native, external] : [native];
        response.end(JSON.stringify({ Items: items, TotalRecordCount: items.length }));
      }),
    );
    writeSettings(database.db, { "emby.baseUrl": upstream, "emby.apiKey": "never-use-service-key-for-player" });
    database.db
      .insert(upstreamVirtualLibraries)
      .values({
        id: "market-external",
        upstream,
        sourceId: external.Id,
        name: external.Name,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    const market = createVirtualLibraryMarketService(database.db);
    market.patchDefaults({ adminEmbyUserId: "admin" });
    market.subscribe(adminMarketSubscriber, "market-external", true);
    const reserve = createServer();
    base = await listen(reserve);
    await new Promise<void>((resolve) => reserve.close(() => resolve()));
    servers.splice(servers.indexOf(reserve), 1);
    proxy = createVirtualLibraryProxy({
      database: database.db,
      appPort: 3000,
      reportIdentity: (entry) => diagnostics.push(entry),
    });
    await proxy.configure({ enabled: true, upstream, port: Number(new URL(base).port) });
  });
  afterEach(async () => {
    await proxy?.close();
    for (const server of servers.splice(0)) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    database?.close();
  });

  it("discovers administrator-owned and enabled external libraries through Views, folders and root Items", async () => {
    await login("admin-token");
    for (const path of [
      "/Users/admin/Views",
      "/Library/MediaFolders?UserId=admin",
      "/Items?UserId=admin&IncludeItemTypes=CollectionFolder&Recursive=false",
    ]) {
      expect(await ids(path)).toEqual([ownId, native.Id, external.Id]);
    }
    expect(diagnostics).toContainEqual(
      expect.objectContaining({ reason: "private_scope_ready", privateLibraryCount: 1 }),
    );
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        reason: "discovery_result",
        accountType: "administrator",
        localLibraryCount: 1,
        externalLibraryCount: 1,
        visibleLocalLibraryCount: 1,
        enabledExternalLibraryCount: 1,
        itemCount: 3,
        totalRecordCount: 3,
      }),
    );
    expect((await get(`/Items/${otherId}`, "admin-token")).status).toBe(404);
  });

  it("keeps an old unproven administrator token out of market scopes until that token logs in through the proxy", async () => {
    await login("admin-token");
    expect(await ids("/Users/admin/Views", "admin-old-token")).toEqual([native.Id]);
    expect(diagnostics).toContainEqual(expect.objectContaining({ reason: "login_proof_missing" }));
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        reason: "discovery_result",
        accountType: "unresolved",
        localLibraryCount: 0,
        externalLibraryCount: 0,
        visibleLocalLibraryCount: 0,
        enabledExternalLibraryCount: 0,
        itemCount: 1,
      }),
    );
    await login("admin-old-token");
    expect(await ids("/Users/admin/Views", "admin-old-token")).toEqual([ownId, native.Id, external.Id]);
  });

  it("isolates ordinary members and rejects administrator requests claiming another user's identity", async () => {
    await login("admin-token");
    await login("member-token");
    expect(await ids("/Users/member/Views", "member-token")).toEqual([otherId, native.Id]);
    expect((await get(`/Items/${ownId}`, "member-token")).status).toBe(404);
    expect(await ids("/Users/member/Views", "admin-token")).toEqual([native.Id]);
    expect(diagnostics).toContainEqual(expect.objectContaining({ reason: "user_claim_mismatch" }));
  });
});
