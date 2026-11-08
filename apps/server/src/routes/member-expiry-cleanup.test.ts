import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDatabase, type DatabaseHandle } from "@emby-task-center/database/client";
import { auditLogs, memberExpiryCleanupJobs, submissionUsers } from "@emby-task-center/database/schema";
import { createApp } from "../app";
import { staticCredentialVerifier } from "../auth/test-session";
import { createEmbyClient, type EmbyClient } from "../integrations/emby-client";
import { createLibraryService } from "../library/service";
import { writeSettings } from "../settings/store";
import { sweepMemberExpiryCleanup } from "../subscriptions/member-expiry-cleanup";
import { createPublicSessionManager } from "../subscriptions/public-session";
import type { TmdbClient } from "../tmdb/client";

const path = "/api/member-expiry-cleanup";
const day = 86_400_000;
const now = new Date("2028-05-01T12:00:00.000Z");
const expiryAt = (days: number, ms = 0) => new Date(now.getTime() - days * day + ms).toISOString();
const origin = (server: Server) => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
async function listen(server: Server) {
  await new Promise<void>((resolve) => server.once("listening", resolve));
}

type Account = { Id: string; Name: string; Policy: { IsAdministrator?: boolean } };
type MemberInput = Partial<typeof submissionUsers.$inferInsert>;
type Preview = {
  previewToken: string;
  candidates: { id: number; linked: boolean }[];
  blocked: { id: number; reason: string }[];
};

