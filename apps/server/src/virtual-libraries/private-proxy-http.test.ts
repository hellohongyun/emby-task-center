import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDatabase, type DatabaseHandle } from "@emby-task-center/database/client";
import { submissionUsers, concurrencyEscalationState } from "@emby-task-center/database/schema";
import { writeSettings } from "../settings/store";
import { createVirtualLibraryStore } from "./store";
import { createVirtualLibraryProxy, type VirtualLibraryProxy } from "./proxy";

const aliceId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const bobId = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l7sAAAAASUVORK5CYII=",
  "base64",
);
const servers: Server[] = [];
async function listen(server: Server) {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

describe("private libraries through the actual HTTP proxy", () => {
  let database: DatabaseHandle;
  let proxy: VirtualLibraryProxy;
  let base: string;
  let privateId: string;
  let publicId: string;
  let posterTag: string;
  let memberId: number;
  let observed: string[];
  const get = (path: string, token = "alice-token", method = "GET") =>
    fetch(base + path, {
      method,
      headers: token ? { "x-emby-token": token } : {},
    });
  const list = async (token: string) => {
    const response = await get(`/Users/${token === "bob-token" ? bobId : aliceId}/Views`, token);
    const body = (await response.json()) as { Items: { Id: string }[] };
    return body.Items.map((item) => item.Id);
  };
  beforeEach(async () => {
    database = createDatabase(":memory:");
    observed = [];
    const now = new Date().toISOString();
    memberId = database.db
      .insert(submissionUsers)
      .values({
        email: "alice@example.com",
        embyUserId: aliceId,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get().id;
    database.db
      .insert(submissionUsers)
      .values({
        email: "bob@example.com",
        embyUserId: bobId,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    const privateStore = createVirtualLibraryStore(database.db, { ownerMemberId: memberId });
    privateId = privateStore.create({ name: "私人", sortOrder: -1 }).id;
    privateStore.setPoster(privateId, png, "image/png");
    posterTag = privateStore.getPoster(privateId)!.imageTag;
    publicId = createVirtualLibraryStore(database.db).create({ name: "公共" }).id;
    const upstreamPort = await listen(
      createServer((request, response) => {
        const url = new URL(request.url!, "http://upstream.test");
        observed.push(url.pathname);
        const token = request.headers["x-emby-token"];
        const id = token === "alice-token" ? aliceId : token === "bob-token" ? bobId : undefined;
        if (url.pathname.startsWith("/Videos/")) {
          response.end("original-stream");
          return;
        }
        if (!id) {
          response.writeHead(401).end();
          return;
        }
        const body =
          url.pathname === "/Users/Me"
            ? { Id: id }
            : /^\/Users\/[^/]+$/.test(url.pathname)
              ? { Configuration: {} }
              : url.pathname.endsWith("/Views")
                ? { Items: [{ Id: "native", Type: "CollectionFolder" }], TotalRecordCount: 1 }
                : { Items: [], TotalRecordCount: 0 };
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
      }),
    );
    const upstream = `http://127.0.0.1:${upstreamPort}`;
    writeSettings(database.db, { "emby.baseUrl": upstream, "emby.apiKey": "admin-must-never-be-used" });
    const vacant = createServer();
    const proxyPort = await listen(vacant);
    await new Promise<void>((resolve) => vacant.close(() => resolve()));
    servers.splice(servers.indexOf(vacant), 1);
    proxy = createVirtualLibraryProxy({ database: database.db, appPort: 3000 });
    await proxy.configure({ enabled: true, upstream, port: proxyPort });
    base = `http://127.0.0.1:${proxyPort}`;
  });
  afterEach(async () => {
    await proxy?.close();
    for (const server of servers.splice(0)) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    database?.close();
  });
  it("shows the owner private-first and excludes their library from other accounts", async () => {
    expect(await list("alice-token")).toEqual([privateId, "native", publicId]);
    expect(await list("bob-token")).toEqual(["native", publicId]);
    expect((await get(`/Items/${privateId}`)).status).toBe(200);
    expect((await get(`/Items?ParentId=${privateId}`)).status).toBe(200);
    expect((await get(`/Users/${aliceId}/Views`, "")).status).toBe(401);
  });
  it("rejects guessed IDs, mixed queries, latest sections and tagged posters for other or anonymous accounts", async () => {
    for (const token of ["bob-token", ""]) {
      for (const path of [
        `/Items/${privateId}`,
        `/Items?ParentId=${privateId}`,
        `/Items?Ids=native,${privateId}`,
        `/Users/${bobId}/Sections/task-center-latest%3A${privateId}/Items`,
        `/Items/${privateId}/Images/Primary?tag=${posterTag}`,
      ]) {
        expect((await get(path, token)).status, `${token}: ${path}`).toBe(404);
      }
      expect((await get(`/Items/${privateId}/Images/Primary?tag=${posterTag}`, token, "HEAD")).status).toBe(404);
    }
    const image = await get(`/Items/${privateId}/Images/Primary?tag=${posterTag}`);
    expect(image.status).toBe(200);
    expect(Buffer.from(await image.arrayBuffer())).toEqual(png);
    expect(observed.some((path) => path.includes(privateId))).toBe(false);
  });
  it("rejects request UserId impersonation even when upstream accepts it", async () => {
    expect((await get(`/Users/${aliceId}/Items/${privateId}`, "bob-token")).status).toBe(404);
    expect((await get(`/Items/${privateId}?UserId=${aliceId}`, "bob-token")).status).toBe(404);
    const response = await get(`/Users/${aliceId}/Views`, "bob-token");
    expect(((await response.json()) as { Items: { Id: string }[] }).Items.map((item) => item.Id)).not.toContain(
      privateId,
    );
  });
  it.each(["disabled", "expired", "frozen", "rebound", "duplicate", "deleted"] as const)(
    "rechecks %s state on the next request",
    async (state) => {
      expect((await get(`/Items/${privateId}`)).status).toBe(200);
      if (state === "disabled")
        database.db.update(submissionUsers).set({ enabled: false }).where(eq(submissionUsers.id, memberId)).run();
      if (state === "expired")
        database.db
          .update(submissionUsers)
          .set({ subscriptionExpiresAt: "2020-01-01T00:00:00Z" })
          .where(eq(submissionUsers.id, memberId))
          .run();
      if (state === "frozen")
        database.db
          .insert(concurrencyEscalationState)
          .values({ memberId, disabledUntil: "2030-01-01T00:00:00Z", updatedAt: new Date().toISOString() })
          .run();
      if (state === "rebound")
        database.db
          .update(submissionUsers)
          .set({ embyUserId: "new-account" })
          .where(eq(submissionUsers.id, memberId))
          .run();
      if (state === "duplicate")
        database.db
          .update(submissionUsers)
          .set({ embyUserId: "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA" })
          .where(eq(submissionUsers.embyUserId, bobId))
          .run();
      if (state === "deleted") database.db.delete(submissionUsers).where(eq(submissionUsers.id, memberId)).run();
      expect((await get(`/Items/${privateId}`)).status).toBe(404);
      expect((await get(`/Items/${privateId}/Images/Primary?tag=${posterTag}`)).status).toBe(404);
      expect(await list("alice-token")).not.toContain(privateId);
    },
  );
  it("keeps ordinary stream requests free of identity lookups", async () => {
    observed.length = 0;
    const response = await get("/Videos/movie/stream?static=true");
    expect(await response.text()).toBe("original-stream");
    expect(observed).toEqual(["/Videos/movie/stream"]);
  });
});
