import { registerPublicImageRoutes } from "./public-images";
import { createPublicLibraryWorkerReader } from "./public-library-worker-client";
import type { Express, Request, Response } from "express";
import { and, desc, eq, isNull, like, max, or } from "drizzle-orm";
import type { MediaType } from "@emby-task-center/contracts/media";
import type { AppDatabase } from "@emby-task-center/database/client";
import { libraryItems, mediaItems, mediaRoots } from "@emby-task-center/database/schema";
import type { LibraryService } from "../library/service";
import type { EmbyClient } from "../integrations/emby-client";

export interface PublicLibraryItem {
  id: string;
  title: string;
  mediaType: MediaType;
  year: number | null;
  posterUrl: string | null;
  tmdbId: number | null;
  watchUrl: string | null;
}

/** 媒体库完整条目：额外带识别状态与文件/集数信息（不暴露原始路径）。 */
export interface PublicLibraryListItem extends PublicLibraryItem {
  status: "matched" | "unresolved";
  fileCount: number;
  genres?: string[];
  resolution?: string | null;
  codecs?: string[];
  backdropUrl?: string | null;
  originalTitle?: string | null;
  overview?: string | null;
  languages?: string[];
  regions?: string[];
  platforms?: string[];
  seasonCount?: number | null;
  episodeCount?: number | null;
  latestAt?: string | null;
  cast?: string[];
  directors?: string[];
  runtime?: number | null;
  voteAverage?: number | null;
  tmdbStatus?: string | null;
}

/** 详情弹层信息：在列表项基础上补充别名与元数据说明。 */
export interface PublicLibraryDetail extends PublicLibraryListItem {
  aliases?: string[];
  note?: string | null;
}

/** 筛选面板元数据：类型/状态计数 + 可选画质/题材/年份。 */
export interface PublicLibraryFacets {
  types: { all: number; movie: number; tv: number };
  statuses: { all: number; matched: number; unresolved: number };
  resolutions: string[];
  codecs: string[];
  genres: string[];
  actors: string[];
  years: number[];
}

export interface PublicLibraryOptions {
  database: AppDatabase;
  /** Emby Web 地址（如 http://emby:8096），用于“去观看”链接。 */
  embyBaseUrl?: string;
  /** 库根服务：用于把 STRM 旁挂海报安全地暴露给公开页面。 */
  library?: LibraryService;
  /** Emby 客户端（可选）：用于 Emby-only 影片的海报代理。 */
  emby?: EmbyClient;
}

