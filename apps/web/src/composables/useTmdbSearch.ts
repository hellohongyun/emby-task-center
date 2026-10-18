import { getCurrentScope, onScopeDispose } from "vue";
import type { TmdbMedia } from "../types";
import { fetchJsonWithTimeout } from "./request-timeout";

export function useTmdbSearch(fetchImpl: typeof fetch = fetch, onUnauthorized: () => void = () => {}) {
  const requests = new Map<string, AbortController>();
  let stopped = false;
  function cancel() {
    for (const controller of requests.values()) controller.abort();
    requests.clear();
  }
  if (getCurrentScope())
    onScopeDispose(() => {
      stopped = true;
      cancel();
    });

  function begin(key: string) {
    if (stopped) throw new DOMException("Request aborted", "AbortError");
    requests.get(key)?.abort();
    const controller = new AbortController();
    requests.set(key, controller);
    return controller;
  }

  async function request<T>(key: string, url: string, controller: AbortController, failure: string): Promise<T> {
    const active = () => !stopped && requests.get(key) === controller && !controller.signal.aborted;
    try {
      const { response, body } = await fetchJsonWithTimeout<T>(fetchImpl, url, {
        credentials: "include",
        signal: controller.signal,
      }).catch((caught: unknown) => {
        if (active() && (caught as Error)?.name === "AbortError") {
          throw Object.assign(new Error("请求超时，请稍后重试。"), { cause: caught });
        }
        throw caught;
      });
      if (!active()) throw new DOMException("Request aborted", "AbortError");
      if (response.status === 401) {
        onUnauthorized();
        throw new Error("unauthorized");
      }
      if (!response.ok) throw new Error(failure);
      return body as T;
    } finally {
      if (requests.get(key) === controller) requests.delete(key);
    }
  }

  async function search(query: string): Promise<TmdbMedia[]> {
    const controller = begin("search");
    const normalized = query.trim();
    if (!normalized) {
      requests.delete("search");
      return [];
    }
    const params = new URLSearchParams({ q: normalized });
    const body = await request<{ results?: TmdbMedia[] }>(
      "search",
      `/api/tmdb/search?${params}`,
      controller,
      "TMDB search failed",
    );
    if (!Array.isArray(body?.results)) throw new Error("invalid TMDB response");
    return body.results;
  }

  async function seasonProgress(
    tvId: number,
    seasonNumber: number,
  ): Promise<{ airedEpisodes: number; totalEpisodes: number }> {
    const controller = begin("season");
    const body = await request<{ result?: { airedEpisodes?: number; totalEpisodes?: number } }>(
      "season",
      `/api/tmdb/tv/${tvId}/season/${seasonNumber}`,
      controller,
      "TMDB season request failed",
    );
    if (!body?.result || typeof body.result.airedEpisodes !== "number" || typeof body.result.totalEpisodes !== "number")
      throw new Error("invalid TMDB season response");
    return { airedEpisodes: body.result.airedEpisodes, totalEpisodes: body.result.totalEpisodes };
  }

  return { search, seasonProgress, cancel };
}
