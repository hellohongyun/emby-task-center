import { effectScope } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useTasks } from "./useTasks";

const stops: Array<() => void> = [];
function subject(fetchImpl: typeof fetch) {
  const scope = effectScope();
  stops.push(() => scope.stop());
  return { api: scope.run(() => useTasks({ fetchImpl, autoLoad: false }))!, stop: () => scope.stop() };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { resolve, promise };
}
afterEach(() => {
  stops.splice(0).forEach((stop) => stop());
  vi.useRealTimers();
});

describe("admin auth request lifecycle", () => {
  it("settles a stalled login with a network error instead of a password error", async () => {
    vi.useFakeTimers();
    const { api } = subject(vi.fn(() => new Promise<Response>(() => {})) as typeof fetch);
    const login = api.login("password");
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await login).toBe(false);
    expect(api.error.value).toContain("连接登录服务");
  });

  it("keeps the lock deadline through its stalled JSON body", async () => {
    vi.useFakeTimers();
    const response = Response.json({});
    vi.spyOn(response, "json").mockImplementation(() => new Promise(() => {}));
    const { api } = subject(vi.fn().mockResolvedValue(response));
    const lock = api.refreshLockStatus();
    await vi.advanceTimersByTimeAsync(15_000);
    await lock;
    expect(api.lockChecking.value).toBe(false);
    expect(api.error.value).toContain("锁定状态");
  });

  it("clears protected state immediately and bounds a stalled logout", async () => {
    vi.useFakeTimers();
    const { api } = subject(vi.fn(() => new Promise<Response>(() => {})) as typeof fetch);
    const pending = api.logout();
    expect(api.authRequired.value).toBe(true);
    expect(api.authChecking.value).toBe(false);
    await vi.advanceTimersByTimeAsync(15_000);
    await pending;
    expect(api.error.value).toContain("退出请求未完成");
  });

  it("does not load tasks for a login arriving after logout", async () => {
    const old = deferred<Response>();
    const fetchImpl = vi
      .fn()
      .mockImplementationOnce(() => old.promise)
      .mockResolvedValue(new Response(null, { status: 204 }));
    const { api } = subject(fetchImpl);
    const login = api.login("password");
    await Promise.resolve();
    await api.logout();
    old.resolve(new Response(null, { status: 204 }));
    expect(await login).toBe(false);
    expect(fetchImpl.mock.calls.map(([url]) => url)).not.toContain("/api/tasks");
    expect(api.authRequired.value).toBe(true);
  });

  it("does not reload or restart polling after disposal", async () => {
    const old = deferred<Response>();
    const fetchImpl = vi.fn().mockReturnValue(old.promise);
    const { api, stop } = subject(fetchImpl);
    const login = api.login("password");
    await Promise.resolve();
    stop();
    old.resolve(new Response(null, { status: 204 }));
    expect(await login).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("ignores explicit task refresh and polling requests after scope disposal", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn().mockResolvedValue(Response.json({ tasks: [] }));
    const { api, stop } = subject(fetchImpl);
    stop();
    await api.load();
    api.startAutoRefresh(1000);
    api.requireAuth();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(api.authRequired.value).toBe(false);
  });

  it("does not let an older lock response overwrite the newest response", async () => {
    const old = deferred<Response>();
    const fetchImpl = vi
      .fn()
      .mockImplementationOnce(() => old.promise)
      .mockResolvedValueOnce(Response.json({ locked: true, retryAfterSeconds: 42 }));
    const { api } = subject(fetchImpl);
    const first = api.refreshLockStatus();
    await api.refreshLockStatus();
    old.resolve(Response.json({ locked: false }));
    await first;
    expect(api.lockRemaining.value).toBe(42);
    expect(api.lockChecking.value).toBe(false);
  });

  it("waits for logout headers before sending the next login and deduplicates logout", async () => {
    const old = deferred<Response>();
    const fetchImpl = vi
      .fn()
      .mockImplementationOnce(() => old.promise)
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(Response.json({ tasks: [] }));
    const { api } = subject(fetchImpl);
    const logout = api.logout();
    expect(api.logout()).toBe(logout);
    const login = api.login("password");
    await Promise.resolve();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    old.resolve(new Response(null, { status: 204 }));
    await logout;
    expect(await login).toBe(true);
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual(["/api/auth/logout", "/api/auth/login", "/api/tasks"]);
    expect(api.authRequired.value).toBe(false);
  });

  it.each([401, 503])("distinguishes HTTP %s from lockouts and network failures", async (status) => {
    const { api } = subject(vi.fn().mockResolvedValue(new Response(null, { status })));
    expect(await api.login("password")).toBe(false);
    expect(api.error.value).toContain(status === 401 ? "口令不正确" : "登录服务暂时不可用");
  });

  it("a second logout cancels a login waiting behind the first logout", async () => {
    const old = deferred<Response>();
    const fetchImpl = vi.fn().mockReturnValue(old.promise);
    const { api } = subject(fetchImpl);
    api.lockRemaining.value = 42;
    const logout = api.logout();
    const login = api.login("password");
    expect(api.logout()).toBe(logout);
    old.resolve(new Response(null, { status: 204 }));
    await logout;
    expect(await login).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(api.authRequired.value).toBe(true);
    expect(api.lockRemaining.value).toBe(0);
  });
});
