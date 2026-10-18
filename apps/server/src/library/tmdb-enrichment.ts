import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";

import type { AppDatabase } from "@emby-task-center/database/client";
import {
  libraryItems,
  mediaAliases,
  mediaItems,
  mediaRoots,
  mediaTasks,
  providerItems,
} from "@emby-task-center/database/schema";
import type { TmdbClient, TmdbMedia } from "../tmdb/client";
import { containsTitle, inferSourceIdentity, normalizeTitle } from "./matcher";

export interface TmdbMatchResult {
  /** 本次扫描到的未匹配组数。 */
  groups: number;
  /** 实际发起 TMDB 搜索的组数（受 limit 限制）。 */
  searched: number;
  matchedGroups: number;
  createdMediaItems: number;
  linkedLibraryItems: number;
  failedGroups: number;
}

export interface TmdbMatchOptions {
  /** 单次最多搜索多少组（默认 30，避免请求过多）。 */
  limit?: number;
}

interface UnresolvedGroup {
  key: string;
  mediaType: "movie" | "tv" | "mixed";
  title: string;
  year: number | null;
  itemIds: number[];
}

/** 已知但与 TMDB 官方中文名差异较大的冷门片源修正表（按 normalizeTitle 后匹配）。 */
const knownTmdbSeeds: Record<string, { tmdbId: number; mediaType: "movie" | "tv" }> = {
  上海武士: { tmdbId: 6038, mediaType: "movie" },
  天将雄狮: { tmdbId: 300168, mediaType: "movie" },
  龙珠z危险的两人: { tmdbId: 44251, mediaType: "movie" },
};

function seedCandidate(title: string): {
  id: number;
  mediaType: "movie" | "tv";
  title: string;
  originalTitle: string;
  releaseYear: number | null;
  overview: string;
  posterUrl: null;
  backdropUrl: null;
} | null {
  const seed = knownTmdbSeeds[normalizeTitle(title)];
  return seed
    ? {
        id: seed.tmdbId,
        mediaType: seed.mediaType,
        title,
        originalTitle: title,
        releaseYear: null,
        overview: "",
        posterUrl: null,
        backdropUrl: null,
      }
    : null;
}

/** 识别“电影-动画-123 / 更新-电视剧-456”这类分类目录被误当成片名的情况。 */
function looksLikeClassificationTitle(value: string): boolean {
  const normalized = normalizeTitle(value);
  return /^(电影|剧集|更新|动漫|综艺)-/.test(normalized) && /-[a-z0-9]+$/.test(normalized);
}

/**
 * 自动补齐未匹配 STRM 的 TMDB 元数据：
 * 按「片名 + 年份 + 目录类型」分组，搜索 TMDB 后建/复用 media_items，并关联回 library_items。
 * 只写入元数据与关联，不影响文件删除逻辑；后续孤儿清理负责回收无引用条目。
 */
