import { describe, expect, it } from "vitest";

import { createSessionManager } from "./session";
import { staticCredentialVerifier } from "./test-session";

describe("session cookies", () => {
  it("issues a cookie with the configured lifetime", () => {
    const sessions = createSessionManager({
      sessionSecret: "session-secret",
      lifetimeSeconds: 90 * 24 * 60 * 60,
      verifyCredentials: staticCredentialVerifier("family-password"),
    });

    expect(sessions.issueCookie(new Date("2026-08-12T00:00:00Z"))).toContain("Max-Age=7776000");
  });

  it("issues and clears HTTP-compatible session cookies with the same scope", () => {
    const sessions = createSessionManager({
      sessionSecret: "session-secret",
      verifyCredentials: staticCredentialVerifier("family-password"),
    });

    expect(sessions.issueCookie()).not.toMatch(/;\s*Secure(?:;|$)/i);
    expect(sessions.issueCookie()).toContain("; Path=/; HttpOnly; SameSite=Strict;");
    expect(sessions.clearCookie()).toBe(
      "emby_task_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0; " + "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
    );
  });

  it("delegates credential checks to the injected verifier", () => {
    const sessions = createSessionManager({
      sessionSecret: "session-secret",
      // P1：凭据来自数据库设置，会话层只负责转发与签名。
      verifyCredentials: (username, password) =>
        password === "db-password" ? { username: username || "admin", mustChangePassword: true } : null,
    });

    expect(sessions.authenticate("admin", "db-password")).toEqual({ username: "admin", mustChangePassword: true });
    expect(sessions.authenticate(undefined, "db-password")).toEqual({ username: "admin", mustChangePassword: true });
    expect(sessions.authenticate("admin", "wrong")).toBeNull();
  });
});
