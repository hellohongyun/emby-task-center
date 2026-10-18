import { guardedPortalFetch, portalRefusalRevision } from "./portal-access";
import { sessionGeneration } from "./portal-session-state";
import { getCurrentScope, onScopeDispose, ref } from "vue";
import { fetchJsonWithTimeout } from "./request-timeout";

export interface PublicLibraryItem {
  id: string;
  title: string;
  mediaType: "movie" | "tv";
  year: number | null;
  posterUrl: string | null;
  tmdbId: number | null;
  watchUrl: string | null;
  status?: "matched" | "unresolved";
  fileCount?: number;
  genres?: string[];
  resolution?: string | null;
  codecs?: string[];
  backdropUrl?: string | null;
  originalTitle?: string | null;
  overview?: string | null;
  languages?: string[];
  regions?: string[];
  platforms?: string[];
  seasonCount?: number | null;
  episodeCount?: number | null;
  latestAt?: string | null;
  aliases?: string[];
  note?: string | null;
  cast?: string[];
  directors?: string[];
  runtime?: number | null;
  voteAverage?: number | null;
  tmdbStatus?: string | null;
}

export interface PublicLibraryListFilters {
  type?: "all" | "movie" | "tv";
  status?: "all" | "matched" | "unresolved";
  resolution?: string;
  codec?: string;
  genre?: string;
  actor?: string;
  year?: string;
  sort?: "latest" | "title" | "year";
  q?: string;
}

export interface PublicLibraryFacets {
  types: { all: number; movie: number; tv: number };
  statuses: { all: number; matched: number; unresolved: number };
  resolutions: string[];
  codecs: string[];
  genres: string[];
  actors: string[];
  years: number[];
}

export interface TmdbDetailSeason {
  seasonNumber: number;
  name: string | null;
  episodeCount: number;
  airDate: string | null;
}

export interface TmdbDetail {
  id: number;
  mediaType: string;
  title: string;
  originalTitle: string | null;
  releaseYear: number | null;
  releaseDate: string | null;
  overview: string;
  posterUrl: string | null;
  backdropUrl: string | null;
  runtime: number | null;
  genres: string[];
  status: string | null;
  voteAverage: number | null;
  directors: string[];
  cast: string[];
  castAvatars: string[];
  trailerKey: string | null;
  budget: number | null;
  revenue: number | null;
  totalEpisodes: number | null;
  airedEpisodes: number | null;
  seasons: TmdbDetailSeason[];
}

export interface PublicLibraryListResult {
  items: PublicLibraryItem[];
  total: number;
  limit: number;
  offset: number;
  facets?: PublicLibraryFacets;
}

async function request<T>(url: string, signal?: AbortSignal): Promise<T | null> {
  const generation = sessionGeneration();
  const refusal = portalRefusalRevision();
  const current = () => !signal?.aborted && generation === sessionGeneration() && refusal === portalRefusalRevision();
  try {
    const { response, body } = await fetchJsonWithTimeout<T>(
      (input, init) => guardedPortalFetch(input, init, () => !init?.signal?.aborted && current()),
      url,
      { credentials: "include", signal },
    );
    return current() && response.ok ? (body ?? null) : null;
  } catch {
    return null;
  }
}

function queryString(filters: PublicLibraryListFilters): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== "" && value !== "all") params.set(key, String(value));
  }
  return params.toString();
}

export function useLibraryPortal() {
  const searching = ref(false);
  const recent = ref<PublicLibraryItem[]>([]);
  const recentLoading = ref(false);
  let searchController: AbortController | undefined;
  let recentController: AbortController | undefined;
  if (getCurrentScope())
    onScopeDispose(() => {
      searchController?.abort();
      recentController?.abort();
      searching.value = false;
      recentLoading.value = false;
    });

  async function search(query: string, limit = 8): Promise<PublicLibraryItem[]> {
    searchController?.abort();
    const controller = (searchController = new AbortController());
    if (!query.trim()) {
      searching.value = false;
      return [];
    }
    searching.value = true;
    try {
      const body = await request<{ items: PublicLibraryItem[] }>(
        `/api/public/library/search?q=${encodeURIComponent(query.trim())}&limit=${limit}`,
        controller.signal,
      );
      return controller.signal.aborted ? [] : (body?.items ?? []);
    } finally {
      if (searchController === controller) searching.value = false;
    }
  }

  async function loadRecent(limit = 12): Promise<void> {
    recentController?.abort();
    const controller = (recentController = new AbortController());
    recentLoading.value = true;
    try {
      const body = await request<{ items: PublicLibraryItem[] }>(
        `/api/public/library/recent?limit=${limit}`,
        controller.signal,
      );
      if (!controller.signal.aborted && body) recent.value = body.items ?? [];
    } finally {
      if (recentController === controller) recentLoading.value = false;
    }
  }

  async function list(
    limit = 24,
    offset = 0,
    filters: PublicLibraryListFilters = {},
    signal?: AbortSignal,
  ): Promise<PublicLibraryListResult | null> {
    const qs = queryString(filters);
    return request<PublicLibraryListResult>(
      `/api/public/library/list?limit=${limit}&offset=${offset}${qs ? `&${qs}` : ""}`,
      signal,
    );
  }

  async function detail(id: string, signal?: AbortSignal): Promise<PublicLibraryItem | null> {
    return request<PublicLibraryItem>(`/api/public/library/detail?id=${encodeURIComponent(id)}`, signal);
  }

  async function tmdbDetails(
    mediaType: "movie" | "tv",
    tmdbId: number,
    signal?: AbortSignal,
  ): Promise<TmdbDetail | null> {
    const body = await request<{ result: TmdbDetail }>(
      `/api/public/tmdb/details?type=${mediaType}&id=${tmdbId}`,
      signal,
    );
    return body?.result ?? null;
  }

  return { searching, recent, recentLoading, search, loadRecent, list, detail, tmdbDetails };
}