export async function matchUnresolvedToTmdb(
  database: AppDatabase,
  tmdb: TmdbClient,
  options: TmdbMatchOptions = {},
): Promise<TmdbMatchResult> {
  const limit = Math.max(1, Math.min(100, options.limit ?? 30));
  const rows = database
    .select({
      id: libraryItems.id,
      sourceTitle: libraryItems.sourceTitle,
      sourceYear: libraryItems.sourceYear,
      mediaRootId: libraryItems.mediaRootId,
      relativePath: libraryItems.relativePath,
    })
    .from(libraryItems)
    .where(isNull(libraryItems.mediaItemId))
    .all();

  const rootRows = database.select({ id: mediaRoots.id, mediaType: mediaRoots.mediaType }).from(mediaRoots).all();
  const typeByRoot = new Map(rootRows.map((root) => [root.id, root.mediaType as "movie" | "tv" | "mixed"]));

  const groups = new Map<string, UnresolvedGroup>();
  for (const row of rows) {
    const mediaType = typeByRoot.get(row.mediaRootId) ?? "mixed";
    const identity = looksLikeClassificationTitle(row.sourceTitle)
      ? inferSourceIdentity(row.relativePath)
      : { title: row.sourceTitle, year: row.sourceYear };
    const title = identity.title || row.sourceTitle;
    const year = identity.year ?? row.sourceYear;
    const key = `${mediaType}|${normalizeTitle(title)}|${year ?? ""}`;
    let group = groups.get(key);
    if (!group) {
      group = { key, mediaType, title, year, itemIds: [] };
      groups.set(key, group);
    }
    group.itemIds.push(row.id);
  }

  const result: TmdbMatchResult = {
    groups: groups.size,
    searched: 0,
    matchedGroups: 0,
    createdMediaItems: 0,
    linkedLibraryItems: 0,
    failedGroups: 0,
  };

  let processed = 0;
  for (const group of groups.values()) {
    if (processed >= limit) break;
    processed += 1;
    result.searched += 1;
    try {
      const candidate = (pickCandidate(await searchVariants(group, tmdb), group) ??
        seedCandidate(group.title)) as TmdbMedia | null;
      if (!candidate) {
        result.failedGroups += 1;
        continue;
      }
      const enriched = await tmdb.details(candidate.mediaType, candidate.id).catch(() => candidate);
      const meta = enriched ?? candidate;
      const timestamp = new Date().toISOString();
      const payload = buildTmdbPayload(meta);
      let media = database
        .select()
        .from(mediaItems)
        .where(and(eq(mediaItems.mediaType, candidate.mediaType), eq(mediaItems.tmdbId, candidate.id)))
        .get();
      if (!media) {
        const inserted = database
          .insert(mediaItems)
          .values({
            tmdbId: meta.id,
            mediaType: meta.mediaType,
            title: meta.title,
            originalTitle: meta.originalTitle || null,
            releaseYear: meta.releaseYear,
            overview: meta.overview ?? "",
            posterUrl: meta.posterUrl,
            backdropUrl: meta.backdropUrl,
            genres: meta.genres ?? [],
            languages: [],
            regions: [],
            platforms: [],
            seasonCount: meta.mediaType === "tv" ? (meta.seasons?.length ?? null) : null,
            episodeCount:
              meta.mediaType === "tv"
                ? (meta.totalEpisodes ?? meta.seasons?.reduce((sum, season) => sum + season.episodeCount, 0) ?? null)
                : null,
            aliases: [],
            externalIds: {},
            tmdbPayload: payload,
            syncedAt: timestamp,
            createdAt: timestamp,
            updatedAt: timestamp,
          })
          .returning({ id: mediaItems.id })
          .get();
        media = database.select().from(mediaItems).where(eq(mediaItems.id, inserted.id)).get();
        if (!media) {
          result.failedGroups += 1;
          continue;
        }
        result.createdMediaItems += 1;
      } else if (needsMetadataRefresh(media)) {
        database
          .update(mediaItems)
          .set({
            genres: meta.genres?.length ? meta.genres : media.genres,
            overview: meta.overview || media.overview,
            posterUrl: meta.posterUrl ?? media.posterUrl,
            backdropUrl: meta.backdropUrl ?? media.backdropUrl,
            tmdbPayload: { ...media.tmdbPayload, ...payload },
            updatedAt: timestamp,
          })
          .where(eq(mediaItems.id, media.id))
          .run();
      }
      const updated = database
        .update(libraryItems)
        .set({
          mediaItemId: media.id,
          sourceTitle: group.title,
          sourceYear: group.year,
          recognitionStatus: "matched",
          confidence: 0.95,
          updatedAt: timestamp,
        })
        .where(inArray(libraryItems.id, group.itemIds))
        .run();
      result.linkedLibraryItems += updated.changes;
      result.matchedGroups += 1;
    } catch {
      result.failedGroups += 1;
    }
  }

  return result;
}

