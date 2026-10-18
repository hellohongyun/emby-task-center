import type { AppDatabase } from "@emby-task-center/database/client";
import { applyScheduledAirProgress } from "@emby-task-center/task-domain/task-service";
import { refreshTvTaskAirProgress } from "../library/air-progress";
import type { TmdbClient } from "../tmdb/client";

/**
 * 一轮已播进度刷新（只服务未完成的入库任务）。
 *
 * 原来这里还会"复活"已完成的追更任务（发现新缺集就退回 pending）；追更整体下线后
 *（2026-09）不再有需要复活的长期任务，只剩把已播数对齐 TMDB。
 */
export async function refreshAirProgressCycle(database: AppDatabase, tmdb: TmdbClient): Promise<void> {
  await refreshTvTaskAirProgress(database, tmdb);
}

/** 一轮排期已播数推进（每到配置的更新日+时间就给任务的已播数 +1）。 */
export function applyScheduledAirProgressCycle(database: AppDatabase, now = new Date()): { updated: number } {
  return { updated: applyScheduledAirProgress(database, now) };
}
