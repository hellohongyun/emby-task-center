import { effectScope } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSystem } from "./useSystem";
import { useIntegrations } from "./useIntegrations";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const systemBody = { rootCount: 2, lastScanAt: null, serverTime: "now" };
const integrationBody = { embyConfigured: true, emailConfigured: true, emailMissing: [] };
const stalledBody = (ok = true) => ({ ok, status: ok ? 200 : 502, json: () => new Promise(() => {}) }) as Response;
afterEach(() => vi.useRealTimers());

describe("system and integration request lifecycle", () => {
  it("ignores stale system 401 and finally while the replacement is loading", async () => {
    const old = deferred<Response>();
    const next = deferred<Response>();
    const fetchImpl = vi
      .fn()
      .mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce(Response.json({ activity: [] }))
      .mockReturnValueOnce(next.promise)
      .mockResolvedValueOnce(Response.json({ activity: [] }));
    const requireAuth = vi.fn();
    const api = useSystem(requireAuth, fetchImpl);
    const first = api.load();
    const second = api.load();
    old.resolve(new Response(null, { status: 401 }));
    await first;
    expect(api.loading.value).toBe(true);
    expect(requireAuth).not.toHaveBeenCalled();
    next.resolve(Response.json(systemBody));
    await second;
    expect(api.status.value).toEqual(systemBody);
    expect(api.error.value).toBe("");
  });

  it("times out a stalled system success body and clears loading", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(stalledBody())
      .mockResolvedValueOnce(Response.json({ activity: [] }));
    const api = useSystem(vi.fn(), fetchImpl);
    const pending = api.load();
    await vi.advanceTimersByTimeAsync(15_000);
    await pending;
    expect(api.loading.value).toBe(false);
    expect(api.error.value).toContain("无法读取");
  });

  it("keeps only the newest integration load and suppresses its predecessor's 401", async () => {
    const old = deferred<Response>();
    const next = deferred<Response>();
    const fetchImpl = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
    const requireAuth = vi.fn();
    const api = useIntegrations(requireAuth, fetchImpl);
    const first = api.load();
    const second = api.load();
    old.resolve(new Response(null, { status: 401 }));
    await first;
    expect(api.loading.value).toBe(true);
    expect(api.loaded.value).toBe(false);
    expect(requireAuth).not.toHaveBeenCalled();
    next.resolve(Response.json(integrationBody));
    await second;
    expect(api.status.value).toEqual(integrationBody);
  });

  it("times out integration error bodies without leaking the loading state", async () => {
    vi.useFakeTimers();
    const api = useIntegrations(vi.fn(), vi.fn().mockResolvedValue(stalledBody(false)));
    const pending = api.load();
    await vi.advanceTimersByTimeAsync(15_000);
    await pending;
    expect(api.loading.value).toBe(false);
    expect(api.loaded.value).toBe(true);
    expect(api.error.value).toContain("无法读取");
  });

  it("preserves the 30 second Emby and 90 second email test budgets including bodies", async () => {
    vi.useFakeTimers();
    const api = useIntegrations(vi.fn(), vi.fn().mockResolvedValue(stalledBody()));
    const emby = api.testEmby();
    const email = api.testEmail("member@example.com");
    const embyResult = expect(emby).rejects.toThrow("请求超时");
    const emailResult = expect(email).rejects.toThrow("测试邮件可能已发送");
    await vi.advanceTimersByTimeAsync(29_999);
    await vi.advanceTimersByTimeAsync(1);
    await embyResult;
    await vi.advanceTimersByTimeAsync(60_000);
    await emailResult;
  });

  it("ignores cancelled tests' late authorization failures after reentry", async () => {
    const old = deferred<Response>();
    const fetchImpl = vi
      .fn()
      .mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce(Response.json({ ok: true, serverName: "new", version: "1" }));
    const auth = vi.fn();
    const api = useIntegrations(auth, fetchImpl);
    const first = api.testEmby();
    const aborted = expect(first).rejects.toMatchObject({ name: "AbortError" });
    api.cancel();
    await expect(api.testEmby()).resolves.toMatchObject({ serverName: "new" });
    old.resolve(new Response(null, { status: 401 }));
    await aborted;
    expect(auth).not.toHaveBeenCalled();
  });

  it("coalesces repeated email tests without sending another POST", async () => {
    const response = deferred<Response>();
    const fetchImpl = vi.fn().mockReturnValue(response.promise);
    const api = useIntegrations(vi.fn(), fetchImpl);
    const first = api.testEmail("first@example.com");
    const second = api.testEmail("second@example.com");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
    response.resolve(Response.json({ ok: true }));
    await Promise.all([first, second]);
  });

  it("scope disposal cancels system and all integration operations and prevents further requests", async () => {
    const scope = effectScope();
    const old = deferred<Response>();
    const fetchImpl = vi.fn().mockReturnValue(old.promise);
    const auth = vi.fn();
    const { system, integrations } = scope.run(() => ({
      system: useSystem(auth, fetchImpl),
      integrations: useIntegrations(auth, fetchImpl),
    }))!;
    const systemLoad = system.load();
    const integrationLoad = integrations.load();
    const test = integrations.testEmail("member@example.com");
    const rejected = expect(test).rejects.toMatchObject({ name: "AbortError" });
    scope.stop();
    old.resolve(new Response(null, { status: 401 }));
    await Promise.all([systemLoad, integrationLoad, rejected]);
    const count = fetchImpl.mock.calls.length;
    await system.load();
    await integrations.load();
    await expect(integrations.testEmby()).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchImpl).toHaveBeenCalledTimes(count);
    expect(auth).not.toHaveBeenCalled();
    expect(system.loading.value).toBe(false);
    expect(integrations.loading.value).toBe(false);
  });

  it("page cancellation keeps shared services reusable on reentry", async () => {
    const old = deferred<Response>();
    const fetchImpl = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValueOnce(Response.json(integrationBody));
    const api = useIntegrations(vi.fn(), fetchImpl);
    const first = api.load();
    api.cancel();
    await api.load();
    old.resolve(Response.json({ ...integrationBody, embyConfigured: false }));
    await first;
    expect(api.status.value.embyConfigured).toBe(true);
  });
});
