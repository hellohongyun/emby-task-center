import { effectScope } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useTmdbSearch } from "./useTmdbSearch";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe("TMDB request lifecycle", () => {
  afterEach(() => vi.useRealTimers());

  it.each(["search", "season"] as const)("times out a stalled %s response body and allows retry", async (kind) => {
    vi.useFakeTimers();
    const body = kind === "search" ? { results: [] } : { result: { airedEpisodes: 2, totalEpisodes: 3 } };
    const stalledBody = deferred<typeof body>();
    const signal = vi.fn();
    const fetchImpl = vi
      .fn()
      .mockImplementationOnce((_url, init: RequestInit) => {
        init.signal?.addEventListener("abort", signal);
        return Promise.resolve({ ok: true, status: 200, json: () => stalledBody.promise });
      })
      .mockResolvedValue(Response.json(body));
    const tmdb = useTmdbSearch(fetchImpl as typeof fetch);
    const call = () => (kind === "search" ? tmdb.search("片名") : tmdb.seasonProgress(1, 1));
    const failed = expect(call()).rejects.toThrow("请求超时");
    await vi.advanceTimersByTimeAsync(15_000);
    await failed;
    expect(signal).toHaveBeenCalledOnce();
    await expect(call()).resolves.toEqual(kind === "search" ? [] : body.result);
    stalledBody.resolve(body);
  });

  it.each(["search", "season"] as const)("cancels the earlier %s and ignores its late 401", async (kind) => {
    const oldResponse = deferred<Response>();
    const fetchImpl = vi
      .fn()
      .mockReturnValueOnce(oldResponse.promise)
      .mockResolvedValue(
        Response.json(kind === "search" ? { results: [] } : { result: { airedEpisodes: 2, totalEpisodes: 3 } }),
      );
    const unauthorized = vi.fn();
    const tmdb = useTmdbSearch(fetchImpl as typeof fetch, unauthorized);
    const call = () => (kind === "search" ? tmdb.search("片名") : tmdb.seasonProgress(1, 1));
    const failed = expect(call()).rejects.toMatchObject({ name: "AbortError" });
    await call();
    await failed;
    oldResponse.resolve(new Response(null, { status: 401 }));
    await Promise.resolve();
    expect(unauthorized).not.toHaveBeenCalled();
  });

  it("blank searches cancel a pending search without affecting independent season loading", async () => {
    const searchResponse = deferred<Response>();
    const seasonResponse = deferred<Response>();
    const fetchImpl = vi.fn().mockReturnValueOnce(searchResponse.promise).mockReturnValueOnce(seasonResponse.promise);
    const tmdb = useTmdbSearch(fetchImpl as typeof fetch);
    const failed = expect(tmdb.search("旧片名")).rejects.toMatchObject({ name: "AbortError" });
    const season = tmdb.seasonProgress(1, 1);
    await expect(tmdb.search(" ")).resolves.toEqual([]);
    await failed;
    seasonResponse.resolve(Response.json({ result: { airedEpisodes: 2, totalEpisodes: 3 } }));
    await expect(season).resolves.toEqual({ airedEpisodes: 2, totalEpisodes: 3 });
    searchResponse.resolve(Response.json({ results: [{ id: 1 }] }));
  });

  it("keeps search and season requests independent", async () => {
    const searchResponse = deferred<Response>();
    const seasonResponse = deferred<Response>();
    const fetchImpl = vi.fn().mockReturnValueOnce(searchResponse.promise).mockReturnValueOnce(seasonResponse.promise);
    const tmdb = useTmdbSearch(fetchImpl as typeof fetch);
    const search = tmdb.search("片名");
    const season = tmdb.seasonProgress(1, 1);
    const candidate = { id: 1, mediaType: "tv", title: "片名" };
    searchResponse.resolve(Response.json({ results: [candidate] }));
    seasonResponse.resolve(Response.json({ result: { airedEpisodes: 2, totalEpisodes: 3 } }));
    await expect(search).resolves.toEqual([candidate]);
    await expect(season).resolves.toEqual({ airedEpisodes: 2, totalEpisodes: 3 });
  });

  it("scope disposal aborts requests, prevents late auth callbacks and prevents new requests", async () => {
    const response = deferred<Response>();
    const fetchImpl = vi.fn().mockReturnValue(response.promise);
    const unauthorized = vi.fn();
    const scope = effectScope();
    const tmdb = scope.run(() => useTmdbSearch(fetchImpl as typeof fetch, unauthorized))!;
    const searchFailed = expect(tmdb.search("片名")).rejects.toMatchObject({ name: "AbortError" });
    const seasonFailed = expect(tmdb.seasonProgress(1, 1)).rejects.toMatchObject({ name: "AbortError" });
    scope.stop();
    await Promise.all([searchFailed, seasonFailed]);
    response.resolve(new Response(null, { status: 401 }));
    await Promise.resolve();
    expect(unauthorized).not.toHaveBeenCalled();
    await expect(tmdb.search("新片名")).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("explicit cancellation rejects pending bodies and still permits a new drawer search", async () => {
    const oldBody = deferred<{ results: { id: number }[] }>();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => oldBody.promise })
      .mockResolvedValue(Response.json({ results: [] }));
    const tmdb = useTmdbSearch(fetchImpl as typeof fetch);
    const failed = expect(tmdb.search("旧片名")).rejects.toMatchObject({ name: "AbortError" });
    await Promise.resolve();
    tmdb.cancel();
    await failed;
    await expect(tmdb.search("新片名")).resolves.toEqual([]);
    oldBody.resolve({ results: [{ id: 1 }] });
  });
});
