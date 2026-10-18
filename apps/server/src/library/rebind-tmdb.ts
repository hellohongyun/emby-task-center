/**
 * 改绑 TMDB 条目（任务看板「改绑 TMDB」）。
 *
 * 为什么需要它：任务的 TMDB 身份只在建任务时写一次，选错条目（同名剧、年份不同、手滑）
 * 会让"已播/缺集"整套数字都错。这里提供一条可逆的手动修复路径：重新选一条 TMDB 条目
 * （或直接手填 TMDB id），把任务、库内片源关联、别名、提供方索引一起改指过去，并按新条目重建分季。
 *
 * 两条路径：
 *  - 目标条目**还不存在** → 就地更新当前 media_items 行（id 不变，最省事）；
 *  - 目标条目**已存在**（另一条任务/库内条目已在用）→ 合并到那一条：迁移全部引用后回收旧行，
 *    避免 media_items (media_type, tmdb_id) 唯一键冲突，也避免同一部剧在库里出现两条。
 *
 * 改绑不动 Emby：库内片源会在下一轮媒体库扫描时按 Emby 登记的 TMDB id 自然重链（见 library/service.ts）。
 */
import { and, eq } from "drizzle-orm";

import type { AppDatabase } from "@emby-task-center/database/client";
import {
  libraryItems,
  mediaAliases,
  mediaItems,
  mediaTasks,
  missingEpisodeSnapshots,
  providerItems,
  taskSeasons,
} from "@emby-task-center/database/schema";
import { updateTaskAirProgress } from "@emby-task-center/task-domain/task-service";

import type { TmdbClient, TmdbMedia, TmdbMediaType } from "../tmdb/client";
import { buildTmdbPayload } from "./tmdb-enrichment";

export interface RebindTmdbOptions {
  /** 要改绑的媒体条目（任务看板从任务反查得到）。 */
  mediaItemId: number;
  tmdbId: number;
  /** 期望的类型；不传沿用当前条目的类型（两类都试过还没命中才判定失败）。 */
  mediaType?: TmdbMediaType | undefined;
  /** TMDB 查不到时的兜底标题（手填 id 的场景）。 */
  title?: string | undefined;
  /** 「今日更新」宽限期（小时）：重建分季进度时与已播刷新同一口径。 */
  graceHours: number;
}

export type RebindTmdbFailure = "media_item_not_found" | "tmdb_not_found";

export interface RebindTmdbResult {
  ok: boolean;
  error?: RebindTmdbFailure;
  /** 改绑后任务与片源指向的条目（发生过合并时是"已存在的那一条"）。 */
  mediaItemId: number | null;
  /** 被合并回收的旧条目 Id（就地改绑时为 null）。 */
  mergedFrom: number | null;
  /** 分季被重建的任务 Id。 */
  taskIds: number[];
  title: string | null;
  tmdbId: number | null;
  /** TMDB 元数据是否真的取到了（false = 只改了 id，标题用了兜底值，元数据等下次同步补齐）。 */
  metadataSynced: boolean;
}

function failure(error: RebindTmdbFailure): RebindTmdbResult {
  return {
    ok: false,
    error,
    mediaItemId: null,
    mergedFrom: null,
    taskIds: [],
    title: null,
    tmdbId: null,
    metadataSynced: false,
  };
}

/** 别名取并集：合并两条目时两边的别名都不能丢。 */
function mergeAliases(left: readonly string[], right: readonly string[]): string[] {
  return [...new Set([...left, ...right].map((alias) => alias.trim()).filter(Boolean))];
}

