import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetPortalSession, usePortalSession } from "./usePortalSession";
import { portalAccessError } from "./portal-access";

beforeEach(() => {
  resetPortalSession();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const profile = { email: "member@example.com", member: { status: "active", subscriptionExpiresAt: null } };

describe("portal member request deadlines", () => {
  it.each(["headers", "body"])("settles a hung member %s and ignores its eventual result", async (phase) => {
    let resolve!: (value: unknown) => void;
    const pending = new Promise((yes) => {
      resolve = yes;
    });
    const response = new Response("{}");
    vi.spyOn(response, "json").mockImplementation(() => pending);
    vi.stubGlobal(
      "fetch",
      vi.fn(() => (phase === "headers" ? pending : Promise.resolve(response))),
    );
    const session = usePortalSession();
    const load = session.loadMember();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await load).toBe(false);
    resolve(phase === "headers" ? new Response(JSON.stringify(profile)) : profile);
    await Promise.resolve();
    await Promise.resolve();
    expect(session.loggedInEmail.value).toBe("");
  });

  it("gives login its write budget but clears loading after a hung body", async () => {
    const response = new Response("{}");
    vi.spyOn(response, "json").mockImplementation(() => new Promise(() => {}));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    const session = usePortalSession();
    const login = session.loginWithCode("member@example.com", "123456");
    await vi.advanceTimersByTimeAsync(15_000);
    expect(session.loading.value).toBe(true);
    await vi.advanceTimersByTimeAsync(75_000);
    expect(await login).toBe(false);
    expect(session.loading.value).toBe(false);
    expect(session.loggedInEmail.value).toBe("");
  });

  it("bounds hung non-policy error bodies as part of the same deadline", async () => {
    const response = new Response("{}", { status: 500 });
    vi.spyOn(response, "json").mockImplementation(() => new Promise(() => {}));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    const load = usePortalSession().loadMember();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await load).toBe(false);
  });

  it("ignores a refusal whose body arrives after the deadline", async () => {
    let resolve!: (value: unknown) => void;
    const pending = new Promise((yes) => {
      resolve = yes;
    });
    const response = new Response("{}", { status: 403 });
    vi.spyOn(response, "clone").mockReturnValue({ json: () => pending } as Response);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    const load = usePortalSession().loadMember();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await load).toBe(false);
    resolve({ error: "member_disabled" });
    await Promise.resolve();
    await Promise.resolve();
    expect(portalAccessError.value).toBe("");
  });
});
