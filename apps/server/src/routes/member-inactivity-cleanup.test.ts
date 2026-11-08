import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDatabase, type DatabaseHandle } from "@emby-task-center/database/client";
import { memberExpiryCleanupJobs, memberUsageEvents, submissionUsers } from "@emby-task-center/database/schema";
import { createApp } from "../app";
import { staticCredentialVerifier } from "../auth/test-session";
import { createEmbyClient, type EmbyClient } from "../integrations/emby-client";
import { createLibraryService } from "../library/service";
import { writeSettings } from "../settings/store";
import { sweepMemberInactivityCleanup } from "../subscriptions/member-inactivity-cleanup";
import { createPublicSessionManager } from "../subscriptions/public-session";
import type { TmdbClient } from "../tmdb/client";

const path = "/api/member-inactivity-cleanup";
const days = 15;
const now = new Date("2028-05-01T12:00:00.000Z");
const daysAgo = (days: number, offsetMs = 0) => new Date(now.getTime() - days * 86_400_000 + offsetMs).toISOString();
const origin = (server: Server) => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const listening = (server: Server) => new Promise<void>((resolve) => server.once("listening", resolve));

type Account = { Id: string; Name: string; Policy: { IsAdministrator?: boolean }; LastActivityDate: string };
type MemberInput = Partial<typeof submissionUsers.$inferInsert>;
type PreviewRow = { id: number; email: string; lastPlayedAt: string | null; createdAt: string };
type Preview = { previewToken: string; candidates: PreviewRow[]; blocked: (PreviewRow & { reason: string })[] };

