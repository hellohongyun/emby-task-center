import { portalFetch } from "./portal-access";
import { ref, watch, type Ref } from "vue";

import { fetchJsonWithTimeout } from "./request-timeout";
import type { TrendingItem } from "./useTrending";

interface Match {
  tmdbId?: number;
  title?: string;
  releaseYear?: number | null;
  overview?: string | null;
  posterUrl?: string | null;
  backdropUrl?: string | null;
}

/** Selection identity is stable when enrichment replaces the selected object's fields. */
export function useTrendingDetails(selected: Ref<TrendingItem | null>) {
  const libraryStatus = ref<{ inLibrary: boolean; watchUrl: string | null } | null>(null);
  const checkingLibrary = ref(false);
  const checkingOverview = ref(false);
  let generation = 0;

  watch(
    () => selected.value?.id,
    (_id, _oldId, onCleanup) => {
      const item = selected.value;
      const currentGeneration = ++generation;
      const controller = new AbortController();
      onCleanup(() => controller.abort());
      const current = () => generation === currentGeneration && !controller.signal.aborted;
      libraryStatus.value = null;
      checkingLibrary.value = false;
      checkingOverview.value = false;
      if (!item) return;

      async function loadOverview() {
        checkingOverview.value = true;
        try {
          let match: Match | undefined;
          const init = { credentials: "include" as const, signal: controller.signal };
          if (item!.tmdbId) {
            const { body } = await fetchJsonWithTimeout<{ result?: Match }>(
              portalFetch,
              `/api/public/tmdb/details?type=${item!.mediaType}&id=${item!.tmdbId}`,
              init,
              10_000,
            );
            match = body?.result;
          } else {
            const { body } = await fetchJsonWithTimeout<{ results?: Match[] }>(
              portalFetch,
              `/api/public/tmdb/search?q=${encodeURIComponent(item!.title)}`,
              init,
              10_000,
            );
            const normalize = (value: string) => value.trim().toLowerCase().replace(/\s+/g, " ");
            match =
              body?.results?.find(
                (entry) =>
                  normalize(entry.title ?? "") === normalize(item!.title) &&
                  (item!.year == null || entry.releaseYear == null || entry.releaseYear === item!.year),
              ) ?? body?.results?.[0];
          }
          if (match && current()) {
            selected.value = {
              ...item!,
              tmdbId: item!.tmdbId ?? match.tmdbId,
              overview: match.overview || null,
              posterUrl: item!.posterUrl ?? match.posterUrl ?? null,
              backdropUrl: item!.backdropUrl ?? match.backdropUrl ?? null,
            };
            // A search may resolve the TMDB ID only after the selection's initial status check.
            if (!item!.tmdbId && match.tmdbId && item!.inLibrary === undefined) {
              void loadLibraryStatus(match.tmdbId);
            }
          }
        } catch {
          // Details remain usable when supplementary data is unavailable.
        } finally {
          if (current()) checkingOverview.value = false;
        }
      }

      async function loadLibraryStatus(tmdbId: number) {
        checkingLibrary.value = true;
        try {
          const { body } = await fetchJsonWithTimeout<{
            inLibrary: boolean;
            items?: Array<{ watchUrl: string | null }>;
          }>(
            portalFetch,
            `/api/public/library/status?tmdbId=${tmdbId}`,
            { credentials: "include", signal: controller.signal },
            10_000,
          );
          if (body && current())
            libraryStatus.value = {
              inLibrary: body.inLibrary,
              watchUrl: body.items?.[0]?.watchUrl ?? null,
            };
        } catch {
          // Status lookup failure does not block the dialog.
        } finally {
          if (current()) checkingLibrary.value = false;
        }
      }

      if (!item.overview) void loadOverview();
      if (item.tmdbId && item.inLibrary === undefined) void loadLibraryStatus(item.tmdbId);
    },
  );

  return { libraryStatus, checkingLibrary, checkingOverview };
}
