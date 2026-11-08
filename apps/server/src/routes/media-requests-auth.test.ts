import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDatabase, type DatabaseHandle } from "@emby-task-center/database/client";
import { concurrencyEscalationState, submissionUsers } from "@emby-task-center/database/schema";
import type { MediaRequest, MediaRequestPage } from "@emby-task-center/contracts/media-request";
import { createApp } from "../app";
import { staticCredentialVerifier } from "../auth/test-session";
import { createLibraryService } from "../library/service";
import { addSubmissionUser, getSubmissionUserByEmail } from "../subscriptions/membership";
import { createPublicSessionManager } from "../subscriptions/public-session";
import { issueVerificationCode } from "../subscriptions/verification";
import type { TmdbClient } from "../tmdb/client";

const secret = "request-auth-only-secret";
const movie = { kind: "request", mediaType: "movie", tmdbId: 603, description: "希望添加" };
const television = { kind: "supplement", mediaType: "tv", tmdbId: 100, seasonNumber: 2, description: "缺 E03–E05" };

/** Full application registration and HTTP auth; all metadata is in-memory fixture data. */
describe("media request application auth and lifecycle", () => {
  let directory: string;
  let handle: DatabaseHandle;
  let server: Server;
  let base: string;
  let adminCookie: string;
  let memberCookie: string;
  let otherCookie: string;
  let memberId: number;
  const details = vi.fn<TmdbClient["details"]>(async (mediaType, id) => ({
    id,
    mediaType,
    title: mediaType === "movie" ? "黑客帝国" : "测试剧集",
    originalTitle: "Fixture Title",
    releaseYear: 1999,
    overview: "",
    posterUrl: null,
    backdropUrl: null,
    seasons: mediaType === "tv" ? [{ seasonNumber: 2, name: "第二季", episodeCount: 12, airDate: "2020-01-01" }] : [],
  }));
  beforeEach(async () => {
    details.mockClear();
    directory = mkdtempSync(join(tmpdir(), "request-http-auth-"));
    handle = createDatabase(join(directory, "app.db"));
    memberId = addSubmissionUser(handle.db, {
      email: "member@example.com",
      subscriptionExpiresAt: "2030-01-01T00:00:00.000Z",
    }).id;
    addSubmissionUser(handle.db, { email: "other@example.com", subscriptionExpiresAt: "2030-01-01T00:00:00.000Z" });
    const publicSession = createPublicSessionManager(secret, (email) => getSubmissionUserByEmail(handle.db, email));
    memberCookie = publicSession.issueCookie("member@example.com").split(";")[0]!;
    otherCookie = publicSession.issueCookie("other@example.com").split(";")[0]!;
    const tmdb: TmdbClient = {
      search: async () => [],
      details,
      seasonProgress: async () => ({
        seasonNumber: 2,
        airedEpisodes: 12,
        totalEpisodes: 12,
        lastAirDate: null,
        nextAirDate: null,
      }),
      airedEpisodeCount: async () => 12,
      seasonEpisodes: async () => [],
    };
    const app = createApp({
      database: handle.db,
      auth: { sessionSecret: secret, verifyCredentials: staticCredentialVerifier("request-test-password") },
      library: createLibraryService([]),
      tmdb,
    });
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const login = await send("/api/auth/login", "", { password: "request-test-password" });
    expect(login.status).toBe(200);
    adminCookie = login.headers.get("set-cookie")!.split(";")[0]!;
  });
  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    handle.close();
    rmSync(directory, { recursive: true, force: true });
  });
  function send(path: string, cookie: string, body?: unknown, method = body === undefined ? "GET" : "POST") {
    return fetch(`${base}${path}`, {
      method,
      headers: { cookie, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10000),
    });
  }
  async function create(cookie: string, body: unknown) {
    const result = await send("/api/public/media-requests", cookie, body);
    expect(result.status).toBe(201);
    return ((await result.json()) as { request: MediaRequest }).request;
  }
  it("keeps member and administrator sessions separate for every new endpoint", async () => {
    for (const cookie of ["", adminCookie]) {
      expect((await send("/api/public/media-requests", cookie)).status).toBe(401);
      expect((await send("/api/public/media-requests", cookie, movie)).status).toBe(401);
      expect((await send("/api/public/media-requests/1", cookie, { description: "更改" }, "PATCH")).status).toBe(401);
    }
    for (const cookie of ["", memberCookie]) {
      expect((await send("/api/media-requests", cookie)).status).toBe(401);
      expect((await send("/api/media-requests/1", cookie, {}, "PATCH")).status).toBe(401);
      expect((await send(`/api/submission-users/${memberId}/renew`, cookie, {})).status).toBe(401);
    }
    expect(details).not.toHaveBeenCalled();
  });
  it("creates movies and TV seasons, isolates members, and shows administrator feedback to the owner", async () => {
    const ownMovie = await create(memberCookie, movie);
    const ownSeason = await create(memberCookie, television);
    const otherMovie = await create(otherCookie, movie);
    const readOwn = async () =>
      (await (await send("/api/public/media-requests", memberCookie)).json()) as MediaRequestPage;
    const own = await readOwn();
    expect(own.total).toBe(2);
    expect(own.items.map((item) => item.id).sort()).toEqual([ownMovie.id, ownSeason.id].sort());
    for (const item of own.items) {
      expect(item).not.toHaveProperty("memberEmail");
      expect(item).not.toHaveProperty("memberId");
    }
    const other = (await (await send("/api/public/media-requests", otherCookie)).json()) as MediaRequestPage;
    expect(other.items.map((item) => item.id)).toEqual([otherMovie.id]);
    const forbiddenEdit = await send(
      `/api/public/media-requests/${otherMovie.id}`,
      memberCookie,
      { description: "越权修改", updatedAt: otherMovie.updatedAt },
      "PATCH",
    );
    expect(forbiddenEdit.status).toBe(404);
    const adminList = (await (await send("/api/media-requests", adminCookie)).json()) as MediaRequestPage<
      MediaRequest & { memberEmail: string }
    >;
    expect(adminList.total).toBe(3);
    expect(adminList.items.find((item) => item.id === ownSeason.id)?.memberEmail).toBe("member@example.com");
    const processing = await send(
      `/api/media-requests/${ownSeason.id}`,
      adminCookie,
      { status: "processing", adminNote: "正在寻找第二季片源", updatedAt: ownSeason.updatedAt },
      "PATCH",
    );
    expect(processing.status).toBe(200);
    const updated = ((await processing.json()) as { request: MediaRequest }).request;
    expect((await readOwn()).items.find((item) => item.id === ownSeason.id)).toMatchObject({
      status: "processing",
      adminNote: "正在寻找第二季片源",
      seasonNumber: 2,
    });
    const available = await send(
      `/api/media-requests/${ownSeason.id}`,
      adminCookie,
      { status: "available", adminNote: "已补齐，可刷新媒体库", updatedAt: updated.updatedAt },
      "PATCH",
    );
    expect(available.status).toBe(200);
    expect((await readOwn()).items.find((item) => item.id === ownSeason.id)).toMatchObject({
      status: "available",
      adminNote: "已补齐，可刷新媒体库",
    });
  });
  it.each(["disabled", "expired", "frozen", "deleted"] as const)(
    "rechecks %s membership against an already-issued cookie",
    async (state) => {
      const request = await create(memberCookie, movie);
      if (state === "disabled")
        handle.db.update(submissionUsers).set({ enabled: false }).where(eq(submissionUsers.id, memberId)).run();
      if (state === "expired")
        handle.db
          .update(submissionUsers)
          .set({ subscriptionExpiresAt: "2020-01-01T00:00:00.000Z" })
          .where(eq(submissionUsers.id, memberId))
          .run();
      if (state === "frozen")
        handle.db
          .insert(concurrencyEscalationState)
          .values({ memberId, disabledUntil: "2030-01-01T00:00:00.000Z", updatedAt: new Date().toISOString() })
          .run();
      if (state === "deleted") handle.db.delete(submissionUsers).where(eq(submissionUsers.id, memberId)).run();
      const code = {
        disabled: "member_disabled",
        expired: "membership_expired",
        frozen: "member_frozen",
        deleted: "not_member",
      }[state];
      for (const result of [
        await send("/api/public/media-requests", memberCookie),
        await send("/api/public/media-requests", memberCookie, television),
        await send(
          `/api/public/media-requests/${request.id}`,
          memberCookie,
          { description: "补充说明", updatedAt: request.updatedAt },
          "PATCH",
        ),
      ]) {
        expect(result.status).toBe(403);
        expect(await result.json()).toEqual({ error: code });
      }
      expect(details).toHaveBeenCalledTimes(1);
    },
  );

  it("rejects the old login after the administrator recreates a member with the same email", async () => {
    const email = "member@example.com";
    async function loginMember() {
      const code = issueVerificationCode(handle.db, email);
      const result = await send("/api/public/subscriptions/login", "", { email, code });
      expect(result.status).toBe(200);
      return result.headers.get("set-cookie")!.split(";")[0]!;
    }
    const old = await loginMember();
    expect((await send(`/api/submission-users/${memberId}`, adminCookie, undefined, "DELETE")).status).toBe(204);
    expect((await send("/api/public/media-requests", old)).status).toBe(403);
    const created = await send("/api/submission-users", adminCookie, { email });
    expect(created.status).toBe(201);
    expect((await created.json()).user.id).not.toBe(memberId);
    const current = await loginMember();
    const freshRequest = await create(current, movie);
    expect((await send("/api/public/media-requests", old)).status).toBe(401);
    const rejected = await send(
      `/api/public/media-requests/${freshRequest.id}`,
      old,
      {
        description: "越权修改",
        updatedAt: freshRequest.updatedAt,
      },
      "PATCH",
    );
    expect(rejected.status).toBe(401);
  });
});