export async function rebindMediaItemTmdb(
  database: AppDatabase,
  tmdb: TmdbClient,
  options: RebindTmdbOptions,
): Promise<RebindTmdbResult> {
  const current = database.select().from(mediaItems).where(eq(mediaItems.id, options.mediaItemId)).get();
  if (!current) return failure("media_item_not_found");
  if (!Number.isInteger(options.tmdbId) || options.tmdbId <= 0) return failure("tmdb_not_found");

  // 类型顺序：调用方指定的（或当前的）先试，再试另一种——现实里"选错了类型"也是要修的错。
  const firstType: TmdbMediaType = options.mediaType ?? current.mediaType;
  let meta: TmdbMedia | null = null;
  for (const type of [firstType, firstType === "tv" ? "movie" : "tv"] as TmdbMediaType[]) {
    try {
      meta = await tmdb.details(type, options.tmdbId);
      break;
    } catch {
      meta = null;
    }
  }
  const metadataSynced = meta !== null;
  const fallbackTitle = options.title?.trim();
  if (!meta) {
    // TMDB 不可用/该 id 不存在：允许"只改 id"（前端手填标题兜底），元数据等下次同步补齐。
    if (!fallbackTitle) return failure("tmdb_not_found");
    meta = {
      id: options.tmdbId,
      mediaType: firstType,
      title: fallbackTitle,
      originalTitle: fallbackTitle,
      releaseYear: current.releaseYear,
      overview: current.overview ?? "",
      posterUrl: current.posterUrl,
      backdropUrl: current.backdropUrl,
    };
  }

  const timestamp = new Date().toISOString();
  const target = database
    .select()
    .from(mediaItems)
    .where(and(eq(mediaItems.mediaType, meta.mediaType), eq(mediaItems.tmdbId, meta.id)))
    .get();

  const values = {
    tmdbId: meta.id,
    mediaType: meta.mediaType,
    title: meta.title,
    originalTitle: meta.originalTitle || null,
    releaseYear: meta.releaseYear,
    overview: meta.overview ?? "",
    posterUrl: meta.posterUrl,
    backdropUrl: meta.backdropUrl,
    genres: meta.genres ?? [],
    seasonCount: meta.mediaType === "tv" ? (meta.seasons?.length ?? null) : null,
    episodeCount:
      meta.mediaType === "tv"
        ? (meta.totalEpisodes ?? meta.seasons?.reduce((sum, season) => sum + season.episodeCount, 0) ?? null)
        : null,
    tmdbPayload: metadataSynced
      ? buildTmdbPayload(meta)
      : { ...current.tmdbPayload, tmdbId: meta.id, title: meta.title, mediaType: meta.mediaType },
    syncedAt: metadataSynced ? timestamp : current.syncedAt,
    updatedAt: timestamp,
  };

  let targetId: number;
  let mergedFrom: number | null = null;
  if (target && target.id !== current.id) {
    targetId = target.id;
    mergedFrom = current.id;
    database.transaction((tx) => {
      tx.update(mediaItems)
        .set({ ...values, aliases: mergeAliases(target.aliases, current.aliases) })
        .where(eq(mediaItems.id, target.id))
        .run();
      // 任务、库内片源、提供方索引全部改指到保留的那一条。
      tx.update(mediaTasks)
        .set({ mediaItemId: target.id, updatedAt: timestamp })
        .where(eq(mediaTasks.mediaItemId, current.id))
        .run();
      tx.update(libraryItems)
        .set({ mediaItemId: target.id, updatedAt: timestamp })
        .where(eq(libraryItems.mediaItemId, current.id))
        .run();
      tx.update(providerItems)
        .set({ itemId: target.id, updatedAt: timestamp })
        .where(eq(providerItems.itemId, current.id))
        .run();
      // 别名有 (item_id, name) 唯一索引：目标已同名的直接丢掉旧行，其余改指。
      const targetNames = new Set(
        tx
          .select({ name: mediaAliases.name })
          .from(mediaAliases)
          .where(eq(mediaAliases.itemId, target.id))
          .all()
          .map((row) => row.name),
      );
      for (const alias of tx.select().from(mediaAliases).where(eq(mediaAliases.itemId, current.id)).all()) {
        if (targetNames.has(alias.name)) tx.delete(mediaAliases).where(eq(mediaAliases.id, alias.id)).run();
        else tx.update(mediaAliases).set({ itemId: target.id }).where(eq(mediaAliases.id, alias.id)).run();
      }
      // 旧条目的缺集快照随条目一起回收，不留悬空行（外键指向 media_items）。
      tx.delete(missingEpisodeSnapshots).where(eq(missingEpisodeSnapshots.mediaItemId, current.id)).run();
      tx.delete(mediaItems).where(eq(mediaItems.id, current.id)).run();
    });
  } else {
    targetId = current.id;
    database.update(mediaItems).set(values).where(eq(mediaItems.id, current.id)).run();
  }

  // 分季行的依据整个换了：按新条目重建（旧行留着只会让已播/缺集继续按错的剧算）。
  const taskIds = database
    .select({ id: mediaTasks.id })
    .from(mediaTasks)
    .where(eq(mediaTasks.mediaItemId, targetId))
    .all()
    .map((row) => row.id);
  for (const taskId of taskIds) {
    await rebuildTaskSeasons(database, tmdb, taskId, meta, options.graceHours, timestamp);
  }
  // 快照是按旧 TMDB 算的，直接作废：任务看板是实时算的（立刻正确），缺集总览等下一轮全库检测。
  database.delete(missingEpisodeSnapshots).where(eq(missingEpisodeSnapshots.mediaItemId, targetId)).run();

  return {
    ok: true,
    mediaItemId: targetId,
    mergedFrom,
    taskIds,
    title: meta.title,
    tmdbId: meta.id,
    metadataSynced,
  };
}

