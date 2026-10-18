import { effectScope } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useMissingEpisodes } from "./useMissingEpisodes";

function deferred<T = Response>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { resolve, promise };
}
const snapshot = (scanning = false) => ({ shows: [], scanning });
const flush = async () => {
  for (let index = 0; index < 20; index++) await Promise.resolve();
};
function subject(fetchImpl: typeof fetch, requireAuth = vi.fn()) {
  const scope = effectScope();
  const state = scope.run(() => useMissingEpisodes({ fetchImpl, requireAuth, autoLoad: false }))!;
  return { ...state, dispose: () => scope.stop(), requireAuth };
}
afterEach(() => vi.useRealTimers());

describe("missing episodes request lifecycle", () => {
  it("aborts superseded reads and ignores their late unauthorized responses", async () => {
    const old = deferred();
    const next = deferred();
    const fetchImpl = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
    const state = subject(fetchImpl);
    const first = state.load();
    const second = state.load();
    await first;
    expect(fetchImpl.mock.calls[0]![1].signal.aborted).toBe(true);
    expect(state.loading.value).toBe(true);
    next.resolve(Response.json({ ...snapshot(), generatedAt: "new" }));
    await second;
    old.resolve(new Response(null, { status: 401 }));
    await flush();
    expect(state.requireAuth).not.toHaveBeenCalled();
    expect(state.payload.value?.generatedAt).toBe("new");
    expect(state.loading.value).toBe(false);
    state.dispose();
  });

  it("does not resurrect polling when scan startup settles after scope disposal", async () => {
    vi.useFakeTimers();
    const pending = deferred();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ started: true }))
      .mockReturnValueOnce(pending.promise);
    const state = subject(fetchImpl);
    const scan = state.triggerScan();
    await flush();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    state.dispose();
    await scan;
    pending.resolve(Response.json(snapshot(true)));
    await flush();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[1]![1].signal.aborted).toBe(true);
    expect(state.payload.value).toBeNull();
    expect(state.scanStarting.value).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    await state.load();
    await state.triggerScan();
    await state.deleteShows([1], "7");
    state.startAutoRefresh();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps all polling stopped after a fast poll receives 401", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ started: true }))
      .mockResolvedValueOnce(Response.json(snapshot(true)))
      .mockResolvedValueOnce(new Response(null, { status: 401 }));
    const state = subject(fetchImpl);
    await state.triggerScan();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(state.requireAuth).toHaveBeenCalledOnce();
    expect(state.payload.value).toBeNull();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
    state.dispose();
  });

  it("disposal during an in-flight fast poll cannot restart regular refresh", async () => {
    vi.useFakeTimers();
    const pending = deferred();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ started: true }))
      .mockResolvedValueOnce(Response.json(snapshot(true)))
      .mockReturnValueOnce(pending.promise);
    const state = subject(fetchImpl);
    await state.triggerScan();
    await vi.advanceTimersByTimeAsync(5_000);
    state.dispose();
    pending.resolve(Response.json(snapshot()));
    await flush();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("an unauthorized action cancels concurrent reads and cannot reject into the view", async () => {
    vi.useFakeTimers();
    const pending = deferred();
    const fetchImpl = vi
      .fn()
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(new Response(null, { status: 401 }));
    const state = subject(fetchImpl);
    state.startAutoRefresh();
    const reading = state.load();
    expect(await state.deleteShows([1], "7")).toBeNull();
    await reading;
    expect(state.requireAuth).toHaveBeenCalledOnce();
    expect(state.loading.value).toBe(false);
    expect(state.deleting.value).toBe(false);
    pending.resolve(new Response(null, { status: 401 }));
    await flush();
    expect(state.requireAuth).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    state.dispose();
  });

  it("times out stalled response bodies and leaves the refresh retryable", async () => {
    vi.useFakeTimers();
    const body = deferred<unknown>();
    const response = { ok: true, status: 200, json: () => body.promise };
    const fetchImpl = vi.fn().mockResolvedValueOnce(response).mockResolvedValueOnce(Response.json(snapshot()));
    const state = subject(fetchImpl);
    const reading = state.load();
    await vi.advanceTimersByTimeAsync(15_000);
    await reading;
    expect(fetchImpl.mock.calls[0]![1].signal.aborted).toBe(true);
    expect(state.error.value).toContain("缺集清单暂时不可用");
    expect(state.loading.value).toBe(false);
    await state.load();
    expect(state.error.value).toBe("");
    body.resolve(snapshot(true));
    await flush();
    expect(state.payload.value?.scanning).toBe(false);
    state.dispose();
  });

  it("does not overlap automatic reads when a fast poll is slow", async () => {
    vi.useFakeTimers();
    const pending = deferred();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ started: true }))
      .mockResolvedValueOnce(Response.json(snapshot(true)))
      .mockReturnValueOnce(pending.promise);
    const state = subject(fetchImpl);
    await state.triggerScan();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    pending.resolve(Response.json(snapshot()));
    await flush();
    expect(state.payload.value?.scanning).toBe(false);
    state.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["scan", "delete"])("a late %s 401 from the old page cannot affect a new session", async (action) => {
    const pending = deferred();
    const fetchImpl = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValueOnce(Response.json(snapshot()));
    const requireAuth = vi.fn();
    const old = subject(fetchImpl, requireAuth);
    const writing = action === "scan" ? old.triggerScan() : old.deleteShows([1], "7");
    old.dispose();
    await writing;
    const current = subject(fetchImpl, requireAuth);
    await current.load();
    pending.resolve(new Response(null, { status: 401 }));
    await flush();
    expect(requireAuth).not.toHaveBeenCalled();
    expect(current.payload.value?.scanning).toBe(false);
    current.dispose();
  });
});
