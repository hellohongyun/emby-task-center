import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";

import { createSessionManager } from "../auth/session";
import { staticCredentialVerifier } from "../auth/test-session";
import { registerAuthRoutes } from "./auth";

function testApp(now: () => number, maxFailedAttempts = 1, lockoutBaseSeconds = 60) {
  const app = express();
  app.use(express.json());
  const sessions = createSessionManager({
    verifyCredentials: staticCredentialVerifier("family-password"),
    sessionSecret: "session-secret",
  });
  registerAuthRoutes(app, sessions, { maxFailedAttempts, lockoutBaseSeconds, now });
  return app;
}

function testAppFixed(now: () => number, maxFailedAttempts = 2, lockoutMinutes = 360) {
  const app = express();
  app.use(express.json());
  const sessions = createSessionManager({
    verifyCredentials: staticCredentialVerifier("family-password"),
    sessionSecret: "session-secret",
  });
  registerAuthRoutes(app, sessions, { maxFailedAttempts, lockoutMinutes, now });
  return app;
}

function startServer(app: ReturnType<typeof testApp>) {
  const server = app.listen(0);
  return new Promise<{ server: Server; baseUrl: string }>((resolve) => {
    server.once("listening", () =>
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      }),
    );
  });
}

describe("login rate limiting", () => {
  let server: Server;
  let baseUrl: string;
  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("locks the IP after the first failed attempt and rejects even a correct password", async () => {
    ({ server, baseUrl } = await startServer(testApp(() => Date.now())));
    const post = (password: string) =>
      fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password }),
      });

    const first = await post("wrong");
    expect(first.status).toBe(429);
    expect(first.headers.get("retry-after")).toBe("60");
    expect((await post("family-password")).status).toBe(429);
  });

  it("resets the counter after a successful login", async () => {
    let current = new Date("2026-08-12T00:00:00Z").getTime();
    ({ server, baseUrl } = await startServer(testApp(() => current)));
    const post = (password: string) =>
      fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password }),
      });

    expect((await post("wrong")).status).toBe(429);
    current += 60_000 + 1;
    expect((await post("family-password")).status).toBe(200);
    expect((await post("wrong")).status).toBe(429);
    current += 60_000 + 1;
    expect((await post("family-password")).status).toBe(200);
  });

  it("unlocks the IP after the first lockout expires", async () => {
    let current = new Date("2026-08-12T00:00:00Z").getTime();
    ({ server, baseUrl } = await startServer(testApp(() => current)));
    const post = (password: string) =>
      fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password }),
      });

    expect((await post("wrong")).status).toBe(429);
    current += 60_000 + 1;
    expect((await post("family-password")).status).toBe(200);
  });

  it("escalates the lockout with each subsequent failure", async () => {
    let current = new Date("2026-08-12T00:00:00Z").getTime();
    ({ server, baseUrl } = await startServer(testApp(() => current, 1, 2)));
    const post = (password: string) =>
      fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password }),
      });

    expect((await post("wrong")).headers.get("retry-after")).toBe("2");
    current += 2_000 + 1;
    expect((await post("wrong")).headers.get("retry-after")).toBe("4");
    current += 4_000 + 1;
    expect((await post("wrong")).headers.get("retry-after")).toBe("8");
  });

  it("reports the remaining lock time through lock-status", async () => {
    let current = new Date("2026-08-12T00:00:00Z").getTime();
    ({ server, baseUrl } = await startServer(testApp(() => current)));
    const post = (password: string) =>
      fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password }),
      });

    const before = await fetch(`${baseUrl}/api/auth/lock-status`);
    expect(await before.json()).toEqual({ locked: false, retryAfterSeconds: 0 });

    expect((await post("wrong")).status).toBe(429);
    current += 10_000;
    const locked = await (await fetch(`${baseUrl}/api/auth/lock-status`)).json();
    expect(locked).toEqual({ locked: true, retryAfterSeconds: 50 });
  });

  it("locks for a fixed duration after the configured failure count", async () => {
    let current = new Date("2026-08-12T00:00:00Z").getTime();
    ({ server, baseUrl } = await startServer(testAppFixed(() => current, 2, 360)));
    const post = (password: string) =>
      fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password }),
      });

    expect((await post("wrong")).status).toBe(401);
    expect((await post("wrong")).status).toBe(429);
    expect((await post("wrong")).headers.get("retry-after")).toBe("21600");
    // Lock duration is fixed: a third failure still reports 6 hours, not longer.
    expect((await post("family-password")).status).toBe(429);
    current += 21_600_000 + 1;
    expect((await post("family-password")).status).toBe(200);
  });

  it("clears the session cookie on logout", async () => {
    ({ server, baseUrl } = await startServer(testApp(() => Date.now())));

    const response = await fetch(`${baseUrl}/api/auth/logout`, { method: "POST" });

    expect(response.status).toBe(204);
    const setCookie = response.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("emby_task_session=;");
    expect(setCookie).toContain("Max-Age=0");
  });

  it("rejects an oversized password payload", async () => {
    ({ server, baseUrl } = await startServer(testApp(() => Date.now())));

    const response = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "x".repeat(1025) }),
    });

    expect(response.status).toBe(429);
  });
});

describe("credential handoff (P1: settings-backed admin account)", () => {
  let server: Server;
  let baseUrl: string;

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function appWith(verifier: ReturnType<typeof staticCredentialVerifier>, maxFailedAttempts = 1) {
    const app = express();
    app.use(express.json());
    const sessions = createSessionManager({ sessionSecret: "session-secret", verifyCredentials: verifier });
    registerAuthRoutes(app, sessions, { maxFailedAttempts, lockoutBaseSeconds: 60 });
    return app;
  }

  async function post(app: ReturnType<typeof appWith>, body: Record<string, unknown>) {
    ({ server, baseUrl } = await startServer(app as ReturnType<typeof testApp>));
    return fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("returns the identity and the default-password hint on success", async () => {
    const response = await post(appWith(staticCredentialVerifier("admin123", "admin", true)), {
      username: "admin",
      password: "admin123",
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("emby_task_session=");
    await expect(response.json()).resolves.toEqual({ username: "admin", mustChangePassword: true });
  });

  it("still accepts a password-only payload for legacy clients", async () => {
    const response = await post(appWith(staticCredentialVerifier("admin123")), { password: "admin123" });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ username: "admin", mustChangePassword: false });
  });

  it("rejects a mismatched username without locking a legitimately correct password", async () => {
    const response = await post(appWith(staticCredentialVerifier("admin123"), 2), {
      username: "root",
      password: "admin123",
    });
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "invalid_credentials" });
  });
});