export function buildTmdbPayload(media: TmdbMedia): Record<string, unknown> {
  return {
    tmdbId: media.id,
    title: media.title,
    mediaType: media.mediaType,
    releaseYear: media.releaseYear,
    posterUrl: media.posterUrl,
    overview: media.overview,
    genres: media.genres ?? [],
    runtime: media.runtime ?? null,
    voteAverage: media.voteAverage ?? null,
    status: media.status ?? null,
    directors: media.directors ?? [],
    cast: media.cast ?? media.castAvatars?.map((entry) => entry.name) ?? [],
    trailerKey: media.trailerKey ?? null,
    budget: media.budget ?? null,
    revenue: media.revenue ?? null,
  };
}

function needsMetadataRefresh(media: { genres: string[]; tmdbPayload: Record<string, unknown> }): boolean {
  const cast = media.tmdbPayload?.cast;
  return media.genres.length === 0 || !Array.isArray(cast) || cast.length === 0;
}

export interface EnrichMetadataOptions {
  /** 单次最多补充多少条（默认 100）。 */
  limit?: number;
}

/** 给已有的 media_items 补齐 genres/cast 等 TMDB 详情（详情接口才有演员/导演/评分）。 */
export async function enrichMediaMetadata(
  database: AppDatabase,
  tmdb: TmdbClient,
  options: EnrichMetadataOptions = {},
): Promise<{ updated: number; failed: number }> {
  const limit = Math.max(1, Math.min(200, options.limit ?? 100));
  const rows = database
    .select()
    .from(mediaItems)
    .all()
    .filter((row) => row.tmdbId != null && needsMetadataRefresh(row))
    .slice(0, limit);
  let updated = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      const detail = await tmdb.details(row.mediaType, row.tmdbId!);
      database
        .update(mediaItems)
        .set({
          genres: detail.genres?.length ? detail.genres : row.genres,
          overview: detail.overview || row.overview,
          posterUrl: detail.posterUrl ?? row.posterUrl,
          backdropUrl: detail.backdropUrl ?? row.backdropUrl,
          tmdbPayload: { ...row.tmdbPayload, ...buildTmdbPayload(detail) },
          updatedAt: new Date().toISOString(),
        })
        .where(eq(mediaItems.id, row.id))
        .run();
      updated += 1;
    } catch {
      failed += 1;
    }
  }
  return { updated, failed };
}

