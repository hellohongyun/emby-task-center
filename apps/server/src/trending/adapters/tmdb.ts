import type { TrendingItem } from "../types";
import type { AdapterContext, TrendingAdapter } from "./common";
import { fromTmdb, tmdbRequest, tmdbResults } from "./common";

/** 每页 20 条；趋势抓 3 页，热门抓 5 页（TMDB 没有固定总页数，这里取较全的规模）。 */
const TRENDING_PAGES = 3;
const HOT_PAGES = 5;

/** TMDB 官方来源：影片趋势 + 热门。最稳，作为兜底骨干源。 */
export function createTmdbAdapter(): TrendingAdapter {
  async function fetchList(
    ctx: AdapterContext,
    path: string,
    params: Record<string, string>,
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
        const item = fromTmdb(value, items.length + 1, "tmdb");
        if (item && !seen.has(item.id)) {
          seen.add(item.id);
          items.push(item);
        }
      }
      if (results.length < 20) break;
    }
    return items.map((item, index) => ({ ...item, rank: index + 1 }));
  }

  return {
    source: "tmdb",
    async fetchSections(ctx) {
      const [trendingMovie, trendingTv, hotMovie, hotTv] = await Promise.all([
        fetchList(ctx, "/trending/movie/day", {}, TRENDING_PAGES).catch(() => []),
        fetchList(ctx, "/trending/tv/day", {}, TRENDING_PAGES).catch(() => []),
        fetchList(ctx, "/movie/popular", {}, HOT_PAGES).catch(() => []),
        fetchList(ctx, "/tv/popular", {}, HOT_PAGES).catch(() => []),
      ]);
      const trending = interleave(trendingMovie, trendingTv).map((item, index) => ({ ...item, rank: index + 1 }));
      const hot = interleave(hotMovie, hotTv).map((item, index) => ({ ...item, rank: index + 1 }));
      return [
        {
          key: "tmdb_trending",
          label: "影片趋势",
          source: "tmdb",
          items: trending,
          updatedAt: Date.now(),
          stale: false,
        },
        { key: "tmdb_hot", label: "TMDB 热门", source: "tmdb", items: hot, updatedAt: Date.now(), stale: false },
      ];
    },
  };
}

/** 电影/剧集交替排布，让榜单不至于全是单一类型。 */
function interleave<T>(a: T[], b: T[]): T[] {
  const out: T[] = [];
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    if (i < a.length) out.push(a[i]);
    if (i < b.length) out.push(b[i]);
  }
  return out;
}
