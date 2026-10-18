import type { TrendingItem, TrendingSection, TrendingSource } from "../types";
import type { AdapterContext, TrendingAdapter } from "./common";
import { fetchJson, fetchText } from "./common";

// 豆瓣「热映」标签近期只返回 5 条；改用「热门」标签可分页取满。
const DOUBAN_HOT_URL =
  "https://movie.douban.com/j/search_subjects?type=movie&tag=%E7%83%AD%E9%97%A8&sort=recommend&page_limit=20";
const DOUBAN_TOP_URL = "https://movie.douban.com/top250";
/** 热门取 5 页（100 部）；Top250 每页 25 部，取 10 页即完整 250 部。 */
const HOT_PAGES = 5;
const TOP_PAGES = 10;

/** 豆瓣：热门走官方 JSON 接口；Top250 解析榜单页。字段选择器需随豆瓣改版维护。 */
export function createDoubanAdapter(): TrendingAdapter {
  function hotUrl(pageIndex: number): string {
    return `${DOUBAN_HOT_URL}&page_start=${pageIndex * 20}`;
  }

  async function hot(ctx: AdapterContext): Promise<TrendingItem[]> {
    const pages = await Promise.all(
      Array.from({ length: HOT_PAGES }, (_, page) =>
        fetchJson<{ subjects?: unknown[] }>(ctx.fetchImpl, hotUrl(page))
          .then((payload) =>
            (payload.subjects ?? []).map((value, index) => normalizeSubject(value, index + 1, "douban")),
          )
          .catch(() => [] as Array<TrendingItem | null>),
      ),
    );
    const seen = new Set<string>();
    const items: TrendingItem[] = [];
    for (const pageItems of pages) {
      for (const item of pageItems) {
        if (!item || seen.has(item.id)) continue;
        seen.add(item.id);
        items.push(item);
      }
    }
    return items.map((item, index) => ({ ...item, rank: index + 1 }));
  }

  async function top(ctx: AdapterContext): Promise<TrendingItem[]> {
    const pages = await Promise.all(
      Array.from({ length: TOP_PAGES }, (_, page) =>
        fetchText(ctx.fetchImpl, `${DOUBAN_TOP_URL}?start=${page * 25}&filter=`)
          .then(parseTop250)
          .catch(() => [] as TrendingItem[]),
      ),
    );
    const seen = new Set<string>();
    const items: TrendingItem[] = [];
    for (const pageItems of pages) {
      for (const item of pageItems) {
        const key = item.externalUrl ?? item.title;
        if (seen.has(key)) continue;
        seen.add(key);
        items.push(item);
      }
    }
    // 合并分页后重新排序，并保证 id 全局唯一。
    return items.map((item, index) => ({ ...item, id: `douban:top-${index + 1}`, rank: index + 1 }));
  }

  return {
    source: "douban",
    async fetchSections(ctx) {
      const [hotItems, topItems] = await Promise.all([hot(ctx).catch(() => []), top(ctx).catch(() => [])]);
      return [
        {
          key: "douban_hot",
          label: "豆瓣热门",
          source: "douban",
          items: hotItems,
          updatedAt: Date.now(),
          stale: false,
        },
        {
          key: "douban_top250",
          label: "豆瓣 Top250",
          source: "douban",
          items: topItems,
          updatedAt: Date.now(),
          stale: false,
        },
      ] satisfies TrendingSection[];
    },
  };
}

function normalizeSubject(value: unknown, rank: number, source: TrendingSource): TrendingItem | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const title = record.title;
  if (typeof title !== "string" || !title.trim()) return null;
  const id = typeof record.id === "number" ? record.id : String(record.id ?? "");
  const rating =
    typeof record.rate === "string" ? Number(record.rate) : typeof record.rate === "number" ? record.rate : null;
  const year =
    typeof record.year === "string" ? Number(record.year) : typeof record.year === "number" ? record.year : null;
  return {
    id: `douban:${id}`,
    title,
    mediaType: "movie",
    year: Number.isFinite(year as number) ? (year as number) : null,
    posterUrl: typeof record.cover === "string" && record.cover ? record.cover : null,
    rating: Number.isFinite(rating as number) ? (rating as number) : null,
    rank,
    source,
    externalUrl: typeof record.url === "string" ? record.url : undefined,
    tmdbId: null,
  };
}

/** 解析豆瓣 Top250 页面（豆瓣改版后每个条目是 `<li> <div class="item">`，best-effort）。 */
function parseTop250(html: string): TrendingItem[] {
  const items: TrendingItem[] = [];
  const blockRe = /<li>\s*([\s\S]*?)\s*<\/li>/g;
  let block: RegExpExecArray | null;
  let rank = 1;
  while ((block = blockRe.exec(html)) !== null && items.length < 25) {
    const chunk = block[1];
    if (!chunk.includes('class="item"')) continue;
    const titleMatch = /<span\s+class="title">([^<]+)<\/span>/.exec(chunk);
    const posterMatch = /<img[^>]+src="([^"]+)"/.exec(chunk);
    const ratingMatch = /<span\s+class="rating_num"[^>]*>([^<]+)<\/span>/.exec(chunk);
    const yearMatch = /(\d{4})\s*&nbsp;\s*\/\s*&nbsp;/.exec(chunk);
    const subjectMatch = /<a\s+href="(https:\/\/movie\.douban\.com\/subject\/[^"]+)"[^>]*>/.exec(chunk);
    const title = titleMatch?.[1]?.trim();
    if (!title) continue;
    const rating = ratingMatch ? Number(ratingMatch[1]) : null;
    const year = yearMatch ? Number(yearMatch[1]) : null;
    items.push({
      id: `douban:top-${rank}`,
      title,
      mediaType: "movie",
      year: Number.isFinite(year as number) ? (year as number) : null,
      posterUrl: posterMatch?.[1] ?? null,
      rating: Number.isFinite(rating as number) ? (rating as number) : null,
      rank,
      source: "douban",
      externalUrl: subjectMatch?.[1] ?? `https://movie.douban.com/top250`,
      tmdbId: null,
    });
    rank += 1;
  }
  return items;
}