describe("member expiry cleanup using real app HTTP, SQLite, and Emby HTTP", () => {
  let database: DatabaseHandle;
  let appServer: Server;
  let embyServer: Server;
  let emby: EmbyClient;
  let cookie: string;
  let embyId: string;
  let users: Map<string, Account>;
  let deletes: string[];
  let onDelete: (id: string) => number;
  let onReadRole: (id: string) => void | Promise<void>;
  let onList: () => void | Promise<void>;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    database = createDatabase(":memory:");
    writeSettings(database.db, { "emby.enabled": true, "admin.username": "owner@example.test" });
    embyId = "cleanup-fixture-server";
    users = new Map();
    deletes = [];
    onReadRole = () => {};
    onList = () => {};
    onDelete = (id) => (users.delete(id), 204);
    embyServer = createServer(async (request, response) => {
      if (request.headers["x-emby-token"] !== "loopback-cleanup-key") return void response.writeHead(401).end();
      if (request.url === "/emby/System/Info") return void response.end(JSON.stringify({ Id: embyId }));
      if (request.url === "/emby/Users/Query") {
        await onList();
        return void response.end(JSON.stringify({ Items: [...users.values()], TotalRecordCount: users.size }));
      }
      const id = request.url?.match(/^\/emby\/Users\/([^/]+)$/)?.[1];
      if (!id) return void response.writeHead(404).end();
      if (request.method === "DELETE") {
        deletes.push(id);
        return void response.writeHead(onDelete(id)).end();
      }
      await onReadRole(id);
      const user = users.get(id);
      if (!user) return void response.writeHead(404).end();
      response.end(JSON.stringify(user));
    }).listen(0, "127.0.0.1");
    await listen(embyServer);
    emby = createEmbyClient({ baseUrl: origin(embyServer), apiKey: "loopback-cleanup-key" });
    appServer = createApp({
      database: database.db,
      auth: {
        sessionSecret: "cleanup-isolated-secret",
        verifyCredentials: staticCredentialVerifier("cleanup-password"),
      },
      library: createLibraryService([]),
      tmdb: {} as TmdbClient,
      integrationServices: {
        emby,
        email: {
          configured: false,
          sendNotification: async () => {},
          retryPending: async () => {},
          sendTest: async () => {},
        },
      },
    }).listen(0, "127.0.0.1");
    await listen(appServer);
    const login = await send("POST", "/api/auth/login", { password: "cleanup-password" }, "");
    expect(login.status).toBe(200);
    cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  });

  afterEach(async () => {
    await Promise.all(
      [appServer, embyServer].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
    database.close();
    vi.useRealTimers();
  });

  function send(method: string, endpoint: string, body?: unknown, auth = cookie) {
    return fetch(`${origin(appServer)}${endpoint}`, {
      method,
      headers: { cookie: auth, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
  }

  function member(email: string, patch: MemberInput = {}) {
    return database.db
      .insert(submissionUsers)
      .values({
        email,
        subscriptionExpiresAt: expiryAt(50),
        createdAt: expiryAt(100),
        updatedAt: expiryAt(100),
        ...patch,
      })
      .returning()
      .get();
  }

  function embyAccount(id: string, administrator?: boolean) {
    users.set(id, { Id: id, Name: id, Policy: { IsAdministrator: administrator } });
  }

  function local(id: number) {
    return database.db.select().from(submissionUsers).where(eq(submissionUsers.id, id)).get();
  }

  async function preview(days = 7): Promise<Preview> {
    const result = await send("POST", `${path}/preview`, { days });
    expect(result.status).toBe(200);
    return result.json();
  }

  async function enable(days = 7, expectedDays: number | null = null) {
    const approved = await preview(days);
    const result = await send("PUT", path, { days, expectedDays, previewToken: approved.previewToken });
    expect(result.status).toBe(200);
    return approved;
  }

  it("requires administrator auth and a confirmation preview, and starts disabled", async () => {
    const publicCookie = createPublicSessionManager("cleanup-isolated-secret")
      .issueCookie("member@example.test")
      .split(";")[0]!;
    for (const auth of ["", publicCookie]) {
      expect((await send("GET", path, undefined, auth)).status).toBe(401);
      expect((await send("POST", `${path}/preview`, { days: 7 }, auth)).status).toBe(401);
      expect((await send("PUT", path, { days: null, expectedDays: null }, auth)).status).toBe(401);
    }
    expect(await (await send("GET", path)).json()).toEqual({ days: null });
    expect((await send("POST", `${path}/preview`, { days: 0 })).status).toBe(400);
    expect((await send("POST", `${path}/preview`, { days: 3651 })).status).toBe(400);
    expect(await (await send("PUT", path, { days: 7, expectedDays: null })).json()).toEqual({
      error: "member_cleanup_preview_expired",
    });
    const expired = member("old@example.test");
    expect(await sweepMemberExpiryCleanup(database.db, emby)).toEqual({ deleted: 0, pending: 0, skipped: 0 });
    expect(local(expired.id)).toBeDefined();
    expect(deletes).toEqual([]);
  });

  it("includes historical and local-only members, protects admins, ambiguous links and drive entitlements", async () => {
    embyAccount("ordinary", false);
    embyAccount("administrator", true);
    embyAccount("unknown");
    embyAccount("shared", false);
    const old = member("old@example.test", { embyUserId: "ordinary" });
    const edge = member("edge@example.test", { subscriptionExpiresAt: expiryAt(7), enabled: false });
    const stale = member("missing@example.test", { embyUserId: "already-missing" });
    const protectedEmby = member("emby-admin@example.test", { embyUserId: "administrator" });
    const owner = member("owner@example.test");
    const unknown = member("unknown@example.test", { embyUserId: "unknown" });
    const shared = member("shared@example.test", { embyUserId: "shared" });
    const protectedRecords = [
      protectedEmby,
      owner,
      unknown,
      shared,
      member("shared-active@example.test", { embyUserId: "shared", subscriptionExpiresAt: expiryAt(-7) }),
      member("too-young@example.test", { subscriptionExpiresAt: expiryAt(7, 1) }),
      member("frozen@example.test", { deferredMembershipMs: day }),
      member("following@example.test", { followsDriveExpiry: true }),
      member("permanent@example.test", { subscriptionExpiresAt: null }),
      member("invalid-date@example.test", { subscriptionExpiresAt: "invalid" }),
    ];
    const result = await enable();
    expect(result.candidates.map(({ id, linked }) => [id, linked])).toEqual([
      [old.id, true],
      [edge.id, false],
      [stale.id, true],
    ]);
    expect(result.blocked.map(({ id, reason }) => [id, reason])).toEqual([
      [protectedEmby.id, "administrator"],
      [owner.id, "administrator"],
      [unknown.id, "role_unverified"],
      [shared.id, "linked_elsewhere"],
    ]);
    expect(deletes).toEqual([]);
    expect((await sweepMemberExpiryCleanup(database.db, emby)).deleted).toBe(3);
    expect(deletes).toEqual(["ordinary"]);
    for (const { id } of [old, edge, stale]) expect(local(id)).toBeUndefined();
    for (const { id } of protectedRecords) expect(local(id)).toBeDefined();
    const audits = database.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, "member.expiry_cleanup_deleted"))
      .all();
    expect(audits.map(({ targetId }) => targetId).sort()).toEqual([old.id, edge.id, stale.id].sort());
    expect((await sweepMemberExpiryCleanup(database.db, emby)).deleted).toBe(0);
  });

  it("requires re-preview if the candidate changes and does not delete on a different Emby server", async () => {
    embyAccount("candidate", false);
    const old = member("candidate@example.test", { embyUserId: "candidate" });
    const first = await preview();
    embyAccount("candidate", true);
    expect(
      await (await send("PUT", path, { days: 7, expectedDays: null, previewToken: first.previewToken })).json(),
    ).toEqual({ error: "member_cleanup_preview_changed" });
    embyAccount("candidate", false);
    await enable();
    onList = () => {
      embyId = "another-server";
    };
    expect((await sweepMemberExpiryCleanup(database.db, emby)).deleted).toBe(0);
    onList = () => {};
    expect((await sweepMemberExpiryCleanup(database.db, emby)).deleted).toBe(0);
    expect(local(old.id)).toBeDefined();
    expect(deletes).toEqual([]);
    await enable(7, 7);
    expect((await sweepMemberExpiryCleanup(database.db, emby)).deleted).toBe(1);
  });

  it("rechecks promotion and policy changes before issuing DELETE", async () => {
    embyAccount("promotion", false);
    embyAccount("disable-race", false);
    const promoted = member("promotion@example.test", { embyUserId: "promotion" });
    const second = member("disable-race@example.test", { embyUserId: "disable-race" });
    await enable();
    onReadRole = async (id) => {
      if (id === "promotion") embyAccount(id, true);
      else expect((await send("PUT", path, { days: null, expectedDays: 7 })).status).toBe(200);
    };
    expect((await sweepMemberExpiryCleanup(database.db, emby)).deleted).toBe(0);
    expect(local(promoted.id)).toBeDefined();
    expect(local(second.id)).toBeDefined();
    expect(deletes).toEqual([]);
    expect(database.db.select().from(memberExpiryCleanupJobs).all()).toEqual([]);
  });

  it("preserves an unverified member and resolves a lost response without repeating DELETE", async () => {
    embyAccount("lost-reply", false);
    const lost = member("lost@example.test", { embyUserId: "lost-reply" });
    await enable();
    onDelete = (id) => (users.delete(id), 503);
    expect((await sweepMemberExpiryCleanup(database.db, emby)).pending).toBe(1);
    expect(local(lost.id)).toBeDefined();
    expect(database.db.select().from(memberExpiryCleanupJobs).all()).toHaveLength(1);
    expect((await sweepMemberExpiryCleanup(database.db, emby)).deleted).toBe(0);
    expect((await send("PUT", path, { days: null, expectedDays: 7 })).status).toBe(200);
    vi.setSystemTime(now.getTime() + 5 * 60_000);
    expect((await sweepMemberExpiryCleanup(database.db, emby)).deleted).toBe(1);
    expect(local(lost.id)).toBeUndefined();
    expect(deletes).toEqual(["lost-reply"]);
  });

  it("leaves the membership on upstream error and retries only after the persisted lease", async () => {
    embyAccount("retry", false);
    const retry = member("retry@example.test", { embyUserId: "retry" });
    await enable();
    onDelete = () => 503;
    await sweepMemberExpiryCleanup(database.db, emby);
    expect(local(retry.id)).toBeDefined();
    expect(deletes).toEqual(["retry"]);
    vi.setSystemTime(now.getTime() + 5 * 60_000);
    onDelete = (id) => (users.delete(id), 204);
    expect((await sweepMemberExpiryCleanup(database.db, emby)).deleted).toBe(1);
    expect(deletes).toEqual(["retry", "retry"]);
    expect(local(retry.id)).toBeUndefined();
  });

  it("rechecks the expiry if renewal commits while the account list is loading", async () => {
    embyAccount("renewed", false);
    const renewed = member("renewed@example.test", { embyUserId: "renewed" });
    await enable();
    onList = () => {
      database.db
        .update(submissionUsers)
        .set({ subscriptionExpiresAt: expiryAt(-5) })
        .where(eq(submissionUsers.id, renewed.id))
        .run();
    };
    expect((await sweepMemberExpiryCleanup(database.db, emby)).deleted).toBe(0);
    expect(deletes).toEqual([]);
    expect(local(renewed.id)?.subscriptionExpiresAt).toBe(expiryAt(-5));
  });
});
