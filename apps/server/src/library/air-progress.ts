import { and, eq, isNotNull, ne } from "drizzle-orm";

import type { AppDatabase } from "@emby-task-center/database/client";
import { mediaItems, mediaTasks, taskSeasons } from "@emby-task-center/database/schema";
import { updateTaskAirProgress } from "@emby-task-center/task-domain/task-service";
import type { TmdbClient } from "../tmdb/client";
import { readMissingGraceHours } from "./missing-grace";

/**
 * 刷新剧集任务的已播进度。
 *
 * 只服务**入库任务**：未完成的入库任务每隔一段时间要跟 TMDB 对齐已播集数，缺集才看得出来。
 * 追更任务（持续轮询 + track_mode=tracking）与它的进度快照表已整体下线（2026-09），
 * 所以这里不再按 track_mode 分支、也不再写 follow_progress_logs。
 */
export async function refreshTvTaskAirProgress(database: AppDatabase, tmdb: TmdbClient): Promise<void> {
  // 「今日更新」宽限期（设置项 library.missingGraceHours）：每轮现读，改完设置下一轮就生效。
  const graceHours = readMissingGraceHours(database);
  const tasks = database
    .select({
      id: mediaTasks.id,
      seasonNumber: mediaTasks.seasonNumber,
      tmdbId: mediaItems.tmdbId,
    })
    .from(mediaTasks)
    .innerJoin(
      mediaItems,
      and(eq(mediaItems.id, mediaTasks.mediaItemId), eq(mediaItems.mediaType, "tv"), isNotNull(mediaItems.tmdbId)),
    )
    .where(ne(mediaTasks.status, "completed"))
    .all();

  await Promise.all(tasks.map((task) => refreshOne(database, tmdb, task, graceHours)));
}

/**
 * 写回某一季的已播/今日更新进度（只更新已存在的分季行；分季行是建任务时按 TMDB 分季写好的）。
 *
 * 导出的原因：任务看板的"已播 / 缺集 / 今日更新"读的就是分季行，凡是按 TMDB 重算过这一季的地方
 * （定时刷新、改季号 `PUT /api/tasks/:id/season`、改绑 TMDB）都必须同时写它，
 * 否则任务级数字变了、看板还停在旧值（表面看像"改了设置没生效"）。
 */
export function writeSeasonProgress(
  database: AppDatabase,
  taskId: number,
  seasonNumber: number,
  airedEpisodes: number,
  pendingEpisodes: number | null,
  checkedAt: string,
): void {
  database
    .update(taskSeasons)
    .set({
      airProgress: airedEpisodes,
      airPendingProgress: pendingEpisodes,
      lastCheckAt: checkedAt,
      updatedAt: checkedAt,
    })
    .where(and(eq(taskSeasons.taskId, taskId), eq(taskSeasons.seasonNumber, seasonNumber)))
    .run();
}

async function refreshOne(
  database: AppDatabase,
  tmdb: TmdbClient,
  task: { id: number; tmdbId: number | null; seasonNumber: number | null },
  graceHours: number,
): Promise<void> {
  if (task.tmdbId == null) return;
  try {
    const checkedAt = new Date().toISOString();
    if (task.seasonNumber != null) {
      const progress = await tmdb.seasonProgress(task.tmdbId, task.seasonNumber, new Date(), graceHours);
      const pending = progress.pendingEpisodes ?? 0;
      updateTaskAirProgress(database, task.id, progress.airedEpisodes, undefined, pending);
      writeSeasonProgress(database, task.id, task.seasonNumber, progress.airedEpisodes, pending, checkedAt);
      return;
    }
    // 整剧任务：逐季刷新并写回每一行分季进度。
    // 旧实现只更新任务总数 + season 0 行，而整剧任务没有 season 0 行（建任务时已删），
    // 分季行会永远停在建任务那一刻——任务看板按分季汇总，于是"已播"永远比 TMDB 少。
    let seasonNumbers: number[] = [];
    try {
      const details = await tmdb.details("tv", task.tmdbId);
      seasonNumbers = (details.seasons ?? [])
        .filter((season) => season.seasonNumber >= 1)
        .map((season) => season.seasonNumber);
    } catch {
      seasonNumbers = [];
    }
    if (!seasonNumbers.length) {
      // 拿不到分季（TMDB 异常 / 老数据）：退回整剧聚合 + season 0 行（旧行为）。
      // 这一路拿不到分集播出日，宽限期无法判定 → 宽限集数记 null（看板按 0 处理）。
      const airedEpisodes = await tmdb.airedEpisodeCount(task.tmdbId);
      updateTaskAirProgress(database, task.id, airedEpisodes, undefined, null);
      writeSeasonProgress(database, task.id, 0, airedEpisodes, null, checkedAt);
      return;
    }
    let total = 0;
    let pendingTotal = 0;
    for (const seasonNumber of seasonNumbers) {
      try {
        const progress = await tmdb.seasonProgress(task.tmdbId, seasonNumber, new Date(), graceHours);
        const pending = progress.pendingEpisodes ?? 0;
        total += progress.airedEpisodes;
        pendingTotal += pending;
        writeSeasonProgress(database, task.id, seasonNumber, progress.airedEpisodes, pending, checkedAt);
      } catch {
        // 单季失败不计入总数（与 airedEpisodeCount 的旧行为一致）。
      }
    }
    updateTaskAirProgress(database, task.id, total, undefined, pendingTotal);
  } catch {
    // One unavailable TMDB series must not block other tasks or the read-only library scan.
  }
}
