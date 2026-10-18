import { afterEach, describe, expect, it, vi } from "vitest";
import { createPublicSessionManager } from "./public-session";
import { issueSessionToken } from "../auth/session-token";

afterEach(() => vi.useRealTimers());

describe("public session cookies", () => {
  it("preserves cookie scope, lifetime and normalized email", () => {
    const sessions = createPublicSessionManager("fixture-secret");
    const cookie = sessions.issueCookie("  Audit.Name@Example.Invalid  ");
    expect(cookie).toMatch(/^emby_public_session=v2\.member\./);
    expect(cookie).toContain("; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000");
    expect(cookie).not.toMatch(/;\s*Secure(?:;|$)/i);
    expect(sessions.read(cookie)).toEqual({ email: "audit.name@example.invalid" });
    expect(sessions.clearCookie()).toBe(
      "emby_public_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0; " + "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
    );
  });

  it("expires after 30 days and rejects missing, malformed and altered cookies", () => {
    vi.useFakeTimers();
    const now = new Date("2026-09-30T00:00:00Z");
    vi.setSystemTime(now);
    const sessions = createPublicSessionManager("fixture-secret");
    const cookie = sessions.issueCookie("audit@example.invalid");
    expect(sessions.read(undefined)).toEqual({ email: null });
    expect(sessions.read("emby_public_session=malformed")).toEqual({ email: null });
    expect(sessions.read(cookie.replace(".member.", ".admin."))).toEqual({ email: null });
    expect(createPublicSessionManager("different-secret").read(cookie)).toEqual({ email: null });
    vi.setSystemTime(now.getTime() + 30 * 24 * 60 * 60_000);
    expect(sessions.read(cookie)).toEqual({ email: null });
  });

  it("rejects a signed payload that is not a canonical UTF-8 email encoding", () => {
    const secret = "fixture-secret";
    const token = issueSessionToken({
      secret,
      purpose: "member",
      expiresAt: Math.floor(Date.now() / 1000) + 60,
      payload: "_w",
    });
    expect(createPublicSessionManager(secret).read(`emby_public_session=${token}`)).toEqual({ email: null });
  });
});