function titleVariants(title: string, year: number | null): string[] {
  const variants = new Set<string>([title.trim()]);
  const cleaned = title
    .replace(/[【】[\]()（）]/gu, " ")
    .replace(/\s*[（(]?\s*(?:19|20)\d{2}\s*[)）]?\s*/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (cleaned && normalizeTitle(cleaned) !== normalizeTitle(title)) variants.add(cleaned);
  const parts = title
    .split(/[：:]/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length > 1) {
    if (parts[0]) variants.add(parts[0]);
    if (parts.at(-1)) variants.add(parts.at(-1)!);
  }
  if (year) variants.add(`${title} ${year}`);
  return [...variants].slice(0, 5);
}

async function searchVariants(group: UnresolvedGroup, tmdb: TmdbClient): Promise<TmdbMedia[]> {
  const merged: TmdbMedia[] = [];
  const seen = new Set<number>();
  for (const variant of titleVariants(group.title, group.year)) {
    for (const candidate of await tmdb.search(variant)) {
      if (seen.has(candidate.id)) continue;
      seen.add(candidate.id);
      merged.push(candidate);
    }
  }
  return merged;
}

const genericTitleMarkers = ["剧场版", "电影版", "特别篇", "长篇", "合集", "番外", "粤语", "国语"];

function stripTitleMarkers(value: string): string {
  let out = value;
  for (const marker of genericTitleMarkers) out = out.replaceAll(marker, "");
  return out;
}

/** 中文标题字符集合相似度：用于“大家的故事/我们的故事”这类同片不同译名。 */
function chineseCharacterSimilarity(left: string, right: string): number {
  const a = [...new Set(normalizeTitle(stripTitleMarkers(left)))].filter((char) => /[\u4e00-\u9fff]/u.test(char));
  const b = [...new Set(normalizeTitle(stripTitleMarkers(right)))].filter((char) => /[\u4e00-\u9fff]/u.test(char));
  if (!a.length || !b.length) return 0;
  const common = a.filter((char) => b.includes(char)).length;
  return common / Math.min(a.length, b.length);
}

function pickCandidate(candidates: TmdbMedia[], group: UnresolvedGroup): TmdbMedia | null {
  const allowed =
    group.mediaType === "movie"
      ? candidates.filter((candidate) => candidate.mediaType === "movie")
      : group.mediaType === "tv"
        ? candidates.filter((candidate) => candidate.mediaType === "tv")
        : candidates;
  const pool = allowed.length ? allowed : candidates;
  if (!pool.length) return null;

  const source = normalizeTitle(group.title);
  if (!source) return null;

  let best: { item: TmdbMedia; score: number } | null = null;
  for (const candidate of pool) {
    const names = [candidate.title, candidate.originalTitle ?? ""].map((name) => normalizeTitle(name)).filter(Boolean);
    const exact = names.some((name) => name === source);
    const partial = names.some((name) => containsTitle(source, name) || containsTitle(name, source));
    const similarity = chineseCharacterSimilarity(group.title, candidate.title);
    const similarEnough = similarity >= 0.6;
    if (!exact && !partial && !similarEnough) continue;

    let score = exact ? 20 : partial ? 8 : 0;
    if (similarEnough) score = Math.max(score, Math.round(similarity * 16));
    if (group.mediaType !== "mixed" && candidate.mediaType !== group.mediaType) score -= 5;
    if (group.year != null && candidate.releaseYear != null) {
      if (candidate.releaseYear === group.year) score += 30;
      else if (Math.abs(candidate.releaseYear - group.year) <= 1) score += 8;
      else score -= 40;
    }
    // 优先中文标题结果（TMDB 中文搜索结果通常更贴合用户片名）。
    if (/[\u4e00-\u9fff]/u.test(candidate.title)) score += 3;
    if (!best || score > best.score) best = { item: candidate, score };
  }

  return best && best.score >= 10 ? best.item : null;
}

export interface CleanupOptions {
  /** 单次最多清理的孤儿条目数（默认 300）。 */
  limit?: number;
}

/**
 * 清理「无文件、无任务引用」的孤立媒体条目：
 * library_items（真实 STRM 文件）与 media_tasks（任务）仍引用的一律保留。
 * STRM 被删除后，下一次扫描会移除对应 library_items，再由本函数回收 TMDB 元数据。
 */
export function cleanupOrphanMediaItems(database: AppDatabase, options: CleanupOptions = {}): number {
  const limit = Math.max(1, Math.min(1000, options.limit ?? 300));
  const referenced = new Set<number>();
  for (const row of database
    .select({ mediaItemId: libraryItems.mediaItemId })
    .from(libraryItems)
    .where(isNotNull(libraryItems.mediaItemId))
    .all()) {
    if (row.mediaItemId != null) referenced.add(row.mediaItemId);
  }
  for (const row of database
    .select({ mediaItemId: mediaTasks.mediaItemId })
    .from(mediaTasks)
    .where(isNotNull(mediaTasks.mediaItemId))
    .all()) {
    if (row.mediaItemId != null) referenced.add(row.mediaItemId);
  }

  const all = database.select({ id: mediaItems.id, updatedAt: mediaItems.updatedAt }).from(mediaItems).all();
  const orphanCutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const orphanIds = all
    .filter((item) => !referenced.has(item.id) && (item.updatedAt ?? "") < orphanCutoff)
    .map((item) => item.id)
    .slice(0, limit);
  if (!orphanIds.length) return 0;

  database.transaction((transaction) => {
    transaction.delete(mediaAliases).where(inArray(mediaAliases.itemId, orphanIds)).run();
    transaction.delete(providerItems).where(inArray(providerItems.itemId, orphanIds)).run();
    transaction.delete(mediaItems).where(inArray(mediaItems.id, orphanIds)).run();
  });
  return orphanIds.length;
}
