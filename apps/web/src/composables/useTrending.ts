import { portalFetch } from "./portal-access";
import { getCurrentScope, onScopeDispose, ref } from "vue";
import { fetchJsonWithTimeout } from "./request-timeout";

export interface TrendingItem {
  id: string;
  title: string;
  originalTitle?: string;
  mediaType: "movie" | "tv";
  year: number | null;
  posterUrl: string | null;
  backdropUrl?: string | null;
  rating: number | null;
  overview?: string | null;
  rank: number;
  source: "tmdb" | "imdb" | "douban" | "emby";
  externalUrl?: string;
  tmdbId?: number | null;
  /** 服务端按 TMDB id 匹配媒体库后的“可直接观看”标记。 */
  inLibrary?: boolean;
  watchUrl?: string | null;
}

export interface TrendingSection {
  key: string;
  label: string;
  source: string;
  items: TrendingItem[];
  updatedAt: number;
  stale: boolean;
}

export interface TrendingResult {
  sections: TrendingSection[];
  updatedAt: number;
  degradedSources: string[];
  refreshing?: boolean;
}

export function useTrending() {
  const sections = ref<TrendingSection[]>([]);
  const loading = ref(false);
  const error = ref("");
  const degradedSources = ref<string[]>([]);
  const refreshing = ref(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  let generation = 0;

  function stop(): void {
    generation += 1;
    clearTimeout(timer);
    controller?.abort();
    loading.value = false;
    refreshing.value = false;
  }
  if (getCurrentScope()) onScopeDispose(stop);

  async function load(): Promise<void> {
    clearTimeout(timer);
    controller?.abort();
    controller = new AbortController();
    const current = ++generation;
    loading.value = sections.value.length === 0;
    error.value = "";
    try {
      const { response, body } = await fetchJsonWithTimeout<TrendingResult>(portalFetch, "/api/public/trending", {
        credentials: "include",
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(String(response.status));
      if (current !== generation) return;
      if (!body || !Array.isArray(body.sections)) throw new Error("invalid_response");
      sections.value = body.sections;
      degradedSources.value = body.degradedSources;
      refreshing.value = body.refreshing === true;
      if (body.refreshing) timer = setTimeout(() => void load(), 5_000);
    } catch {
      if (current === generation) {
        refreshing.value = false;
        if (!sections.value.length) error.value = "热点数据暂不可用。";
      }
    } finally {
      if (current === generation) loading.value = false;
    }
  }

  return { sections, loading, error, degradedSources, refreshing, load, stop };
}
