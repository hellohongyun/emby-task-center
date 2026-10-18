import { reactive, ref } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createConcurrencyPolicyRequests } from "./concurrency-policy-requests";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function setup(fetchImpl: typeof fetch) {
  let revision = 0;
  const state = {
    draft: reactive({ enabled: true, remindAfterMinutes: 2 }),
    draftRevision: () => revision,
    loading: ref(false),
    saving: ref(false),
    message: ref(""),
  };
  const requireAuth = vi.fn();
  return {
    state,
    requireAuth,
    requests: createConcurrencyPolicyRequests(fetchImpl, state, requireAuth),
    edit: () => {
      revision += 1;
      state.draft.remindAfterMinutes = 0;
    },
  };
}
const ok = (minutes = 7) => new Response(JSON.stringify({ policy: { remindAfterMinutes: minutes } }));

describe("concurrency policy request lifecycle", () => {
  afterEach(() => vi.useRealTimers());

  it("settles a stalled GET body at 15 seconds", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(async () => ({ ok: true, json: () => new Promise(() => undefined) }) as Response);
    const { state, requests } = setup(fetchImpl);
    const pending = requests.load();
    await vi.advanceTimersByTimeAsync(15_000);
    await pending;
    expect(state.loading.value).toBe(false);
    expect(state.message.value).toContain("读取超时");
    expect((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].signal?.aborted).toBe(true);
  });

  it("uses the same deadline for a stalled save error body and never retries", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(
      async () => ({ ok: false, status: 500, json: () => new Promise(() => undefined) }) as Response,
    );
    const { state, requests } = setup(fetchImpl);
    const pending = requests.save();
    await requests.save();
    await vi.advanceTimersByTimeAsync(15_000);
    await pending;
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(state.saving.value).toBe(false);
    expect(state.message.value).toContain("确认是否已生效");
  });

  it("keeps edits when the load response arrives", async () => {
    const response = deferred<Response>();
    const { state, requests, edit } = setup(vi.fn(() => response.promise));
    const pending = requests.load();
    edit();
    response.resolve(ok());
    await pending;
    expect(state.draft.remindAfterMinutes).toBe(0);
    expect(state.loading.value).toBe(false);
  });

  it("discards an older load without accepting its late 401", async () => {
    const old = deferred<Response>();
    const current = deferred<Response>();
    const fetchImpl = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    const { state, requests, requireAuth } = setup(fetchImpl);
    const first = requests.load();
    const second = requests.load();
    old.resolve(new Response("", { status: 401 }));
    await first;
    expect(state.loading.value).toBe(true);
    current.resolve(ok());
    await second;
    expect(state.draft.remindAfterMinutes).toBe(7);
    expect(requireAuth).not.toHaveBeenCalled();
  });

  it("cancels loads for an exclusive save and retains edits made during save", async () => {
    const old = deferred<Response>();
    const saved = deferred<Response>();
    const fetchImpl = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(saved.promise);
    const { state, requests, edit } = setup(fetchImpl);
    const loading = requests.load();
    const saving = requests.save();
    await requests.save();
    await requests.load();
    edit();
    old.resolve(ok(99));
    await loading;
    expect(state.saving.value).toBe(true);
    expect(state.loading.value).toBe(false);
    saved.resolve(ok(2));
    await saving;
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body)).remindAfterMinutes).toBe(2);
    expect(state.draft.remindAfterMinutes).toBe(0);
    expect(state.message.value).toContain("已保存");
  });

  it.each(["load", "save"] as const)("aborts %s on disposal without state or auth callbacks", async (operation) => {
    const response = deferred<Response>();
    const fetchImpl = vi.fn(() => response.promise);
    const { state, requests, requireAuth } = setup(fetchImpl);
    const pending = requests[operation]();
    requests.stop();
    const message = state.message.value;
    response.resolve(new Response("", { status: 401 }));
    await pending;
    await requests.load();
    await requests.save();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(requireAuth).not.toHaveBeenCalled();
    expect(state.message.value).toBe(message);
  });

  it.each(["load", "save"] as const)("notifies auth only for a current %s 401", async (operation) => {
    const { requests, requireAuth } = setup(vi.fn(async () => new Response("", { status: 401 })));
    await requests[operation]();
    expect(requireAuth).toHaveBeenCalledTimes(1);
  });
});
