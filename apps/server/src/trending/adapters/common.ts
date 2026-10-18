import { discardBody } from "../../util/http";
import type { TrendingItem, TrendingSection, TrendingSource } from "../types";

export interface AdapterContext {
  fetchImpl: typeof fetch;
  /** TMDB v3/v4 token（32 位 api_key 走 query，其余走 Bearer）。 */
  tmdbToken: string;
}

export interface TrendingAdapter {
  source: TrendingSource;
  /** 抓取该来源的全部区块（可能多个，如 douban_hot + douban_top250）。 */
  fetchSections(ctx: AdapterContext): Promise<TrendingSection[]>;
}

export async function fetchJson<T>(fetchImpl: typeof fetch, url: string, init?: RequestInit): Promise<T> {
  const response = await fetchImpl(url, {
    ...init,
    headers: { accept: "application/json", ...(init?.headers ?? {}) },
  });
  if (!response.ok) {
    discardBody(response);
    throw new Error(`trending_http_${response.status}`);
  }
  return response.json() as Promise<T>;
}

export async function fetchText(fetchImpl: typeof fetch, url: string): Promise<string> {
  const response = await fetchImpl(url, {
    headers: { accept: "text/html,*/*", "user-agent": "Mozilla/5.0" },
  });
  if (!response.ok) {
    discardBody(response);
    throw new Error(`trending_http_${response.status}`);
  }
  return response.text();
}

/** TMDB 请求：32 位 api_key 用 query，否则 Bearer（与 tmdb/client 一致）。 */
export function tmdbRequest(
  fetchImpl: typeof fetch,
  token: string,
  path: string,
  params?: Record<string, string>,
): Promise<unknown> {
  const query = new URLSearchParams(params);
  if (/^[a-f0-9]{32}$/i.test(token)) query.set("api_key", token);
  const suffix = query.size ? `?${query.toString()}` : "";
  const url = `https://api.themoviedb.org/3${path}${suffix}`;
  const headers: Record<string, string> = { accept: "application/json" };
  if (!/^[a-f0-9]{32}$/i.test(token)) headers.authorization = `Bearer ${token}`;
  return fetchJson(fetchImpl, url, { headers });
}

export function tmdbResults(payload: unknown): unknown[] {
  if (typeof payload === "object" && payload !== null && Array.isArray((payload as { results?: unknown }).results)) {
    return (payload as { results: unknown[] }).results;
  }
  return [];
}

/** 把 TMDB 一条记录归一化为 TrendingItem。 */
export function fromTmdb(value: unknown, rank: number, source: TrendingSource): TrendingItem | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const mediaType =
    record.media_type === "tv" ? "tv" : record.media_type === "movie" ? "movie" : record.release_date ? "movie" : "tv";
  const title = mediaType === "movie" ? record.title : record.name;
  if (!Number.isInteger(record.id) || typeof title !== "string" || !title.trim()) return null;
  const date = mediaType === "movie" ? record.release_date : record.first_air_date;
  const year = typeof date === "string" && /^\d{4}/.test(date) ? Number(date.slice(0, 4)) : null;
  const rating = typeof record.vote_average === "number" ? record.vote_average : null;
  return {
    id: `${source}:${record.id}`,
    title,
    originalTitle:
      typeof (mediaType === "movie" ? record.original_title : record.original_name) === "string"
        ? ((mediaType === "movie" ? record.original_title : record.original_name) as string)
        : title,
    mediaType,
    year,
    posterUrl:
      typeof record.poster_path === "string" && record.poster_path.startsWith("/")
        ? `https://image.tmdb.org/t/p/w500${record.poster_path}`
        : null,
    backdropUrl:
      typeof record.backdrop_path === "string" && record.backdrop_path.startsWith("/")
        ? `https://image.tmdb.org/t/p/w1280${record.backdrop_path}`
        : null,
    rating,
    overview: typeof record.overview === "string" && record.overview.trim() ? record.overview : null,
    rank,
    source,
    tmdbId: record.id as number,
  };
}
