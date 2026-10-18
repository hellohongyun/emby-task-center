import { effectScope } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useEmbyUsers } from "./useEmbyUsers";
import type { EmbyUserRow } from "../types";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const user = { id: "u1", name: "alice", isDisabled: false } as EmbyUserRow;

afterEach(() => vi.useRealTimers());

describe("Emby admin request lifecycle", () => {
  it("keeps only the latest refresh and ignores its predecessor's unauthorized response", async () => {
    const old = deferred<Response>();
    const newest = deferred<Response>();
    const fetchImpl = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(newest.promise);
    const requireAuth = vi.fn();
    const users = useEmbyUsers(requireAuth, fetchImpl);
    const first = users.load();
    const second = users.load();
    await first;
    expect(users.loading.value).toBe(true);
    old.resolve(json({}, 401));
    newest.resolve(json({ users: [user] }));
    await second;
    expect(users.users.value).toEqual([user]);
    expect(requireAuth).not.toHaveBeenCalled();
    expect(users.error.value).toBe("");
    expect(users.loading.value).toBe(false);
  });

  it.each([200, 502])("includes stalled HTTP %s response bodies in the 15 second read deadline", async (status) => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn().mockResolvedValue({ status, ok: status === 200, json: () => new Promise(() => {}) });
    const users = useEmbyUsers(undefined, fetchImpl);
    const pending = users.load();
    await vi.advanceTimersByTimeAsync(15_000);
    await pending;
    expect(users.loading.value).toBe(false);
    expect(users.error.value).toContain("读取超时");
    expect(fetchImpl.mock.calls[0]?.[1].signal.aborted).toBe(true);
  });

  it("allows the online sessions upstream request and detail budget to finish after 15 seconds", async () => {
    vi.useFakeTimers();
    const result = deferred<Response>();
    const users = useEmbyUsers(undefined, vi.fn().mockReturnValue(result.promise));
    const pending = users.loadSessions();
    await vi.advanceTimersByTimeAsync(17_000);
    result.resolve(json({ sessions: [{ id: "session" }] }));
    await pending;
    expect(users.sessions.value[0]?.id).toBe("session");
    expect(users.error.value).toBe("");
  });

  it("rejects a conflicting account write without submitting or claiming success, while another account may proceed", async () => {
    const first = deferred<Response>();
    const fetchImpl = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValue(json({ ok: true }));
    const users = useEmbyUsers(undefined, fetchImpl);
    const password = users.setPassword("u1", "first-password");
    expect(await users.setPassword("u1", "second-password")).toBe(false);
    await users.removeUser("u1");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(await users.setPassword("u2", "other-password")).toBe(true);
    expect(users.busy.value).toBe(true);
    first.resolve(json({ ok: true }));
    expect(await password).toBe(true);
    expect(users.busy.value).toBe(false);
  });

  it("invalidates refreshes issued during account deletion so they cannot resurrect the user", async () => {
    const removal = deferred<Response>();
    const read = deferred<Response>();
    const fetchImpl = vi.fn().mockReturnValueOnce(removal.promise).mockReturnValueOnce(read.promise);
    const users = useEmbyUsers(undefined, fetchImpl);
    users.users.value = [user];
    const deleted = users.removeUser("u1");
    const refresh = users.load();
    removal.resolve(json({ ok: true }));
    await deleted;
    await refresh;
    read.resolve(json({ users: [user] }));
    await Promise.resolve();
    expect(users.users.value).toEqual([]);
    expect(users.loading.value).toBe(false);
  });

  it("gives multi-step writes 90 seconds and warns that a timed out operation may have succeeded", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn().mockReturnValue(new Promise(() => {}));
    const users = useEmbyUsers(undefined, fetchImpl);
    const pending = users.setPassword("u1", "password");
    await vi.advanceTimersByTimeAsync(15_000);
    expect(users.busy.value).toBe(true);
    await vi.advanceTimersByTimeAsync(75_000);
    expect(await pending).toBe(false);
    expect(users.busy.value).toBe(false);
    expect(users.error.value).toContain("结果可能已生效");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("scope disposal aborts reads and writes and prevents late 401 and creation refresh", async () => {
    const result = deferred<Response>();
    const fetchImpl = vi.fn().mockReturnValue(result.promise);
    const requireAuth = vi.fn();
    const scope = effectScope();
    const users = scope.run(() => useEmbyUsers(requireAuth, fetchImpl))!;
    const read = users.loadSessions();
    const write = users.createUser({ name: "alice" });
    scope.stop();
    await read;
    expect(await write).toBe(false);
    result.resolve(json({}, 401));
    await Promise.resolve();
    expect(requireAuth).not.toHaveBeenCalled();
    expect(users.busy.value).toBe(false);
    expect(users.error.value).toBe("");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls.every((call) => call[1].signal.aborted)).toBe(true);
  });

  it("current unauthorized response stops all other requests and never applies late data", async () => {
    const sessions = deferred<Response>();
    const fetchImpl = vi.fn().mockReturnValueOnce(sessions.promise).mockResolvedValue(json({}, 401));
    const requireAuth = vi.fn();
    const users = useEmbyUsers(requireAuth, fetchImpl);
    const pending = users.loadSessions();
    await users.load();
    await pending;
    sessions.resolve(json({ sessions: [{ id: "old" }] }));
    await Promise.resolve();
    expect(requireAuth).toHaveBeenCalledOnce();
    expect(users.sessions.value).toEqual([]);
    expect(users.loading.value).toBe(false);
    await users.load();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
