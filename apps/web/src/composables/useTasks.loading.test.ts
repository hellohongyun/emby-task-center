import { effectScope } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useTasks } from "./useTasks";

const task = {
  id: 1,
  tmdbId: 42,
  mediaType: "tv" as const,
  title: "Example",
  taskType: "ingest" as const,
  status: "pending" as const,
  statusMessage: null,
  airProgress: 10,
  storedProgress: 8,
  version: 1,
  createdAt: "2026-08-10T08:00:00Z",
  updatedAt: "2026-08-10T08:00:00Z",
};
const stops: Array<() => void> = [];
function subject(fetchImpl: typeof fetch) {
  const scope = effectScope();
  stops.push(() => scope.stop());
  return scope.run(() => useTasks({ fetchImpl, autoLoad: false }))!;
}
afterEach(() => {
  stops.splice(0).forEach((stop) => stop());
  vi.useRealTimers();
});

describe("task loading resilience", () => {
  it("displays rows and clears loading without waiting for posters", async () => {
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) =>
      url === "/api/tasks" ? Response.json({ tasks: [task] }) : new Promise<Response>(() => {}),
    );
    const api = subject(fetchImpl);
    await api.load();
    expect(api.tasks.value[0]?.title).toBe("Example");
    expect(api.loading.value).toBe(false);
    expect(api.authChecking.value).toBe(false);
  });

  it("does not fetch a poster already supplied by the API", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(Response.json({ tasks: [{ ...task, posterUrl: "/poster.jpg" }] }));
    const api = subject(fetchImpl);
    await api.load();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(api.tasks.value[0]?.posterUrl).toBe("/poster.jpg");
  });

  it("deduplicates posters across matching tasks and concurrent reloads", async () => {
    let resolvePoster!: (response: Response) => void;
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) =>
      url === "/api/tasks"
        ? Response.json({ tasks: [task, { ...task, id: 2 }] })
        : new Promise<Response>((resolve) => {
            resolvePoster = resolve;
          }),
    );
    const api = subject(fetchImpl);
    await api.load();
    await api.load();
    expect(fetchImpl.mock.calls.filter(([url]) => String(url).includes("/api/tmdb/"))).toHaveLength(1);
    resolvePoster(Response.json({ result: { posterUrl: "/real.jpg" } }));
    await vi.waitFor(() => expect(api.tasks.value.every((row) => row.posterUrl === "/real.jpg")).toBe(true));
  });

  it("limits poster concurrency and releases slots after an eight-second timeout", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) =>
      url === "/api/tasks"
        ? Response.json({
            tasks: Array.from({ length: 7 }, (_, index) => ({ ...task, id: index + 1, tmdbId: index + 10 })),
          })
        : new Promise<Response>(() => {}),
    );
    const api = subject(fetchImpl);
    await api.load();
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(8000);
    expect(fetchImpl).toHaveBeenCalledTimes(7);
    expect(api.tasks.value).toHaveLength(7);
    expect(api.loading.value).toBe(false);
  });

  it("does not replace a rebound task poster with an older detail response", async () => {
    let resolvePoster!: (response: Response) => void;
    let listCalls = 0;
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      if (url === "/api/tasks")
        return Response.json({ tasks: [++listCalls === 1 ? task : { ...task, tmdbId: 88, posterUrl: "/new.jpg" }] });
      return new Promise<Response>((resolve) => {
        resolvePoster = resolve;
      });
    });
    const api = subject(fetchImpl);
    await api.load();
    await api.load(true);
    resolvePoster(Response.json({ result: { posterUrl: "/old.jpg" } }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(api.tasks.value[0]?.tmdbId).toBe(88);
    expect(api.tasks.value[0]?.posterUrl).toBe("/new.jpg");
  });

  it("does not let a late list response overwrite a newer list", async () => {
    let resolveOld!: (response: Response) => void;
    const fetchImpl = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolveOld = resolve;
          }),
      )
      .mockResolvedValueOnce(Response.json({ tasks: [{ ...task, title: "Latest", posterUrl: "/real.jpg" }] }));
    const api = subject(fetchImpl);
    const old = api.load();
    await api.load();
    resolveOld(Response.json({ tasks: [task] }));
    await old;
    expect(api.tasks.value[0]?.title).toBe("Latest");
    expect(api.error.value).toBe("");
  });
});
