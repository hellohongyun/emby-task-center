import { effectScope } from "vue";
import { afterEach, expect, it, vi } from "vitest";
import { useLibraryPortal } from "./useLibraryPortal";
import { resetPortalSession } from "./portal-session-state";
import { portalAccessError, portalRefusalRevision } from "./portal-access";
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
it("contains malformed JSON without rejecting callers", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("{broken")),
  );
  const library = useLibraryPortal();
  await expect(library.list()).resolves.toBeNull();
  await expect(library.loadRecent()).resolves.toBeUndefined();
  expect(library.recentLoading.value).toBe(false);
});
it("times out stalled headers and response bodies and leaves loading", async () => {
  vi.useFakeTimers();
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockResolvedValueOnce({ ok: true, json: () => new Promise(() => {}) }),
  );
  const library = useLibraryPortal();
  const headers = library.search("movie");
  await vi.advanceTimersByTimeAsync(15_000);
  await expect(headers).resolves.toEqual([]);
  expect(library.searching.value).toBe(false);
  const body = library.loadRecent();
  await vi.advanceTimersByTimeAsync(15_000);
  await body;
  expect(library.recentLoading.value).toBe(false);
});
it("ignores superseded recent results and cancels on disposal", async () => {
  let oldResolve!: (r: Response) => void;
  const fetch = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<Response>((r) => {
          oldResolve = r;
        }),
    )
    .mockResolvedValueOnce(new Response(JSON.stringify({ items: [{ id: "new" }] })))
    .mockImplementationOnce(() => new Promise(() => {}));
  vi.stubGlobal("fetch", fetch);
  const scope = effectScope();
  const library = scope.run(() => useLibraryPortal())!;
  const old = library.loadRecent();
  await library.loadRecent();
  oldResolve(new Response(JSON.stringify({ items: [{ id: "old" }] })));
  await old;
  expect(library.recent.value[0]?.id).toBe("new");
  const pending = library.search("movie");
  scope.stop();
  await pending;
  expect(fetch.mock.calls[2]?.[1]?.signal.aborted).toBe(true);
  expect(library.searching.value).toBe(false);
});

it("discards content returned after the session is reset", async () => {
  let finish!: (r: Response) => void;
  vi.stubGlobal(
    "fetch",
    vi.fn(
      () =>
        new Promise<Response>((r) => {
          finish = r;
        }),
    ),
  );
  const pending = useLibraryPortal().list();
  resetPortalSession();
  finish(new Response(JSON.stringify({ items: [{ id: "old-account" }] })));
  await expect(pending).resolves.toBeNull();
});
it("does not apply refusals from a cancelled library request", async () => {
  resetPortalSession();
  const revision = portalRefusalRevision();
  let finish!: (r: Response) => void;
  vi.stubGlobal(
    "fetch",
    vi.fn(
      () =>
        new Promise<Response>((r) => {
          finish = r;
        }),
    ),
  );
  const controller = new AbortController();
  const pending = useLibraryPortal().detail("old", controller.signal);
  controller.abort();
  finish(new Response(JSON.stringify({ error: "member_frozen" }), { status: 403 }));
  await pending;
  await Promise.resolve();
  expect(portalRefusalRevision()).toBe(revision);
  expect(portalAccessError.value).toBe("");
});
