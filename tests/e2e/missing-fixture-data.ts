export const missingRoots = [
  { id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", name: "隔离剧集 A", enabled: true },
  { id: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", name: "隔离剧集 B", enabled: true },
  { id: "cccccccccccccccccccccccccccccccc", name: "隔离空库", enabled: true },
  { id: "dddddddddddddddddddddddddddddddd", name: "停用历史剧集", enabled: false },
];
export const missingShows = [
  { id: 101, tmdbId: 910001, title: "跨库独立核对剧", aired: 2 },
  { id: 102, tmdbId: 910002, title: "合并双集已齐剧", aired: 2 },
  { id: 103, tmdbId: 910003, title: "疑似编号待核对剧", aired: 41 },
];
export const missingSources = [
  { root: 0, show: 0, numbers: [1] },
  { root: 1, show: 0, numbers: [2] },
  { root: 3, show: 0, numbers: [2] },
  { root: 0, show: 1, numbers: [1], end: 2 },
  { root: 0, show: 2, numbers: Array.from({ length: 20 }, (_, index) => index + 1) },
];
export const seriesId = (root: number, show: number) => `missing-series-${root}-${show}`;
export const episodeId = (root: number, show: number, episode: number) => `missing-episode-${root}-${show}-${episode}`;
export const episodes = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    episodeNumber: index + 1,
    name: `测试分集 ${index + 1}`,
    airDate: "2020-01-01",
  }));

/** Stateful HTTP-only upstream for this fixture mode; DELETE affects no external service. */
export function createMissingFixtureHandler() {
  const deleted = new Set<string>();
  return (url: URL, method: string): { status?: number; body?: unknown } | null => {
    const path = url.pathname.replace(/^\/emby/, "");
    if (method === "DELETE" && path.startsWith("/Items/missing-series-")) {
      deleted.add(decodeURIComponent(path.slice("/Items/".length)));
      return { status: 204 };
    }
    if (method !== "GET") return null;
    if (path === "/Library/VirtualFolders")
      return {
        body: missingRoots
          .filter((root) => root.enabled)
          .map((root) => ({ ItemId: root.id, Name: root.name, CollectionType: "tvshows", Locations: [] })),
      };
    if (path === "/Items") {
      const parent = url.searchParams.get("ParentId");
      const types = url.searchParams.get("IncludeItemTypes")?.split(",") ?? [];
      const root = missingRoots.findIndex((entry) => entry.id === parent);
      let items: Array<Record<string, unknown>> = [];
      if (types.includes("Episode")) {
        const source = missingSources.find((entry) => seriesId(entry.root, entry.show) === parent);
        if (source && !deleted.has(parent!))
          items = source.numbers.map((number) => ({
            Id: episodeId(source.root, source.show, number),
            Type: "Episode",
            ParentIndexNumber: 1,
            IndexNumber: number,
            ...(source.end ? { IndexNumberEnd: source.end } : {}),
            Name: `测试分集 ${number}`,
          }));
      } else if (types.includes("Season")) {
        items = [{ Id: `${parent}-season-1`, Name: "第一季", Type: "Season", IndexNumber: 1 }];
      } else {
        items = missingSources
          .filter((entry) => missingRoots[entry.root].enabled && (root < 0 || entry.root === root))
          .filter((entry) => !deleted.has(seriesId(entry.root, entry.show)))
          .map((entry) => ({
            Id: seriesId(entry.root, entry.show),
            Name: missingShows[entry.show].title,
            Type: "Series",
            ProductionYear: 2020,
            ProviderIds: { Tmdb: String(missingShows[entry.show].tmdbId) },
            ImageTags: {},
            Genres: [],
            DateCreated: "2020-01-01T00:00:00Z",
          }));
        const ids = url.searchParams.get("Ids")?.split(",");
        const term = url.searchParams.get("SearchTerm");
        if (ids) items = items.filter((item) => ids.includes(String(item.Id)));
        if (term) items = items.filter((item) => String(item.Name).includes(term));
      }
      const start = Number(url.searchParams.get("StartIndex") ?? 0);
      const limit = Number(url.searchParams.get("Limit") ?? 100);
      return { body: { Items: items.slice(start, start + limit), TotalRecordCount: items.length } };
    }
    const tvMatch = /^\/tmdb\/3\/tv\/(\d+)(?:\/season\/(\d+))?$/.exec(path);
    const show = tvMatch && missingShows.find((entry) => entry.tmdbId === Number(tvMatch[1]));
    if (show) {
      if (tvMatch[2])
        return {
          body: {
            id: show.tmdbId,
            episodes: episodes(show.aired).map((episode) => ({
              episode_number: episode.episodeNumber,
              name: episode.name,
              air_date: episode.airDate,
            })),
          },
        };
      return {
        body: {
          id: show.tmdbId,
          name: show.title,
          original_name: show.title,
          first_air_date: "2020-01-01",
          number_of_episodes: show.aired,
          number_of_seasons: 1,
          seasons: [{ season_number: 1, episode_count: show.aired, air_date: "2020-01-01" }],
          genres: [],
          credits: { cast: [], crew: [] },
          videos: { results: [] },
        },
      };
    }
    return null;
  };
}
