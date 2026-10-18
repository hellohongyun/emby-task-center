import { effectScope } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useCardKeys, type CardRow } from "./useCardKeys";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const row = (id: number) => ({ id, status: "unused" }) as CardRow;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const list = (ids: number[]) => json(200, { cards: ids.map(row), total: ids.length, unused: ids.length, used: 0 });
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("card request lifecycle", () => {
  it("times out while the list response body is stalled", async () => {
    vi.useFakeTimers();
    const response = { ok: true, status: 200, json: () => new Promise(() => {}) } as Response;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    const c = useCardKeys();
    const pending = c.load();
    await vi.advanceTimersByTimeAsync(15_000);
    await pending;
    expect(c.loading.value).toBe(false);
    expect(c.error.value).not.toBe("");
    c.stop();
  });

  it("only the latest list owns rows, loading and unauthorized effects", async () => {
    const first = deferred<Response>();
    const second = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise));
    const auth = vi.fn();
    const c = useCardKeys(auth);
    const old = c.load();
    const latest = c.load();
    first.resolve(json(401, {}));
    await old;
    expect(auth).not.toHaveBeenCalled();
    expect(c.loading.value).toBe(true);
    second.resolve(list([2]));
    await latest;
    expect(c.cards.value.map((r) => r.id)).toEqual([2]);
    c.stop();
  });

  it("disposing cancels create without refreshing or processing its late 401", async () => {
    const response = deferred<Response>();
    const fetch = vi.fn().mockReturnValue(response.promise);
    vi.stubGlobal("fetch", fetch);
    const auth = vi.fn();
    const scope = effectScope();
    const c = scope.run(() => useCardKeys(auth))!;
    const pending = c.create({ kind: "month", count: 1 });
    scope.stop();
    expect(await pending).toEqual([]);
    response.resolve(json(401, {}));
    await flush();
    expect(auth).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
    await c.load();
    await c.remove([1]);
    await c.update({ ids: [1], name: "test" });
    await c.draftBlessing({});
    await c.testAi();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("stale AI results cannot overwrite the latest AI state", async () => {
    const first = deferred<Response>();
    const second = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise));
    const auth = vi.fn();
    const c = useCardKeys(auth);
    const old = c.draftBlessing({ occasion: "old" });
    const latest = c.testAi();
    expect(await old).toBe("");
    first.resolve(json(401, {}));
    second.resolve(json(200, { model: "test", sample: "hello" }));
    expect(await latest).toContain("hello");
    expect(auth).not.toHaveBeenCalled();
    expect(c.aiBusy.value).toBe(false);
    c.stop();
  });

  it("does not retry a timed out creation", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(() => new Promise<Response>(() => {}));
    vi.stubGlobal("fetch", fetch);
    const c = useCardKeys();
    const pending = c.create({ kind: "month", count: 1 });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await pending).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(c.busy.value).toBe(false);
    c.stop();
  });
});

describe("independent optimistic card deletion", () => {
  it.each([true, false])("restores only A when A fails and B succeeds (success first: %s)", async (successFirst) => {
    const a = deferred<Response>();
    const b = deferred<Response>();
    let initial = true;
    const fetch = vi.fn((_url: unknown, init?: RequestInit) => {
      if (init?.method === "DELETE") {
        return JSON.parse(String(init.body)).ids[0] === 1 ? a.promise : b.promise;
      }
      const response = list(initial ? [1, 2, 3] : [1, 3]);
      initial = false;
      return Promise.resolve(response);
    });
    vi.stubGlobal("fetch", fetch);
    const c = useCardKeys();
    await c.load();
    const deletingA = c.remove([1]);
    const deletingB = c.remove([2]);
    expect(c.cards.value.map((r) => r.id)).toEqual([3]);
    expect(c.loading.value).toBe(false);
    if (successFirst) {
      b.resolve(json(200, { ok: true }));
      await deletingB;
      // A is still being deleted, even though the server's refreshed list contains A.
      expect(c.cards.value.map((r) => r.id)).toEqual([3]);
      a.resolve(json(500, { error: "failed" }));
      await deletingA;
    } else {
      a.resolve(json(500, { error: "failed" }));
      await deletingA;
      expect(c.cards.value.map((r) => r.id)).toEqual([1, 3]);
      b.resolve(json(200, { ok: true }));
      await deletingB;
    }
    expect(c.cards.value.map((r) => r.id)).toEqual([1, 3]);
    expect(c.stats.value).toEqual({ total: 2, unused: 2, used: 0 });
    expect(c.deletingIds.value).toEqual([]);
    c.stop();
  });

  it("A success followed by B failure does not restore A", async () => {
    const a = deferred<Response>();
    const b = deferred<Response>();
    let initial = true;
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: unknown, init?: RequestInit) => {
        if (init?.method === "DELETE") return JSON.parse(String(init.body)).ids[0] === 1 ? a.promise : b.promise;
        const response = list(initial ? [1, 2, 3] : [2, 3]);
        initial = false;
        return Promise.resolve(response);
      }),
    );
    const c = useCardKeys();
    await c.load();
    const deletingA = c.remove([1]);
    const deletingB = c.remove([2]);
    a.resolve(json(200, {}));
    await deletingA;
    b.resolve(json(500, { error: "failed" }));
    await deletingB;
    expect(c.cards.value.map((r) => r.id)).toEqual([2, 3]);
    c.stop();
  });

  it("leaving during deletion prevents rollback, unauthorized effects and refresh", async () => {
    const deletion = deferred<Response>();
    const auth = vi.fn();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(list([1]))
      .mockReturnValueOnce(deletion.promise);
    vi.stubGlobal("fetch", fetch);
    const c = useCardKeys(auth);
    await c.load();
    const pending = c.remove([1]);
    c.stop();
    await pending;
    deletion.resolve(json(401, {}));
    await flush();
    expect(c.cards.value).toEqual([]);
    expect(auth).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
