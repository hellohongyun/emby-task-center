import type { TrendingItem, TrendingSection } from "../types";
import type { AdapterContext, TrendingAdapter } from "./common";
import { fromTmdb, tmdbRequest, tmdbResults } from "./common";

/** IMDB 热门抓 5 页（100 部）；IMDB Top 抓 13 页（约 250 部，TMDB top_rated 完整榜）。 */
const HOT_PAGES = 5;
const TOP_PAGES = 13;
const TOP_LIMIT = 250;

/** IMDB 榜单：TMDB 没有 IMDB 官方 API，用 TMDB 热门/高分做代理，外链指向 IMDB 搜索。 */
export function createImdbAdapter(): TrendingAdapter {
  async function fetchList(
    ctx: AdapterContext,
    path: string,
    params: Record<string, string>,
    source: "imdb",
    pages: number,
  ): Promise<TrendingItem[]> {
    const seen = new Set<string>();
    const items: TrendingItem[] = [];
    for (let page = 1; page <= pages; page += 1) {
      const payload = await tmdbRequest(ctx.fetchImpl, ctx.tmdbToken, path, {
        language: "zh-CN",
        page: String(page),
        ...params,
      }).catch(() => null);
      if (!payload) continue;
      const results = tmdbResults(payload);
      if (!results.length) break;
      for (const value of results) {
        const item = fromTmdb(value, items.length + 1, source);
        if (!item || seen.has(item.id)) continue;
        seen.add(item.id);
        items.push({ ...item, externalUrl: `https://www.imdb.com/find?q=${encodeURIComponent(item.title)}` });
      }
      if (results.length < 20) break;
    }
    return items.map((item, index) => ({ ...item, rank: index + 1 }));
  }

  return {
    source: "imdb",
    async fetchSections(ctx) {
      const [hot, top] = await Promise.all([
        fetchList(ctx, "/movie/popular", {}, "imdb", HOT_PAGES).catch(() => []),
        fetchList(ctx, "/movie/top_rated", {}, "imdb", TOP_PAGES).catch(() => []),
      ]);
      return [
        {
          key: "imdb_hot",
          label: "IMDB 热门",
          source: "imdb",
          items: hot.slice(0, 100),
          updatedAt: Date.now(),
          stale: false,
        },
        {
          key: "imdb_top",
          label: "IMDB Top",
          source: "imdb",
          items: top.slice(0, TOP_LIMIT),
          updatedAt: Date.now(),
          stale: false,
        },
      ] satisfies TrendingSection[];
    },
  };
}