describe("member inactivity cleanup using real app HTTP, SQLite, and Emby HTTP", () => {
  let database: DatabaseHandle;
  let appServer: Server;
  let embyServer: Server;
  let emby: EmbyClient;
  let cookie: string;
  let users: Map<string, Account>;
  let playback: Map<string, string | null>;
  let playing: Set<string>;
  let deletes: string[];
  let onReadRole: (id: string) => void;
  let onDelete: (id: string) => number;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    database = createDatabase(":memory:");
    writeSettings(database.db, { "emby.enabled": true, "admin.username": "owner@example.test" });
    users = new Map();
    playback = new Map();
    playing = new Set();
    deletes = [];
    onReadRole = () => {};
    onDelete = (id) => (users.delete(id), 204);
    embyServer = createServer((request, response) => {
      if (request.headers["x-emby-token"] !== "fixture-key") return void response.writeHead(401).end();
      const { pathname } = new URL(request.url!, "http://127.0.0.1");
      const json = (body: unknown) => response.setHeader("content-type", "application/json").end(JSON.stringify(body));
      if (pathname === "/emby/System/Info") return void json({ Id: "inactivity-fixture-server" });
      if (pathname === "/emby/Users/Query")
        return void json({ Items: [...users.values()], TotalRecordCount: users.size });
      if (pathname === "/emby/Sessions") {
        return void json(
          [...playing].map((UserId) => ({
            Id: `session-${UserId}`,
            UserId,
            NowPlayingItem: { Id: "video", Type: "Movie" },
            PlayState: { IsPaused: false },
          })),
        );
      }
      const [match, id, items] = pathname.match(/^\/emby\/Users\/([^/]+)(\/Items)?$/) ?? [];
      if (!match || !id || !users.has(id)) return void response.writeHead(404).end();
      if (items) {
        if (!playback.has(id)) return void response.writeHead(503).end();
        const date = playback.get(id);
        return void json({
          Items: [
            {
              Id: "video",
              UserData: {
                LastPlayedDate: date,
                Played: Boolean(date),
                PlayCount: date ? 1 : 0,
                PlaybackPositionTicks: 0,
              },
            },
          ],
          TotalRecordCount: 1,
        });
      }
      if (request.method === "DELETE") {
        deletes.push(id);
        return void response.writeHead(onDelete(id)).end();
      }
      onReadRole(id);
      return void json(users.get(id));
    }).listen(0, "127.0.0.1");
    await listening(embyServer);
    emby = createEmbyClient({ baseUrl: origin(embyServer), apiKey: "fixture-key" });
    const app = createApp({
      database: database.db,
      auth: { sessionSecret: "inactivity-only-secret", verifyCredentials: staticCredentialVerifier("test-password") },
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
    });
    appServer = app.listen(0, "127.0.0.1");
    await listening(appServer);
    const login = await request("POST", "/api/auth/login", { password: "test-password" }, "");
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

  function request(method: string, endpoint = path, body?: unknown, auth = cookie) {
    return fetch(`${origin(appServer)}${endpoint}`, {
      method,
      headers: { cookie: auth, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
  }

  function account(id: string, lastPlayed: string | null = null, admin = false) {
    users.set(id, { Id: id, Name: id, Policy: { IsAdministrator: admin }, LastActivityDate: daysAgo(0) });
    playback.set(id, lastPlayed);
  }

  function member(email: string, patch: MemberInput = {}) {
    return database.db
      .insert(submissionUsers)
      .values({ email, createdAt: daysAgo(40), updatedAt: daysAgo(40), subscriptionExpiresAt: daysAgo(-30), ...patch })
      .returning()
      .get();
  }

  function local(id: number) {
    return database.db.select().from(submissionUsers).where(eq(submissionUsers.id, id)).get();
  }

  async function preview(): Promise<Preview> {
    const response = await request("POST", `${path}/preview`, { days });
    expect(response.status).toBe(200);
    return response.json();
  }

  async function enable() {
    const plan = await preview();
    expect((await request("PUT", path, { days, expectedDays: null, previewToken: plan.previewToken })).status).toBe(
      200,
    );
    return plan;
  }

  it("starts disabled and requires an administrator and a current preview to enable", async () => {
    const publicCookie = createPublicSessionManager("inactivity-only-secret").issueCookie("user@example.test");
    for (const auth of ["", publicCookie.split(";")[0]!]) {
      expect((await request("GET", path, undefined, auth)).status).toBe(401);
      expect((await request("POST", `${path}/preview`, { days }, auth)).status).toBe(401);
      expect((await request("PUT", path, { days: null, expectedDays: null }, auth)).status).toBe(401);
    }
    expect(await (await request("GET")).json()).toEqual({ days: null });
    expect((await request("POST", `${path}/preview`, { days: 0 })).status).toBe(400);
    expect((await request("PUT", path, { days, expectedDays: null })).status).toBe(409);
    account("inactive");
    const inactive = member("inactive@example.test", { embyUserId: "inactive" });
    expect((await sweepMemberInactivityCleanup(database.db, emby)).deleted).toBe(0);
    expect(local(inactive.id)).toBeDefined();
    expect(deletes).toEqual([]);
  });

  it("removes linked members at 15 full days including valid memberships, with creation as the no-play fallback", async () => {
    account("old-play", daysAgo(15));
    account("never-played");
    account("recent-play", daysAgo(15, 1));
    account("new-member");
    account("unlinked");
    const old = member("old-play@example.test", { embyUserId: "old-play" });
    const never = member("never-played@example.test", { embyUserId: "never-played", createdAt: daysAgo(15) });
    const recent = member("recent-play@example.test", { embyUserId: "recent-play" });
    const fresh = member("new-member@example.test", { embyUserId: "new-member", createdAt: daysAgo(15, 1) });
    const localOnly = member("local-only@example.test");

    const result = await enable();
    expect(result.candidates.map(({ id, lastPlayedAt }) => [id, lastPlayedAt])).toEqual([
      [old.id, daysAgo(15)],
      [never.id, null],
    ]);
    expect(deletes).toEqual([]);
    expect((await sweepMemberInactivityCleanup(database.db, emby)).deleted).toBe(2);
    expect(deletes).toEqual(["old-play", "never-played"]);
    expect(local(old.id)).toBeUndefined();
    expect(local(never.id)).toBeUndefined();
    for (const protectedMember of [recent, fresh, localOnly]) expect(local(protectedMember.id)).toBeDefined();
    expect(users.has("unlinked")).toBe(true);
  });

  it("skips administrator accounts, shared bindings, and accounts with unverifiable playback", async () => {
    account("admin", null, true);
    account("owner");
    account("shared");
    account("unreachable");
    playback.delete("unreachable");
    const admin = member("admin@example.test", { embyUserId: "admin" });
    const owner = member("owner@example.test", { embyUserId: "owner" });
    const shared = member("shared@example.test", { embyUserId: "shared" });
    const duplicate = member("duplicate@example.test", { embyUserId: "shared" });
    const unreachable = member("unreachable@example.test", { embyUserId: "unreachable" });
    const result = await enable();
    expect(result.candidates).toEqual([]);
    expect(result.blocked.map(({ id, reason }) => [id, reason])).toEqual([
      [admin.id, "administrator"],
      [owner.id, "administrator"],
      [shared.id, "linked_elsewhere"],
      [duplicate.id, "linked_elsewhere"],
      [unreachable.id, "activity_unverified"],
    ]);
    expect((await sweepMemberInactivityCleanup(database.db, emby)).deleted).toBe(0);
    expect(deletes).toEqual([]);
  });

  it("requires a new preview if a candidate plays before the administrator saves", async () => {
    account("resumed", daysAgo(20));
    member("resumed@example.test", { embyUserId: "resumed" });
    const plan = await preview();
    expect(plan.candidates).toHaveLength(1);
    playback.set("resumed", daysAgo(0));
    expect((await request("PUT", path, { days, expectedDays: null, previewToken: plan.previewToken })).status).toBe(
      409,
    );
    expect(await (await request("GET")).json()).toEqual({ days: null });
  });

  it("uses recent recorded playback even if the item is absent upstream, while login alone does not extend the deadline", async () => {
    account("recent-play", daysAgo(20));
    account("login-only");
    const viewer = member("recent-play@example.test", { embyUserId: "recent-play" });
    const loginOnly = member("login-only@example.test", { embyUserId: "login-only" });
    const event = { source: "sampler", occurredAt: daysAgo(1), createdAt: daysAgo(1) } as const;
    database.db
      .insert(memberUsageEvents)
      .values([
        { ...event, embyUserId: "recent-play", kind: "play_start" },
        { ...event, embyUserId: "login-only", kind: "login" },
      ])
      .run();

    expect((await enable()).candidates.map(({ id }) => id)).toEqual([loginOnly.id]);
    expect((await sweepMemberInactivityCleanup(database.db, emby)).deleted).toBe(1);
    expect(deletes).toEqual(["login-only"]);
    expect(local(viewer.id)).toBeDefined();
  });

  it("rechecks live playback after claiming an account and before issuing DELETE", async () => {
    account("resumed", daysAgo(20));
    const resumed = member("resumed@example.test", { embyUserId: "resumed" });
    await enable();
    onReadRole = (id) => {
      if (database.db.select().from(memberExpiryCleanupJobs).get()) playing.add(id);
    };
    expect((await sweepMemberInactivityCleanup(database.db, emby)).deleted).toBe(0);
    expect(playing.has("resumed")).toBe(true);
    expect(local(resumed.id)).toBeDefined();
    expect(deletes).toEqual([]);
  });

  it("reconciles a lost delete response after disabling the rule without repeating DELETE", async () => {
    account("lost", daysAgo(20));
    const lost = member("lost@example.test", { embyUserId: "lost" });
    await enable();
    onDelete = (id) => (users.delete(id), 503);
    expect((await sweepMemberInactivityCleanup(database.db, emby)).pending).toBe(1);
    expect(local(lost.id)).toBeDefined();
    expect((await request("PUT", path, { days: null, expectedDays: days })).status).toBe(200);
    vi.setSystemTime(now.getTime() + 5 * 60_000);
    expect((await sweepMemberInactivityCleanup(database.db, emby)).deleted).toBe(1);
    expect(local(lost.id)).toBeUndefined();
    expect(deletes).toEqual(["lost"]);
  });
});
