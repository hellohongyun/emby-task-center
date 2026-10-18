import { effectScope } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useTasks } from "./useTasks";

function deferred() {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const stops: Array<() => void> = [];
function subject(fetchImpl: typeof fetch) {
  const scope = effectScope();
  const api = scope.run(() => useTasks({ autoLoad: false, fetchImpl }))!;
  stops.push(() => scope.stop());
  return { api, stop: () => scope.stop() };
}
const input = { tmdbId: 900001, title: "Example", mediaType: "movie" as const };
const flush = async () => {
  for (let index = 0; index < 10; index++) await Promise.resolve();
};
const fallback = (url: RequestInfo | URL) => {
  if (url === "/api/auth/logout") return new Response(null, { status: 204 });
  if (url === "/api/auth/login") return Response.json({ ok: true });
  if (url === "/api/tasks") return Response.json({ tasks: [] });
  throw new Error(`Unexpected request: ${url}`);
};
afterEach(() => {
  stops.splice(0).forEach((stop) => stop());
  vi.useRealTimers();
});

describe("task actions remain bound to their login identity", () => {
  it.each([401, 201])("ignores old create status %s after logout and a new login", async (status) => {
    const old = deferred();
    let signal: AbortSignal | undefined | null;
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (url === "/api/tasks" && init?.method === "POST") {
        signal = init.signal;
        return old.promise;
      }
      return fallback(url);
    });
    const { api } = subject(fetchImpl);
    const result = api.createTask(input).catch((error: Error) => error);
    await api.logout();
    expect(signal?.aborted).toBe(true);
    expect(await api.login("password")).toBe(true);
    const listCalls = fetchImpl.mock.calls.filter(([url, init]) => url === "/api/tasks" && !init?.method).length;
    old.resolve(Response.json({ created: true }, { status }));
    expect(await result).toMatchObject({ name: "AbortError" });
    await flush();
    expect(api.authRequired.value).toBe(false);
    expect(fetchImpl.mock.calls.filter(([url, init]) => url === "/api/tasks" && !init?.method)).toHaveLength(listCalls);
  });

  it("ignores a late mutation body when a new login starts without logout", async () => {
    const body = deferred();
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST" && url === "/api/tasks")
        return { ok: true, status: 201, json: () => body.promise } as unknown as Response;
      return fallback(url);
    });
    const { api } = subject(fetchImpl);
    const result = api.createTask(input).catch((error: Error) => error);
    await flush();
    expect(await api.login("password")).toBe(true);
    body.resolve(Response.json({ created: true }));
    expect(await result).toMatchObject({ name: "AbortError" });
    expect(api.authRequired.value).toBe(false);
  });

  it("handles a current action 401 and clears the visible task state", async () => {
    const { api } = subject(vi.fn().mockResolvedValue(new Response(null, { status: 401 })));
    await expect(api.deleteTask(1)).rejects.toThrow("unauthorized");
    expect(api.authRequired.value).toBe(true);
    expect(api.tasks.value).toEqual([]);
  });

  it("does not cancel a valid write when an ordinary list refresh happens", async () => {
    const pending = deferred();
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) =>
      init?.method === "POST" ? pending.promise : fallback(url),
    );
    const { api } = subject(fetchImpl);
    const result = api.createTask(input);
    await api.load(true);
    pending.resolve(Response.json({ created: true }, { status: 201 }));
    await expect(result).resolves.toEqual({ ok: true, created: true });
    expect(api.authRequired.value).toBe(false);
  });

  it("does not cancel independent concurrent writes", async () => {
    const first = deferred();
    let firstSignal: AbortSignal | null | undefined;
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (url === "/api/tasks/1/progress") {
        firstSignal = init?.signal;
        return first.promise;
      }
      if (url === "/api/tasks/2/season") return Response.json({ id: 2 });
      return fallback(url);
    });
    const { api } = subject(fetchImpl);
    const progress = api.updateTaskProgress(1, 10);
    await api.updateTaskSeason(2, 3);
    expect(firstSignal?.aborted).toBe(false);
    first.resolve(Response.json({ id: 1 }));
    await expect(progress).resolves.toEqual({ id: 1 });
  });

  it("stops pending requests and refuses new writes after scope disposal", async () => {
    const old = deferred();
    const fetchImpl = vi.fn().mockReturnValue(old.promise);
    const { api, stop } = subject(fetchImpl);
    const result = api.getTaskMapping(1).catch((error: Error) => error);
    stop();
    old.resolve(new Response(null, { status: 401 }));
    expect(await result).toMatchObject({ name: "AbortError" });
    await expect(api.createTask(input)).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(api.authRequired.value).toBe(false);
  });

  it.each([200, 422])("bounds a stalled create response body at status %s and allows retry", async (status) => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn().mockResolvedValueOnce({ ok: status === 200, status, json: () => new Promise(() => {}) });
    const { api } = subject(fetchImpl);
    const result = api.createTask(input).catch((error: Error) => error);
    await vi.advanceTimersByTimeAsync(180_000);
    expect(await result).toMatchObject({ message: expect.stringContaining("请求超时") });
    expect(fetchImpl.mock.calls[0]![1].signal.aborted).toBe(true);
    fetchImpl.mockImplementation(async (url: RequestInfo | URL, init?: RequestInit) =>
      init?.method === "POST" ? Response.json({ created: true }, { status: 201 }) : fallback(url),
    );
    await expect(api.createTask(input)).resolves.toEqual({ ok: true, created: true });
  });

  it("bounds header waits for ordinary task operations at fifteen seconds", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn().mockReturnValue(new Promise(() => {}));
    const { api } = subject(fetchImpl);
    const result = api.deleteTask(1).catch((error: Error) => error);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await result).toMatchObject({ message: expect.stringContaining("请求超时") });
    expect(fetchImpl.mock.calls[0]![1].signal.aborted).toBe(true);
  });

  it("accepts a bodyless delete and refreshes the list", async () => {
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) =>
      init?.method === "DELETE" ? new Response(null, { status: 204 }) : fallback(url),
    );
    const { api } = subject(fetchImpl);
    await expect(api.deleteTask(1)).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("keeps the server's create error and does not refresh after rejection", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(Response.json({ error: "invalid_tmdb" }, { status: 422 }));
    const { api } = subject(fetchImpl);
    await expect(api.createTask(input)).resolves.toEqual({ ok: false, error: "invalid_tmdb" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
