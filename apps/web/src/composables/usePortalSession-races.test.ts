import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetPortalSession, usePortalSession } from "./usePortalSession";
import { portalAccessError, portalFetch } from "./portal-access";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const profile = (email = "old@example.com", status = "active") => ({
  email,
  member: { email, status, contentAccess: status === "active", subscriptionExpiresAt: null },
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
beforeEach(resetPortalSession);
afterEach(() => vi.unstubAllGlobals());

describe("portal session request ownership", () => {
  it("does not restore a member after logout, even when transport ignores abort", async () => {
    const pending = deferred<Response>();
    const fetchMock = vi.fn((url: string) =>
      url.endsWith("/logout") ? Promise.resolve(json({ ok: true })) : pending.promise,
    );
    vi.stubGlobal("fetch", fetchMock);
    const s = usePortalSession();
    const load = s.loadMember();
    await s.logout();
    pending.resolve(json(profile()));
    expect(await load).toBe(false);
    expect(s.loggedInEmail.value).toBe("");
    expect(s.contentAllowed.value).toBe(false);
    expect(fetchMock.mock.calls[0]?.[0]).toContain("/member");
  });

  it("keeps the newer member when two profile responses finish out of order", async () => {
    const old = deferred<Response>();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockReturnValueOnce(old.promise)
        .mockResolvedValueOnce(json(profile("new@example.com", "expired"))),
    );
    const s = usePortalSession();
    const first = s.loadMember();
    expect(await s.loadMember()).toBe(true);
    old.resolve(json(profile()));
    expect(await first).toBe(false);
    expect(s.loggedInEmail.value).toBe("new@example.com");
    expect(s.memberStatus.value).toBe("expired");
  });

  it.each(["login", "activate"])("ignores old %s and its loading completion after identity switches", async (kind) => {
    const old = deferred<Response>();
    const newer = deferred<Response>();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockReturnValueOnce(old.promise)
        .mockReturnValueOnce(newer.promise)
        .mockResolvedValue(json(profile("new@example.com"))),
    );
    const s = usePortalSession();
    const first =
      kind === "login" ? s.loginWithCode("old@example.com", "123456") : s.activate("old@example.com", "123456", "card");
    const second = s.loginWithCode("new@example.com", "654321");
    old.resolve(json({ ...profile(), emby: { password: "secret" } }));
    expect(await first).toBe(false);
    expect(s.loading.value).toBe(true);
    expect(s.activatedEmby.value).toBeNull();
    newer.resolve(json(profile("new@example.com")));
    expect(await second).toBe(true);
    expect(s.loggedInEmail.value).toBe("new@example.com");
    expect(s.loading.value).toBe(false);
  });

  it.each(["checkEntry", "checkCard", "sendCode"] as const)(
    "discards stale %s when email input changes",
    async (method) => {
      const old = deferred<Response>();
      vi.stubGlobal(
        "fetch",
        vi.fn(() => old.promise),
      );
      const s = usePortalSession();
      s.email.value = "old@example.com";
      const result = s[method](s.email.value);
      s.email.value = "new@example.com";
      old.resolve(json({ error: "member_disabled" }, 403));
      expect(await result).toBeNull();
      expect(s.email.value).toBe("new@example.com");
      expect(s.error.value).toBe("");
      expect(portalAccessError.value).toBe("");
    },
  );

  it("preserves a newer refusal over an old successful profile", async () => {
    const old = deferred<Response>();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockReturnValueOnce(old.promise)
        .mockResolvedValueOnce(json({ error: "member_frozen" }, 403)),
    );
    const s = usePortalSession();
    s.loggedInEmail.value = "old@example.com";
    const load = s.loadMember();
    await portalFetch("/api/public/library/list");
    old.resolve(json(profile()));
    expect(await load).toBe(false);
    expect(portalAccessError.value).toBe("member_frozen");
    expect(s.contentAllowed.value).toBe(false);
  });

  it("does not let an old content refusal log out a new identity", async () => {
    const old = deferred<Response>();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockReturnValueOnce(old.promise)
        .mockResolvedValue(json(profile("new@example.com"))),
    );
    const content = portalFetch("/api/public/library/list");
    const s = usePortalSession();
    expect(await s.loginWithCode("new@example.com", "123456")).toBe(true);
    old.resolve(json({ error: "member_disabled" }, 403));
    await content;
    expect(s.loggedInEmail.value).toBe("new@example.com");
    expect(s.contentAllowed.value).toBe(true);
    expect(portalAccessError.value).toBe("");
  });

  it("ignores a refusal when cancellation happens during its body read", async () => {
    const body = deferred<unknown>();
    const response = json({ error: "unauthorized" }, 401);
    vi.spyOn(response, "clone").mockReturnValue({ json: () => body.promise } as Response);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    const controller = new AbortController();
    const request = portalFetch("/api/public/library/list", { signal: controller.signal });
    await Promise.resolve();
    controller.abort();
    body.resolve({ error: "unauthorized" });
    await request;
    expect(portalAccessError.value).toBe("");
  });

  it("suppresses stale transport failures after reset", async () => {
    const old = deferred<Response>();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => old.promise),
    );
    const s = usePortalSession();
    const login = s.loginWithCode("old@example.com", "123456");
    resetPortalSession();
    old.reject(new Error("network_failed"));
    expect(await login).toBe(false);
    expect(s.error.value).toBe("");
    expect(s.loading.value).toBe(false);
  });
});
