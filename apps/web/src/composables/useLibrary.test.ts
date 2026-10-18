import { describe, expect, it, vi } from "vitest";
import { EMPTY_LIBRARY_FILTERS } from "../library/filters";
import { useLibrary } from "./useLibrary";

const root = { id: "tv", name: "剧集", mediaType: "tv" as const };
const summary = {
  totalFiles: 10000,
  workCount: 200,
  matchedFiles: 9000,
  unmatchedFiles: 1000,
  matchRatio: 90,
  posterFiles: 8000,
  posterRatio: 80,
  missingGenreFiles: 2000,
};
const pageBody = (id = "tv", page = 1) => ({
  root: { ...root, id },
  works: [],
  total: 200,
  page,
  pageSize: 48,
  summary,
  facets: { genres: [], years: [], resolutions: [], codecs: [] },
  unmatchedReport: [],
});

describe("useLibrary paged inventory", () => {
  it("loads a small overview without requesting any inventories", async () => {
    const roots = Array.from({ length: 32 }, (_, i) => ({ ...root, id: `root-${i}` }));
    const fetchImpl = vi.fn().mockResolvedValue(Response.json({ roots, summary, unmatchedReport: [] }));
    const library = useLibrary({ fetchImpl });
    await library.loadRoots();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]![0]).toBe("/api/library/summary");
    expect(library.roots.value).toHaveLength(32);
    expect(library.overview.value?.summary.totalFiles).toBe(10000);
  });

  it("requests only the selected root and serializes filters and pagination", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(Response.json(pageBody("tv", 2)));
    const library = useLibrary({ fetchImpl });
    await library.loadWorks("tv", 2, { ...EMPTY_LIBRARY_FILTERS, query: "仙逆", type: "tv", year: "2023" });
    const url = new URL(fetchImpl.mock.calls[0]![0], "http://localhost");
    expect(url.pathname).toBe("/api/library/roots/tv/works");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      page: "2",
      pageSize: "48",
      q: "仙逆",
      type: "tv",
      year: "2023",
    });
    expect(url.searchParams.has("status")).toBe(false);
    expect(library.worksPage.value?.page).toBe(2);
  });

  it("cancels the old page and ignores its late response after switching roots", async () => {
    let resolveOld!: (response: Response) => void;
    const fetchImpl = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolveOld = resolve;
          }),
      )
      .mockResolvedValueOnce(Response.json(pageBody("movie")));
    const library = useLibrary({ fetchImpl });
    const old = library.loadWorks("tv", 1, EMPTY_LIBRARY_FILTERS);
    await library.loadWorks("movie", 1, EMPTY_LIBRARY_FILTERS);
    expect(fetchImpl.mock.calls[0]![1].signal.aborted).toBe(true);
    resolveOld(Response.json(pageBody("tv")));
    await old;
    expect(library.worksPage.value?.root.id).toBe("movie");
    expect(library.error.value).toBe("");
  });

  it("fetches full episode rows only when opening a work", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(Response.json({ items: [{ relativePath: "S01E158.strm" }] }));
    const library = useLibrary({ fetchImpl });
    const result = await library.loadItems("tv", "tv|仙逆|2023");
    const url = new URL(fetchImpl.mock.calls[0]![0], "http://localhost");
    expect(url.pathname).toBe("/api/library/roots/tv/works/items");
    expect(url.searchParams.get("key")).toBe("tv|仙逆|2023");
    expect(result.items).toHaveLength(1);
  });

  it("accepts lightweight scan results and leaves episode inventory unloaded", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(Response.json({ root, discoveredCount: 10000 }));
    const library = useLibrary({ fetchImpl });
    expect(await library.scan("tv")).toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith("/api/library/roots/tv/scan", expect.objectContaining({ method: "POST" }));
    expect(library.worksPage.value).toBeNull();
    expect(library.scanningRootId.value).toBeNull();
  });
});
