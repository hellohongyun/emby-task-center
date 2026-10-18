import type { Express, Request, Response } from "express";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";

import type { AppDatabase } from "@emby-task-center/database/client";
import { libraryItems, mediaItems, mediaRoots } from "@emby-task-center/database/schema";
import type { TrendingService } from "./service";
import type { TrendingItem, TrendingResult, TrendingSource } from "./types";

export interface TrendingRouteOptions {
  service?: TrendingService;
  /** 公开媒体库数据库：用于给榜单逐条打“已在库/可看”标记。 */
  database?: AppDatabase;
  /** Emby Web 地址（如 http://emby:8096），仅用于“去观看”链接。 */
  embyBaseUrl?: string;
}

/** 公开：首页热点数据。 */
export function registerPublicTrendingRoutes(app: Express, options: TrendingRouteOptions): void {
  if (!options.service) return;
  app.get("/api/public/trending", async (request: Request, response: Response) => {
    const raw = String(request.query.sections ?? "");
    const filterKeys = raw
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    try {
      const result = await options.service!.getSections(filterKeys.length ? filterKeys : undefined);
      response.json(enrichWithLibrary(result, options.database, options.embyBaseUrl));
    } catch {
      response.status(500).json({ error: "trending_unavailable" });
    }
  });
}

const updateSourceSchema = z.strictObject({
  enabled: z.boolean().optional(),
  ttlMinutes: z
    .number()
    .int()
    .min(5)
    .max(7 * 24 * 60)
    .optional(),
  refreshMinutes: z
    .number()
    .int()
    .min(5)
    .max(7 * 24 * 60)
    .optional(),
});

/** 管理端：查看/调整热点来源配置（在登录门后注册）。 */
export function registerAdminTrendingRoutes(app: Express, options: TrendingRouteOptions): void {
  if (!options.service) return;
  app.get("/api/trending/sources", (_request: Request, response: Response) => {
    response.json({ sources: options.service!.getConfigs() });
  });

  app.put("/api/trending/sources/:source", (request: Request, response: Response) => {
    const source = request.params.source as TrendingSource;
    const parsed = updateSourceSchema.safeParse(request.body);
    if (!parsed.success) return void response.status(400).json({ error: "invalid_request" });
    const validSources: TrendingSource[] = ["tmdb", "imdb", "douban"];
    if (!validSources.includes(source)) return void response.status(404).json({ error: "not_found" });
    options.service!.updateSource(source, parsed.data);
    response.json({ ok: true, source });
  });
}

/** 给热门榜单补上“是否已在库 + 去观看链接”，并把外链海报统一走服务端代理（防 418 破图）。 */
function enrichWithLibrary(result: TrendingResult, database?: AppDatabase, embyBaseUrl?: string): TrendingResult {
  // 先把外部海报/背景图改为同源代理，避免 TMDB/豆瓣/猫眼防盗链。
  const proxiedSections = result.sections.map((section) => ({
    ...section,
    items: section.items.map((item) => ({
      ...item,
      posterUrl: proxiedImageUrl(item.posterUrl),
      backdropUrl: proxiedImageUrl(item.backdropUrl),
    })),
  }));

  if (!database || !proxiedSections.some((section) => section.items.length)) {
    return { ...result, sections: proxiedSections };
  }

  const index = buildLibraryIndex(database);
  const watchUrl = embyBaseUrl ? `${embyBaseUrl.replace(/\/+$/, "")}/web/index.html` : null;

  return {
    ...result,
    sections: proxiedSections.map((section) => ({
      ...section,
      items: section.items.map((item) => {
        const available = isItemInLibrary(item, index);
        return available ? { ...item, inLibrary: true, watchUrl } : { ...item, inLibrary: false, watchUrl: null };
      }),
    })),
  };
}

interface LibraryIndex {
  tmdbIds: Set<number>;
  doubanIds: Set<string>;
  /** 归一化片名 → 可看条目年份列表 */
  titles: Map<string, Array<{ year: number | null }>>;
}

function buildLibraryIndex(database: AppDatabase): LibraryIndex {
  const index: LibraryIndex = { tmdbIds: new Set(), doubanIds: new Set(), titles: new Map() };
  const addTitle = (title: string | null | undefined, year: number | null) => {
    const key = normalizeTitle(title ?? "");
    if (!key) return;
    const entries = index.titles.get(key) ?? [];
    entries.push({ year });
    index.titles.set(key, entries);
  };

  const matched = database
    .select({
      tmdbId: mediaItems.tmdbId,
      doubanId: mediaItems.doubanId,
      externalIds: mediaItems.externalIds,
      title: mediaItems.title,
      originalTitle: mediaItems.originalTitle,
      aliases: mediaItems.aliases,
      releaseYear: mediaItems.releaseYear,
    })
    .from(mediaItems)
    .innerJoin(libraryItems, eq(libraryItems.mediaItemId, mediaItems.id))
    .innerJoin(mediaRoots, eq(libraryItems.mediaRootId, mediaRoots.id))
    .where(eq(mediaRoots.enabled, true))
    .groupBy(mediaItems.id)
    .all();
  for (const row of matched) {
    if (row.tmdbId != null) index.tmdbIds.add(row.tmdbId);
    const douban = row.doubanId ?? row.externalIds?.douban ?? null;
    if (douban) index.doubanIds.add(douban);
    addTitle(row.title, row.releaseYear);
    addTitle(row.originalTitle, row.releaseYear);
    for (const alias of row.aliases ?? []) addTitle(alias, row.releaseYear);
  }

  // 未匹配到 TMDB 的本地 STRM：仍按文件名匹配，能看就算在库。
  const unresolved = database
    .select({
      sourceTitle: libraryItems.sourceTitle,
      sourceYear: libraryItems.sourceYear,
    })
    .from(libraryItems)
    .innerJoin(mediaRoots, eq(libraryItems.mediaRootId, mediaRoots.id))
    .where(and(eq(mediaRoots.enabled, true), isNull(libraryItems.mediaItemId)))
    .groupBy(libraryItems.sourceTitle, libraryItems.sourceYear)
    .all();
  for (const row of unresolved) addTitle(row.sourceTitle, row.sourceYear);

  return index;
}

function isItemInLibrary(item: TrendingItem, index: LibraryIndex): boolean {
  if (item.tmdbId != null && index.tmdbIds.has(item.tmdbId)) return true;
  const doubanId = doubanSubjectId(item.externalUrl);
  if (doubanId && index.doubanIds.has(doubanId)) return true;
  const titleKey = normalizeTitle(item.title);
  if (!titleKey) return false;
  const entries = index.titles.get(titleKey);
  if (!entries?.length) return false;
  return entries.some((entry) => item.year == null || entry.year == null || entry.year === item.year);
}

function doubanSubjectId(url?: string): string | null {
  if (!url) return null;
  const match = /movie\.douban\.com\/subject\/(\d+)/.exec(url);
  return match?.[1] ?? null;
}

function normalizeTitle(value: string): string {
  return value
    .toLowerCase()
    .replace(/[\s·:：、\-_（）()【】[\]'"`「」『』《》]/g, "")
    .trim();
}

/** 外链图片统一走公开代理（与公开媒体库一致；v=2 规避旧占位图被浏览器缓存）。 */
function proxiedImageUrl(url: string | null | undefined): string | null {
  if (!url || !/^https?:\/\//i.test(url)) return url ?? null;
  return `/api/public/image?url=${encodeURIComponent(url)}&v=2`;
}