/** 外部海报统一走服务端代理（避免 image.tmdb/豆瓣/猫眼等防盗链 418 破图）。 */
function publicImageUrl(url: string | null | undefined): string | null {
  if (!url || !/^https?:\/\//i.test(url)) return url ?? null;
  // v=2：规避旧版本占位图被浏览器缓存（修复前 placeholder 会缓存 1 小时）。
  return `/api/public/image?url=${encodeURIComponent(url)}&v=2`;
}

export function registerPublicLibraryRoutes(app: Express, options: PublicLibraryOptions): () => Promise<void> {
  const watchBase = options.embyBaseUrl ? options.embyBaseUrl.replace(/\/+$/, "") : null;
  function watchUrl(): string | null {
    return watchBase ? `${watchBase}/web/index.html` : null;
  }

  const reader = createPublicLibraryWorkerReader(options, watchUrl());

  app.get("/api/public/library/search", (request: Request, response: Response) => {
    const query = String(request.query.q ?? "").trim();
    if (!query) return void response.status(400).json({ error: "query_required" });
    const limit = clampLimit(String(request.query.limit ?? "12"));
    const pattern = `%${escapeLike(query)}%`;

    // 已匹配的媒体条目（优先展示 TMDB 元数据）。
    const matched = options.database
      .select({
        id: mediaItems.id,
        mediaType: mediaItems.mediaType,
        title: mediaItems.title,
        originalTitle: mediaItems.originalTitle,
        releaseYear: mediaItems.releaseYear,
        posterUrl: mediaItems.posterUrl,
        tmdbId: mediaItems.tmdbId,
      })
      .from(mediaItems)
      .innerJoin(libraryItems, eq(libraryItems.mediaItemId, mediaItems.id))
      .innerJoin(mediaRoots, eq(mediaRoots.id, libraryItems.mediaRootId))
      .where(
        and(
          eq(mediaRoots.enabled, true),
          or(
            like(mediaItems.title, pattern),
            like(mediaItems.originalTitle, pattern),
            like(libraryItems.sourceTitle, pattern),
          ),
        ),
      )
      .groupBy(mediaItems.id)
      .limit(limit * 2)
      .all();

    // 未匹配库存（只有文件名信息）。
    const unresolved = options.database
      .select({
        id: libraryItems.id,
        sourceTitle: libraryItems.sourceTitle,
        sourceYear: libraryItems.sourceYear,
      })
      .from(libraryItems)
      .innerJoin(mediaRoots, eq(mediaRoots.id, libraryItems.mediaRootId))
      .where(
        and(eq(mediaRoots.enabled, true), isNull(libraryItems.mediaItemId), like(libraryItems.sourceTitle, pattern)),
      )
      .limit(limit)
      .all();

    const items: PublicLibraryItem[] = [];
    const seen = new Set<string>();
    for (const row of matched) {
      const title = row.title;
      if (!title || seen.has(`mi:${row.id}`)) continue;
      seen.add(`mi:${row.id}`);
      items.push({
        id: `mi:${row.id}`,
        title,
        mediaType: row.mediaType as MediaType,
        year: row.releaseYear,
        posterUrl: publicImageUrl(row.posterUrl),
        tmdbId: row.tmdbId,
        watchUrl: watchUrl(),
      });
    }
    for (const row of unresolved) {
      const title = row.sourceTitle;
      if (!title || seen.has(`li:${row.id}`)) continue;
      seen.add(`li:${row.id}`);
      items.push({
        id: `li:${row.id}`,
        title,
        mediaType: "movie",
        year: row.sourceYear,
        posterUrl: null,
        tmdbId: null,
        watchUrl: watchUrl(),
      });
    }
    response.json({ items: items.slice(0, limit) });
  });

  registerPublicImageRoutes(app, options.emby);

  app.get("/api/public/library/recent", (request: Request, response: Response) => {
    const limit = clampLimit(String(request.query.limit ?? "12"));

    // 按真实 STRM 文件修改时间（fileModifiedAt）排序；无文件时间时用扫描时间兜底。
    const rows = options.database
      .select({
        id: mediaItems.id,
        mediaType: mediaItems.mediaType,
        title: mediaItems.title,
        originalTitle: mediaItems.originalTitle,
        releaseYear: mediaItems.releaseYear,
        posterUrl: mediaItems.posterUrl,
        tmdbId: mediaItems.tmdbId,
        latestAt: max(libraryItems.fileModifiedAt),
      })
      .from(mediaItems)
      .innerJoin(libraryItems, eq(libraryItems.mediaItemId, mediaItems.id))
      .innerJoin(mediaRoots, eq(mediaRoots.id, libraryItems.mediaRootId))
      .where(eq(mediaRoots.enabled, true))
      .groupBy(mediaItems.id)
      .orderBy(desc(max(libraryItems.fileModifiedAt)), desc(max(libraryItems.updatedAt)))
      .limit(limit)
      .all();

    const items: PublicLibraryItem[] = rows.map((row) => ({
      id: `mi:${row.id}`,
      title: row.title,
      mediaType: row.mediaType as MediaType,
      year: row.releaseYear,
      posterUrl: publicImageUrl(row.posterUrl),
      tmdbId: row.tmdbId,
      watchUrl: watchUrl(),
    }));
    response.json({ items });
  });

  /** 媒体库完整列表：已匹配（TMDB 元数据）+ 未匹配 STRM 文件，支持筛选/排序/分页。 */
  app.get("/api/public/library/list", async (request: Request, response: Response) => {
    const limit = clampLimit(String(request.query.limit ?? "24"));
    const offset = Math.max(0, Number(request.query.offset ?? "0") || 0);
    const yearParam = Number(request.query.year);
    const hasExactYear = Number.isFinite(yearParam) && yearParam > 0;
    const yearFrom = hasExactYear ? yearParam : Number(request.query.yearFrom) || null;
    const yearTo = hasExactYear ? yearParam : Number(request.query.yearTo) || null;
    const filterOptions = {
      type: String(request.query.type ?? "all"),
      status: String(request.query.status ?? "all"),
      resolution: String(request.query.resolution ?? "all"),
      codec: String(request.query.codec ?? "").trim(),
      genre: String(request.query.genre ?? "").trim(),
      actor: String(request.query.actor ?? "").trim(),
      yearFrom,
      yearTo,
      query: String(request.query.q ?? "")
        .trim()
        .toLocaleLowerCase(),
    };
    const sort = String(request.query.sort ?? "latest");

    response.json(await reader.list(filterOptions, sort, limit, offset));
  });

  /** 单条媒体详情：弹层直接使用，不暴露任何文件路径。 */
  app.get("/api/public/library/detail", (request: Request, response: Response) => {
    const id = String(request.query.id ?? "").trim();
    if (!id) return void response.status(400).json({ error: "query_required" });

    const detail = reader.detail(id);
    if (!detail) return void response.status(404).json({ error: "library_item_not_found" });
    response.json(detail);
  });

  /** 批量查询某个 tmdbId/title 是否已在库（门户详情弹层判断“可看 / 本库暂无”）。 */
  app.get("/api/public/library/status", (request: Request, response: Response) => {
    const tmdbId = Number(request.query.tmdbId);
    const title = String(request.query.title ?? "").trim();
    const query = options.database
      .select({
        id: mediaItems.id,
        mediaType: mediaItems.mediaType,
        title: mediaItems.title,
        releaseYear: mediaItems.releaseYear,
        posterUrl: mediaItems.posterUrl,
        tmdbId: mediaItems.tmdbId,
      })
      .from(mediaItems)
      .innerJoin(libraryItems, eq(libraryItems.mediaItemId, mediaItems.id))
      .innerJoin(mediaRoots, eq(mediaRoots.id, libraryItems.mediaRootId))
      .groupBy(mediaItems.id)
      .limit(5);

    const conditions = [eq(mediaRoots.enabled, true)];
    if (Number.isInteger(tmdbId) && tmdbId > 0) conditions.push(eq(mediaItems.tmdbId, tmdbId));
    else if (title)
      conditions.push(
        or(like(mediaItems.title, `%${escapeLike(title)}%`), like(mediaItems.originalTitle, `%${escapeLike(title)}%`))!,
      );
    if (conditions.length === 1) return void response.status(400).json({ error: "query_required" });
    const rows = query.where(and(...conditions)).all();

    response.json({
      inLibrary: rows.length > 0,
      items: rows.map((row) => ({
        id: `mi:${row.id}`,
        title: row.title,
        mediaType: row.mediaType as MediaType,
        year: row.releaseYear,
        posterUrl: publicImageUrl(row.posterUrl),
        tmdbId: row.tmdbId,
        watchUrl: watchUrl(),
      })),
    });
  });
  return () => reader.close();
}

function clampLimit(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 12;
  return Math.max(1, Math.min(40, Math.floor(parsed)));
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}
