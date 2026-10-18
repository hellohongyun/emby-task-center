import { and, eq, inArray, type SQL } from "drizzle-orm";
import type { MediaRow, RawLibraryRow, LibraryGroup } from "./public-library-types";
import type { AppDatabase } from "@emby-task-center/database/client";
import { libraryItems, mediaItems, mediaRoots } from "@emby-task-center/database/schema";
import type { LibraryService } from "../library/service";
import type { PublicLibraryListItem, PublicLibraryDetail } from "./public-library";
const RESOLUTIONS = ["2160p", "1080p", "720p", "480p"] as const;

function resolutionOf(tags: Iterable<string>): string | null {
  const set = new Set(tags);
  return RESOLUTIONS.find((name) => set.has(name)) ?? null;
}

function later(first: string | null, second: string): string {
  return !first || second > first ? second : first;
}

function readStringArray(payload: Record<string, unknown> | undefined, key: string): string[] {
  const value = payload?.[key];
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}
function readNumber(payload: Record<string, unknown> | undefined, key: string): number | null {
  const value = payload?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function readString(payload: Record<string, unknown> | undefined, key: string): string | null {
  const value = payload?.[key];
  return typeof value === "string" && value ? value : null;
}

function collectLibraryRows(database: AppDatabase, selection: SQL): RawLibraryRow[] {
  return database
    .select({
      id: libraryItems.id,
      mediaItemId: libraryItems.mediaItemId,
      sourceTitle: libraryItems.sourceTitle,
      sourceYear: libraryItems.sourceYear,
      tags: libraryItems.tags,
      updatedAt: libraryItems.updatedAt,
      posterPath: libraryItems.posterPath,
      containerPath: mediaRoots.containerPath,
    })
    .from(libraryItems)
    .innerJoin(mediaRoots, eq(libraryItems.mediaRootId, mediaRoots.id))
    .where(and(selection, eq(mediaRoots.enabled, true)))
    .orderBy(libraryItems.id)
    .all();
}

function collectMediaRows(database: AppDatabase, ids: number[]): MediaRow[] {
  if (!ids.length) return [];
  return database
    .select({
      id: mediaItems.id,
      mediaType: mediaItems.mediaType,
      title: mediaItems.title,
      originalTitle: mediaItems.originalTitle,
      releaseYear: mediaItems.releaseYear,
      posterUrl: mediaItems.posterUrl,
      backdropUrl: mediaItems.backdropUrl,
      overview: mediaItems.overview,
      tmdbId: mediaItems.tmdbId,
      genres: mediaItems.genres,
      languages: mediaItems.languages,
      regions: mediaItems.regions,
      platforms: mediaItems.platforms,
      seasonCount: mediaItems.seasonCount,
      episodeCount: mediaItems.episodeCount,
      aliases: mediaItems.aliases,
      tmdbPayload: mediaItems.tmdbPayload,
    })
    .from(mediaItems)
    .where(inArray(mediaItems.id, ids))
    .all();
}

export function buildGroups(
  database: AppDatabase,
  watchUrl: string | null,
  library: LibraryService | undefined,
  selection: SQL,
): LibraryGroup[] {
  const rows = collectLibraryRows(database, selection);
  const ids = [...new Set(rows.flatMap((row) => (row.mediaItemId == null ? [] : [row.mediaItemId])))];
  const mediaById = new Map(collectMediaRows(database, ids).map((row) => [row.id, row]));
  const matched = new Map<number, LibraryGroup>();
  const unresolved = new Map<string, LibraryGroup>();

  for (const row of rows) {
    const rootId = library?.rootIdForPath?.(row.containerPath) ?? null;
    const capturePoster = (group: LibraryGroup) => {
      if (row.posterPath && !group.posterPath) {
        group.posterPath = row.posterPath;
        group.rootId = rootId;
      }
    };
    if (row.mediaItemId != null) {
      const meta = mediaById.get(row.mediaItemId);
      if (!meta) continue;
      let group = matched.get(row.mediaItemId);
      if (!group) {
        group = {
          id: `mi:${meta.id}`,
          title: meta.title,
          mediaType: meta.mediaType,
          year: meta.releaseYear,
          posterUrl: publicImageUrl(meta.posterUrl),
          posterPath: null,
          rootId: null,
          tmdbId: meta.tmdbId,
          watchUrl,
          status: "matched",
          fileCount: 0,
          latestAt: null,
          tags: new Set(),
          genres: [...meta.genres],
          resolution: null,
          backdropUrl: meta.backdropUrl,
          originalTitle: meta.originalTitle,
          overview: meta.overview,
          languages: [...meta.languages],
          regions: [...meta.regions],
          platforms: [...meta.platforms],
          seasonCount: meta.seasonCount,
          episodeCount: meta.episodeCount,
          aliases: [...meta.aliases],
          cast: readStringArray(meta.tmdbPayload, "cast"),
          directors: readStringArray(meta.tmdbPayload, "directors"),
          runtime: readNumber(meta.tmdbPayload, "runtime"),
          voteAverage: readNumber(meta.tmdbPayload, "voteAverage"),
          tmdbStatus: readString(meta.tmdbPayload, "status"),
        };
        matched.set(row.mediaItemId, group);
      }
      capturePoster(group);
      group.fileCount += 1;
      group.latestAt = later(group.latestAt, row.updatedAt);
      for (const tag of row.tags) group.tags.add(tag);
      group.resolution = resolutionOf(group.tags);
      continue;
    }

    const key = `${row.sourceTitle}\u0000${row.sourceYear ?? ""}`;
    let group = unresolved.get(key);
    if (!group) {
      group = {
        id: `li:${row.sourceTitle}:${row.sourceYear ?? ""}`,
        title: row.sourceTitle || "未命名",
        mediaType: "movie",
        year: row.sourceYear,
        posterUrl: null,
        posterPath: null,
        rootId: null,
        tmdbId: null,
        watchUrl,
        status: "unresolved",
        fileCount: 0,
        latestAt: null,
        tags: new Set(),
        genres: [],
        resolution: null,
        backdropUrl: null,
        originalTitle: null,
        overview: null,
        languages: [],
        regions: [],
        platforms: [],
        seasonCount: null,
        episodeCount: null,
        aliases: [],
        cast: [],
        directors: [],
        runtime: null,
        voteAverage: null,
        tmdbStatus: null,
      };
      unresolved.set(key, group);
    }
    capturePoster(group);
    group.fileCount += 1;
    group.latestAt = later(group.latestAt, row.updatedAt);
    for (const tag of row.tags) group.tags.add(tag);
    group.resolution = resolutionOf(group.tags);
  }

  return [...matched.values(), ...unresolved.values()];
}

function publicPosterUrl(rootId: string | null, posterPath: string | null): string | null {
  if (!rootId || !posterPath) return null;
  return `/api/public/library/poster?rootId=${encodeURIComponent(rootId)}&path=${encodeURIComponent(posterPath)}`;
}

/** 外部海报统一走服务端代理（避免 image.tmdb/豆瓣/猫眼等防盗链 418 破图）。 */
function publicImageUrl(url: string | null | undefined): string | null {
  if (!url || !/^https?:\/\//i.test(url)) return url ?? null;
  // v=2：规避旧版本占位图被浏览器缓存（修复前 placeholder 会缓存 1 小时）。
  return `/api/public/image?url=${encodeURIComponent(url)}&v=2`;
}

export function toListItem(group: LibraryGroup): PublicLibraryListItem {
  return {
    id: group.id,
    title: group.title,
    mediaType: group.mediaType,
    year: group.year,
    posterUrl: publicPosterUrl(group.rootId, group.posterPath) ?? publicImageUrl(group.posterUrl),
    tmdbId: group.tmdbId,
    watchUrl: group.watchUrl,
    status: group.status,
    fileCount: group.fileCount,
    genres: group.genres,
    resolution: group.resolution,
    codecs: [...group.tags],
    backdropUrl: group.backdropUrl,
    originalTitle: group.originalTitle,
    overview: group.overview,
    languages: group.languages,
    regions: group.regions,
    platforms: group.platforms,
    seasonCount: group.seasonCount,
    episodeCount: group.episodeCount,
    latestAt: group.latestAt,
    cast: group.cast,
    directors: group.directors,
    runtime: group.runtime,
    voteAverage: group.voteAverage,
    tmdbStatus: group.tmdbStatus,
  };
}

export function toDetail(group: LibraryGroup): PublicLibraryDetail {
  return {
    ...toListItem(group),
    aliases: group.aliases,
    note: group.status === "unresolved" ? "该片源已入库，尚未匹配到 TMDB 元数据；不影响观看。" : null,
  };
}
