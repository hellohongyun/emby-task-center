import { effectScope } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EMPTY_LIBRARY_FILTERS } from "../library/filters";
import { useLibrary } from "./useLibrary";

function deferred() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const overview = (id: string) => ({ roots: [{ id, name: id, mediaType: "tv" }], summary: {}, unmatchedReport: [] });
const page = (id: string) => ({ root: { id }, works: [], page: 1 });
const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};
afterEach(() => vi.useRealTimers());

describe("useLibrary request lifecycle", () => {
  it("ignores late unauthorized pages after switching roots, but handles current unauthorized pages", async () => {
    const old = deferred();
    const requireAuth = vi.fn();
    const fetchImpl = vi
      .fn()
      .mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce(Response.json(page("movie")))
      .mockResolvedValueOnce(new Response(null, { status: 401 }));
    const library = useLibrary({ fetchImpl, requireAuth });
    const first = library.loadWorks("tv", 1, EMPTY_LIBRARY_FILTERS);
    await library.loadWorks("movie", 1, EMPTY_LIBRARY_FILTERS);
    old.resolve(new Response(null, { status: 401 }));
    await first;
    expect(requireAuth).not.toHaveBeenCalled();
    expect(library.worksPage.value?.root.id).toBe("movie");
    await library.loadWorks("movie", 2, EMPTY_LIBRARY_FILTERS);
    expect(requireAuth).toHaveBeenCalledOnce();
  });

  it("leaving and re-entering does not let an old overview clear the new pending overview", async () => {
    const old = deferred();
    const next = deferred();
    const fetchImpl = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
    const library = useLibrary({ fetchImpl });
    const first = library.loadRoots();
    expect(library.loadRoots()).toBe(first);
    library.cancelRequests();
    const second = library.loadRoots();
    await first;
    expect(library.summaryLoading.value).toBe(true);
    expect(library.loadRoots()).toBe(second);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    next.resolve(Response.json(overview("movie")));
    await second;
    old.resolve(Response.json(overview("tv")));
    await flush();
    expect(library.roots.value[0]?.id).toBe("movie");
    expect(library.summaryLoading.value).toBe(false);
    expect(library.error.value).toBe("");
  });

  it("an old scan settling after leaving cannot clear the next scan marker or succeed", async () => {
    const old = deferred();
    const next = deferred();
    const fetchImpl = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
    const library = useLibrary({ fetchImpl });
    const first = library.scan("tv");
    library.cancelRequests();
    const second = library.scan("movie");
    expect(await first).toBe(false);
    expect(library.scanningRootId.value).toBe("movie");
    old.resolve(Response.json({}));
    await flush();
    expect(library.scanningRootId.value).toBe("movie");
    next.resolve(Response.json({}));
    expect(await second).toBe(true);
    expect(library.scanningRootId.value).toBeNull();
    expect(library.error.value).toBe("");
  });

  it("closing or replacing details cancels only details and isolates late unauthorized responses", async () => {
    const detail = deferred();
    const summary = deferred();
    const requireAuth = vi.fn();
    const fetchImpl = vi
      .fn()
      .mockReturnValueOnce(detail.promise)
      .mockReturnValueOnce(summary.promise)
      .mockResolvedValueOnce(Response.json({ items: [] }));
    const library = useLibrary({ fetchImpl, requireAuth });
    const first = library.loadItems("tv", "first").catch((error: Error) => error.name);
    const overviewRequest = library.loadRoots();
    library.cancelItems();
    expect(await first).toBe("AbortError");
    expect(fetchImpl.mock.calls[0]![1].signal.aborted).toBe(true);
    expect(fetchImpl.mock.calls[1]![1].signal.aborted).toBe(false);
    await library.loadItems("tv", "next");
    detail.resolve(new Response(null, { status: 401 }));
    summary.resolve(Response.json(overview("tv")));
    await overviewRequest;
    expect(requireAuth).not.toHaveBeenCalled();
  });

  it("scope disposal aborts every request and prevents all later API calls from fetching", async () => {
    const pending = Array.from({ length: 5 }, deferred);
    const fetchImpl = vi.fn().mockImplementation(() => pending[fetchImpl.mock.calls.length - 1]!.promise);
    const requireAuth = vi.fn();
    const scope = effectScope();
    const library = scope.run(() => useLibrary({ fetchImpl, requireAuth }))!;
    const requests = [
      library.loadRoots(),
      library.loadWorks("tv", 1, EMPTY_LIBRARY_FILTERS),
      library.loadItems("tv", "work").catch((error: Error) => error.name),
      library.scan("tv"),
      library.matchUnresolved(),
    ];
    scope.stop();
    await Promise.all(requests);
    for (const call of fetchImpl.mock.calls) expect(call[1].signal.aborted).toBe(true);
    await library.loadRoots();
    await library.loadWorks("movie", 1, EMPTY_LIBRARY_FILTERS);
    await expect(library.loadItems("movie", "work")).rejects.toMatchObject({ name: "AbortError" });
    expect(await library.scan("movie")).toBe(false);
    expect(await library.matchUnresolved()).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(5);
    pending.forEach((request) => request.resolve(new Response(null, { status: 401 })));
    await flush();
    expect(requireAuth).not.toHaveBeenCalled();
    expect(library.error.value).toBe("");
    expect(library.summaryLoading.value).toBe(false);
    expect(library.loading.value).toBe(false);
    expect(library.scanningRootId.value).toBeNull();
  });

  it("keeps the existing three-minute deadline for scan and matching writes", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn().mockImplementation(() => new Promise<Response>(() => undefined));
    const library = useLibrary({ fetchImpl });
    const scan = library.scan("tv");
    const match = library.matchUnresolved();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(library.scanningRootId.value).toBe("tv");
    for (const call of fetchImpl.mock.calls) expect(call[1].signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(165_000);
    expect(await scan).toBe(false);
    expect(await match).toBeNull();
    for (const call of fetchImpl.mock.calls) expect(call[1].signal.aborted).toBe(true);
    expect(library.error.value).toContain("扫描失败");
  });
});
