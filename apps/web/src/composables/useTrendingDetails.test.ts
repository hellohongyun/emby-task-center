import { effectScope, nextTick, ref } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/vue";

import { useTrendingDetails } from "./useTrendingDetails";
import type { TrendingItem } from "./useTrending";

const scopes: ReturnType<typeof effectScope>[] = [];
afterEach(() => {
  scopes.splice(0).forEach((scope) => scope.stop());
  vi.unstubAllGlobals();
});
const item = (id: string, tmdbId = 1): TrendingItem => ({
  id,
  title: id,
  tmdbId,
  year: 2026,
  mediaType: "tv",
  posterUrl: null,
  rating: null,
  rank: 1,
  source: "tmdb",
  inLibrary: true,
});
const json = (body: unknown) => new Response(JSON.stringify(body));
function setup() {
  const selected = ref<TrendingItem | null>(null);
  const scope = effectScope();
  scopes.push(scope);
  return { selected, details: scope.run(() => useTrendingDetails(selected))! };
}

describe("trending detail enrichment", () => {
  it("does not repeatedly fetch when a successful response has an empty overview", async () => {
    const fetcher = vi.fn().mockResolvedValue(json({ result: { overview: "", posterUrl: "/poster" } }));
    vi.stubGlobal("fetch", fetcher);
    const { selected, details } = setup();
    selected.value = item("empty");
    await waitFor(() => expect(selected.value?.posterUrl).toBe("/poster"));
    await nextTick();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(details.checkingOverview.value).toBe(false);
  });

  it("aborts old selection requests and ignores their late responses", async () => {
    let finishOld!: (response: Response) => void;
    const signals: AbortSignal[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string, init: RequestInit) => {
        signals.push(init.signal as AbortSignal);
        return url.endsWith("id=1")
          ? new Promise<Response>((resolve) => {
              finishOld = resolve;
            })
          : Promise.resolve(json({ result: { overview: "new overview" } }));
      }),
    );
    const { selected, details } = setup();
    selected.value = item("old", 1);
    await nextTick();
    selected.value = item("new", 2);
    await waitFor(() => expect(selected.value?.overview).toBe("new overview"));
    finishOld(json({ result: { overview: "old overview" } }));
    await nextTick();
    expect(signals[0]?.aborted).toBe(true);
    expect(selected.value?.id).toBe("new");
    expect(details.checkingOverview.value).toBe(false);
    selected.value = null;
    await nextTick();
    expect(details.libraryStatus.value).toBeNull();
  });

  it("checks library status while overview is still pending", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockImplementation((url: string) =>
          url.includes("/details?")
            ? new Promise(() => {})
            : Promise.resolve(json({ inLibrary: true, items: [{ watchUrl: "/watch" }] })),
        ),
    );
    const { selected, details } = setup();
    selected.value = { ...item("parallel"), inLibrary: undefined };
    await waitFor(() => expect(details.libraryStatus.value?.watchUrl).toBe("/watch"));
    expect(details.checkingOverview.value).toBe(true);
  });

  it("checks a searched TMDB ID once even when the search result has no overview", async () => {
    const fetcher = vi
      .fn()
      .mockImplementation((url: string) =>
        Promise.resolve(
          json(
            url.includes("/search?")
              ? { results: [{ tmdbId: 42, title: "searched", releaseYear: 2026, overview: "" }] }
              : { inLibrary: true, items: [{ watchUrl: "/searched-watch" }] },
          ),
        ),
      );
    vi.stubGlobal("fetch", fetcher);
    const { selected, details } = setup();
    selected.value = { ...item("searched"), tmdbId: null, inLibrary: undefined };
    await waitFor(() => expect(details.libraryStatus.value?.watchUrl).toBe("/searched-watch"));
    await nextTick();
    expect(selected.value?.tmdbId).toBe(42);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1]?.[0]).toBe("/api/public/library/status?tmdbId=42");
  });
});