/**
 * 按新 TMDB 条目重建某个任务的分季行（先删后建）。
 *
 * 分季行只有"季号 + 已播/今日更新集数"，重建成本很低；保留旧行反而会让看板继续用错剧的进度。
 * 拿不到分季时退回一条 season 0 整剧聚合行（与已播刷新的兜底口径一致）。
 */
async function rebuildTaskSeasons(
  database: AppDatabase,
  tmdb: TmdbClient,
  taskId: number,
  meta: TmdbMedia,
  graceHours: number,
  timestamp: string,
): Promise<void> {
  database.delete(taskSeasons).where(eq(taskSeasons.taskId, taskId)).run();
  const insertSeason = (seasonNumber: number, airedEpisodes: number, pendingEpisodes: number): void => {
    database
      .insert(taskSeasons)
      .values({
        taskId,
        seasonNumber,
        status: "tracking",
        airProgress: airedEpisodes,
        airPendingProgress: pendingEpisodes,
        lastCheckAt: timestamp,
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .run();
  };

  if (meta.mediaType !== "tv") {
    // 电影：一条整片记录（看板按"已入库/未入库"显示，不分季）。
    insertSeason(0, 1, 0);
    updateTaskAirProgress(database, taskId, 1, undefined, 0);
    return;
  }

  const seasons = (meta.seasons ?? []).filter((season) => season.seasonNumber >= 1);
  let aired = 0;
  let pending = 0;
  let rows = 0;
  for (const season of seasons) {
    let seasonAired = 0;
    let seasonPending = 0;
    try {
      const progress = await tmdb.seasonProgress(meta.id, season.seasonNumber, new Date(), graceHours);
      seasonAired = progress.airedEpisodes;
      seasonPending = progress.pendingEpisodes ?? 0;
    } catch {
      // 单季拿不到先留 0，下一轮已播刷新会补上。
    }
    aired += seasonAired;
    pending += seasonPending;
    rows += 1;
    insertSeason(season.seasonNumber, seasonAired, seasonPending);
  }
  if (rows === 0) {
    try {
      aired = await tmdb.airedEpisodeCount(meta.id);
    } catch {
      aired = 0;
    }
    pending = 0;
    insertSeason(0, aired, 0);
  }
  updateTaskAirProgress(database, taskId, aired, undefined, pending);
}
