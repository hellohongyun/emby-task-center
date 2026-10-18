import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDatabase, type DatabaseHandle } from "@emby-task-center/database/client";
import { submissionUsers } from "@emby-task-center/database/schema";
import { createApp } from "../app";
import { staticCredentialVerifier } from "../auth/test-session";
import { createLibraryService } from "../library/service";
import { issueVerificationCode } from "../subscriptions/verification";
import type { TmdbClient } from "../tmdb/client";

const password = "http-fixture-password";
const tmdb: TmdbClient = {
  search: async () => [],
  details: async () => {
    throw new Error("unexpected external metadata request");
  },
  seasonProgress: async () => ({
    seasonNumber: 1,
    airedEpisodes: 0,
    totalEpisodes: 0,
    lastAirDate: null,
    nextAirDate: null,
  }),
  airedEpisodeCount: async () => 0,
  seasonEpisodes: async () => [],
};

describe("production HTTP direct login", () => {
  let directory: string;
  let database: DatabaseHandle;
  let server: Server;
  let app: ReturnType<typeof createApp>;
  let baseUrl: string;

  beforeEach(async () => {
    vi.stubEnv("NODE_ENV", "production");
    directory = mkdtempSync(join(tmpdir(), "emby-http-direct-"));
    database = createDatabase(join(directory, "app.sqlite"));
    app = createApp({
      database: database.db,
      auth: { sessionSecret: "http-fixture-session-secret", verifyCredentials: staticCredentialVerifier(password) },
      authLimits: { maxFailedAttempts: 1, lockoutMinutes: 1 },
      tmdb,
      library: createLibraryService([]),
    });
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    if (server)
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await app?.locals.closePublicLibrary?.();
    database?.close();
    if (directory) rmSync(directory, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  const request = (path: string, init: RequestInit = {}) =>
    fetch(`${baseUrl}${path}`, { ...init, signal: AbortSignal.timeout(5_000) });
  const login = (candidate = password, headers: Record<string, string> = {}) =>
    request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ username: "admin", password: candidate }),
    });

  function assertHttpCookie(cookie: string) {
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    // Inspect the header itself; localhost browsers can otherwise hide a Secure-cookie regression.
    expect(cookie).not.toMatch(/(?:^|;)\s*Secure(?:;|$)/i);
  }

  it.each([false, true])("keeps admin HTTP sessions working (forged HTTPS header: %s)", async (forged) => {
    expect((await request("/api/virtual-libraries")).status).toBe(401);
    const response = await login(password, forged ? { "x-forwarded-proto": "https" } : {});
    expect(response.status).toBe(200);
    expect(response.headers.get("strict-transport-security")).toBeNull();
    const cookie = response.headers.get("set-cookie") ?? "";
    assertHttpCookie(cookie);
    const protectedResponse = await request("/api/virtual-libraries", { headers: { cookie: cookie.split(";")[0] } });
    expect(protectedResponse.status).toBe(200);
    expect(protectedResponse.headers.get("strict-transport-security")).toBeNull();
  });

  it("issues an HTTP member session and clears both cookie scopes on admin logout", async () => {
    const email = "http-member@example.com";
    const timestamp = new Date().toISOString();
    database.db
      .insert(submissionUsers)
      .values({
        email,
        enabled: true,
        subscriptionExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .run();
    const code = issueVerificationCode(database.db, email);
    const member = await request("/api/public/subscriptions/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, code }),
    });
    expect(member.status).toBe(200);
    const memberCookie = member.headers.get("set-cookie") ?? "";
    assertHttpCookie(memberCookie);
    const profile = await request("/api/public/subscriptions/member", {
      headers: { cookie: memberCookie.split(";")[0] },
    });
    expect(profile.status).toBe(200);
    expect(await profile.json()).toMatchObject({ email });

    const admin = await login();
    const adminCookie = (admin.headers.get("set-cookie") ?? "").split(";")[0];
    const logout = await request("/api/auth/logout", {
      method: "POST",
      headers: { cookie: `${adminCookie}; ${memberCookie.split(";")[0]}` },
    });
    expect(logout.status).toBe(204);
    const cleared = logout.headers.getSetCookie();
    expect(cleared).toHaveLength(2);
    expect(cleared.some((cookie) => cookie.startsWith("emby_task_session=;"))).toBe(true);
    expect(cleared.some((cookie) => cookie.startsWith("emby_public_session=;"))).toBe(true);
    for (const cookie of cleared) {
      expect(cookie).toContain("Max-Age=0");
      assertHttpCookie(cookie);
    }
  });

  it("does not let forwarded IP or protocol headers bypass a direct client's login lock", async () => {
    const first = await login("incorrect", { "x-forwarded-for": "192.0.2.10", "x-forwarded-proto": "https" });
    expect(first.status).toBe(429);
    const second = await login(password, { "x-forwarded-for": "192.0.2.11", "x-forwarded-proto": "http" });
    expect(second.status).toBe(429);
    expect(second.headers.get("set-cookie")).toBeNull();
    const status = await request("/api/auth/lock-status", { headers: { "x-forwarded-for": "192.0.2.12" } });
    expect(await status.json()).toMatchObject({ locked: true });
    expect(status.headers.get("strict-transport-security")).toBeNull();
  });
});
