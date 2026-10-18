import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDatabase, type DatabaseHandle } from "@emby-task-center/database/client";
import { createTrendingService, type TrendingService } from "./service";
import { saveSnapshot } from "./store";
import type { TrendingSection } from "./types";
import { fetchSectionsWithDeadline } from "./refresh";

const timestamp = Date.parse("2026-01-01T00:00:00.000Z");
const snapshot: TrendingSection = {
  key: "tmdb_trending",
  label: "影片趋势",
  source: "tmdb",
  updatedAt: timestamp,
  stale: false,
  items: [
    {
      id: "tmdb:1",
      title: "旧热榜",
      mediaType: "movie",
      year: 2025,
      posterUrl: null,
      rating: 8,
      rank: 1,
      source: "tmdb",
    },
  ],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function freshResponse() {
  return new Response(JSON.stringify({ results: [{ id: 2, title: "新热榜", release_date: "2026-01-01" }] }));
}

async function promptly<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("snapshot read waited for upstream")), 200);
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}

describe("trending reads local snapshots while refreshing in background", () => {
  let directory: string;
  let database: DatabaseHandle;
  let services: TrendingService[];
  let clock: number;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "emby-trending-snapshot-first-"));
    database = createDatabase(join(directory, "app.sqlite"));
    services = [];
    clock = timestamp + 3_600_000;
  });
  afterEach(() => {
    services.forEach((service) => service.stop());
    database.close();
    rmSync(directory, { recursive: true, force: true });
    vi.useRealTimers();
  });

  function create(fetchImpl: typeof fetch, cache?: Parameters<typeof createTrendingService>[0]["cache"]) {
    const service = createTrendingService({
      database: database.db,
      tmdbToken: "test",
      fetchImpl,
      now: () => clock,
      cache,
    });
    service.updateSource("douban", { enabled: false });
    service.updateSource("imdb", { enabled: false });
    services.push(service);
    return service;
  }

  it("returns existing snapshot immediately while upstream is hung, then serves recovered data", async () => {
    saveSnapshot(database.db, snapshot);
    const gate = deferred<void>();
    const fetchImpl = vi.fn(async () => {
      await gate.promise;
      return freshResponse();
    });
    const service = create(fetchImpl);
    const result = await promptly(service.getSections(["tmdb_trending"]));
    expect(result.sections[0]?.items[0]?.title).toBe("旧热榜");
    expect(result.updatedAt).toBe(timestamp);
    expect(result.degradedSources).toEqual(["tmdb"]);
    expect(result.refreshing).toBe(true);
    gate.resolve();
    await service.refresh();
    const fresh = await service.getSections(["tmdb_trending"]);
    expect(fresh.sections[0]?.items[0]?.title).toBe("新热榜");
    expect(fresh.refreshing).toBe(false);
    expect(fresh.degradedSources).toEqual([]);
  });

  it("returns an empty degraded cold start promptly and shares one source refresh across reads", async () => {
    const gate = deferred<void>();
    const fetchImpl = vi.fn(async () => {
      await gate.promise;
      return freshResponse();
    });
    const service = create(fetchImpl);
    const results = await promptly(Promise.all(Array.from({ length: 20 }, () => service.getSections())));
    expect(results.every((result) => result.sections.length === 0 && result.updatedAt === 0 && result.refreshing)).toBe(
      true,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(4); // one adapter's four lists, not twenty adapter runs
    gate.resolve();
    await service.refresh();
    expect((await service.getSections()).sections).toHaveLength(2);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it("backs off failed refreshes across repeated reads and preserves the old fetched time", async () => {
    saveSnapshot(database.db, snapshot);
    let failing = true;
    const fetchImpl = vi.fn(async () => (failing ? new Response("failure", { status: 503 }) : freshResponse()));
    const service = create(fetchImpl);
    await service.refresh();
    const firstCalls = fetchImpl.mock.calls.length;
    const reads = await Promise.all(Array.from({ length: 20 }, () => service.getSections(["tmdb_trending"])));
    expect(reads.every((result) => result.updatedAt === timestamp && !result.refreshing)).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(firstCalls);
    clock += 29_999;
    await service.refresh();
    expect(fetchImpl).toHaveBeenCalledTimes(firstCalls);
    failing = false;
    clock += 1;
    await service.refresh();
    expect(fetchImpl.mock.calls.length).toBeGreaterThan(firstCalls);
    expect((await service.getSections()).degradedSources).toEqual([]);
  });

  it("never returns a disabled source through explicit snapshot fallback", async () => {
    saveSnapshot(database.db, snapshot);
    const fetchImpl = vi.fn(async () => freshResponse());
    const service = create(fetchImpl);
    service.updateSource("tmdb", { enabled: false });
    expect(await service.getSections(["tmdb_trending"])).toEqual({
      sections: [],
      updatedAt: 0,
      degradedSources: [],
      refreshing: false,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("discards an old refresh when its source is disabled while upstream runs", async () => {
    saveSnapshot(database.db, snapshot);
    const gate = deferred<void>();
    const service = create(async () => {
      await gate.promise;
      return freshResponse();
    });
    await service.getSections();
    const pending = service.refresh();
    service.updateSource("tmdb", { enabled: false });
    gate.resolve();
    await pending;
    expect((await service.getSections()).sections).toEqual([]);
    service.updateSource("tmdb", { enabled: true });
    expect((await service.getSections(["tmdb_trending"])).sections[0]?.items[0]?.title).toBe("旧热榜");
  });

  it("does not wait for unavailable Redis reads or writes", async () => {
    saveSnapshot(database.db, snapshot);
    const cache = { get: vi.fn(() => new Promise<null>(() => {})), set: vi.fn(() => new Promise<void>(() => {})) };
    const service = create(async () => freshResponse(), cache);
    expect((await promptly(service.getSections())).sections[0]?.items[0]?.title).toBe("旧热榜");
    await promptly(service.refresh());
    expect((await promptly(service.getSections())).sections[0]?.items[0]?.title).toBe("新热榜");
    expect(cache.get).not.toHaveBeenCalled();
  });

  it("does not repeatedly refresh a partially empty source after a successful batch", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) =>
      String(input).includes("/trending/") ? freshResponse() : new Response('{"results":[]}'),
    );
    const service = create(fetchImpl);
    await service.refresh();
    const calls = fetchImpl.mock.calls.length;
    await Promise.all(Array.from({ length: 20 }, () => service.getSections()));
    expect(fetchImpl).toHaveBeenCalledTimes(calls);
    expect((await service.getSections()).degradedSources).toEqual(["tmdb"]);
  });

  it("bounds a source refresh even if the transport ignores abort", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | null | undefined;
    const refresh = fetchSectionsWithDeadline(
      {
        source: "tmdb",
        fetchSections: async (context) => {
          await context.fetchImpl("https://example.test");
          return [];
        },
      },
      {
        tmdbToken: "test",
        fetchImpl: async (_, init) => {
          signal = init?.signal;
          return new Promise<Response>(() => {});
        },
      },
      100,
    );
    const assertion = expect(refresh).rejects.toThrow("trending_refresh_timeout");
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
    expect(signal?.aborted).toBe(true);
  });
});
