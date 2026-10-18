import { vi } from "vitest";
import { useLibrary } from "../composables/useLibrary";
import type { WorkGroupSummary } from "../library/paged-library";

export function libraryFixture(workCount = 2) {
  const roots = [
    { id: "tv", name: "剧集", mediaType: "tv" as const },
    { id: "movie", name: "电影", mediaType: "movie" as const },
  ];
  const item = {
    relativePath: "仙逆 (2023)/Season 01/仙逆 S01E158.strm",
    sourceTitle: "仙逆",
    sourceYear: 2023,
    recognitionStatus: "matched",
    identity: {
      physicalSeason: 1,
      parsedSeason: 1,
      episodeNumbers: [158],
      absoluteEpisodeNumbers: [],
      numberingMode: "seasonal" as const,
      warning: null,
    },
  };
  const works: WorkGroupSummary[] = Array.from({ length: workCount }, (_, index) => ({
    key: `work-${index}`,
    title: index === 0 ? "仙逆" : index === 1 ? "阿凡达" : `作品 ${index}`,
    year: index === 0 ? 2023 : 2009,
    isTv: index === 0,
    posterPath: null,
    tags: index === 0 ? [] : ["2160p"],
    resolution: index === 0 ? null : "2160p",
    items: [item],
    genres: ["科幻"],
    cast: [],
    addedAt: null,
    fileCount: index === 0 ? 158 : 1,
    matchedFiles: index === 0 ? 158 : 1,
    unmatchedFiles: 0,
  }));
  const summary = {
    totalFiles: workCount + 157,
    workCount,
    matchedFiles: workCount + 157,
    unmatchedFiles: 0,
    matchRatio: 100,
    posterFiles: 0,
    posterRatio: 0,
    missingGenreFiles: 0,
  };
  const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname === "/api/library/summary") return Response.json({ roots, summary, unmatchedReport: [] });
    if (url.pathname.endsWith("/works/items"))
      return Response.json({ items: [item, { ...item, relativePath: "仙逆 S01E159.strm" }] });
    if (url.pathname.endsWith("/scan")) return Response.json({ root: roots[0], discoveredCount: summary.totalFiles });
    if (url.pathname.endsWith("/works")) {
      const root = roots.find((entry) => url.pathname.includes(`/${entry.id}/`))!;
      const q = url.searchParams;
      const filtered =
        root.id !== "tv"
          ? []
          : works.filter(
              (work) =>
                (q.get("type") !== "tv" || work.isTv) &&
                (q.get("type") !== "movie" || !work.isTv) &&
                (!q.get("q") || work.title.includes(q.get("q")!)) &&
                (!q.get("resolution") || work.tags.includes(q.get("resolution")!)),
            );
      const page = Number(q.get("page") ?? 1);
      return Response.json({
        root,
        works: filtered.slice((page - 1) * 48, page * 48),
        total: filtered.length,
        page,
        pageSize: 48,
        summary,
        facets: { resolutions: ["2160p"], codecs: ["HEVC"], genres: ["科幻"], years: [2023, 2009] },
        unmatchedReport: [],
      });
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  });
  return { library: useLibrary({ fetchImpl }), fetchImpl };
}
