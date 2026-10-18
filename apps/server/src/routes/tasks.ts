import type { Express } from "express";
import { and, eq } from "drizzle-orm";

import type { AppDatabase } from "@emby-task-center/database/client";
import { mediaTasks, taskSeasons } from "@emby-task-center/database/schema";
import {
  cancelTask,
  clearTaskFolderMapping,
  createTaskWithOutcome,
  deleteTask,
  getTask,
  listTaskSeasons,
  retryTask,
  setTaskFolderMapping,
  updateTaskAirProgress,
  updateTaskSchedule,
  updateTaskSeason,
  type CanonicalMediaDetails,
} from "@emby-task-center/task-domain/task-service";
import type { TmdbClient } from "../tmdb/client";
import { buildTaskBoard } from "../library/task-board";
import { writeSeasonProgress } from "../library/air-progress";
import { readMissingGraceHours } from "../library/missing-grace";
import { rebindMediaItemTmdb } from "../library/rebind-tmdb";
import { type LibraryService } from "../library/service";
import { audit } from "../subscriptions/domain-utils";
import {
  BatchDeleteSchema,
  CreateTaskSchema,
  FolderMappingSchema,
  ProgressSchema,
  RebindTmdbSchema,
  ScheduleSchema,
  SeasonSchema,
  mutateTask,
  readTaskId,
} from "./task-schemas";

/** 该电影是否已在媒体库/任务中心存在（重复原因）：已有片源文件或已有进行中的入库任务。 */

export interface TaskRouteOptions {
  database: AppDatabase;
  tmdb: TmdbClient;
  library?: LibraryService | undefined;
  queue?: { movieGroupSize: number; delayHours: number; retentionHours: number } | undefined;
}

// P3：位置参数（含历史遗留的 notifier 占位）改为全选选项对象，调用点不再出现 undefined 空洞。
export function registerTaskRoutes(app: Express, options: TaskRouteOptions): void {
  const { database, tmdb, library, queue } = options;

  /** 任务看板数据源：任务 + 分季缺集 + 媒体库归属（口径与实现见 library/task-board.ts）。 */
  app.get("/api/tasks", (_request, response) => {
    response.json({ retentionHours: queue?.retentionHours ?? 24, tasks: buildTaskBoard(database) });
  });

  /**
   * 新建任务（完结入库）。
   *
   * 追更（follow）整体下线后，这是任务中心**唯一**的创建入口：搜 TMDB 选中一部剧/电影 →
   * 建一条 ingest 任务，由 worker 认领后把 TMDB 已播、库里还缺的集补齐。
   * 幂等：同一部剧重复添加会复用已有任务（createTaskWithOutcome 按 idempotencyKey 去重）。
   */
  app.post("/api/tasks", async (request, response) => {
    const parsed = CreateTaskSchema.safeParse(request.body);
    if (!parsed.success) return void response.status(400).json({ error: "invalid_request" });
    const { tmdbId, title, mediaType } = parsed.data;

    // 「今日更新」宽限期（设置项 library.missingGraceHours）：当天播出的集先不计缺集。
    const graceHours = readMissingGraceHours(database);
    // TMDB 拿不到也要允许建任务：进度留空，等下一轮已播刷新填上（与旧入口一致）。
    let details: CanonicalMediaDetails | undefined;
    let seasonAired: Array<{ seasonNumber: number; airedEpisodes: number; pendingEpisodes: number }> = [];
    let totalAired = 0;
    let totalPending = 0;
    try {
      const detail = await tmdb.details(mediaType, tmdbId);
      details = {
        originalTitle: detail.originalTitle,
        releaseYear: detail.releaseYear,
        overview: detail.overview,
        posterUrl: detail.posterUrl,
        backdropUrl: detail.backdropUrl,
        tmdbPayload: {
          tmdbId,
          title: detail.title,
          originalTitle: detail.originalTitle,
          releaseYear: detail.releaseYear,
          posterUrl: detail.posterUrl,
          mediaType,
        },
      };
      if (mediaType === "tv") {
        const seasons = (detail.seasons ?? []).filter((season) => season.seasonNumber >= 1);
        seasonAired = (
          await Promise.all(
            seasons.map(async (season) => {
              try {
                const progress = await tmdb.seasonProgress(tmdbId, season.seasonNumber, new Date(), graceHours);
                return {
                  seasonNumber: season.seasonNumber,
                  airedEpisodes: progress.airedEpisodes,
                  pendingEpisodes: progress.pendingEpisodes ?? 0,
                };
              } catch {
                return { seasonNumber: season.seasonNumber, airedEpisodes: 0, pendingEpisodes: 0 };
              }
            }),
          )
        ).sort((left, right) => left.seasonNumber - right.seasonNumber);
        totalAired = seasonAired.reduce((sum, season) => sum + season.airedEpisodes, 0);
        totalPending = seasonAired.reduce((sum, season) => sum + season.pendingEpisodes, 0);
      }
    } catch {
      /* 见上：TMDB 不可用不阻塞建任务 */
    }

    const outcome = createTaskWithOutcome(
      database,
      {
        mediaType,
        taskType: "ingest",
        title,
        tmdbId,
        // CreateTaskInput 用 undefined 表示"没有"，不是 null。
        seasonNumber: parsed.data.seasonNumber ?? undefined,
        contentKind: mediaType === "tv" ? "series" : undefined,
      },
      details,
    );

    const taskId = outcome.task.id;
    const timestamp = new Date().toISOString();
    for (const season of seasonAired) {
      database
        .insert(taskSeasons)
        .values({
          taskId,
          seasonNumber: season.seasonNumber,
          // status 这一列沿用旧值：tracking = 该季还没入库完成（跟已下线的"追更"无关）。
          status: "tracking",
          airProgress: season.airedEpisodes,
          airPendingProgress: season.pendingEpisodes,
          lastCheckAt: timestamp,
          createdAt: timestamp,
          updatedAt: timestamp,
        })
        .onConflictDoUpdate({
          target: [taskSeasons.taskId, taskSeasons.seasonNumber],
          set: {
            airProgress: season.airedEpisodes,
            airPendingProgress: season.pendingEpisodes,
            lastCheckAt: timestamp,
            updatedAt: timestamp,
          },
        })
        .run();
    }
    // 整剧任务会先落一条 season 0 占位行；拿到真实分季后它只会干扰看板，删掉。
    if (seasonAired.length > 0) {
      database
        .delete(taskSeasons)
        .where(and(eq(taskSeasons.taskId, taskId), eq(taskSeasons.seasonNumber, 0)))
        .run();
      updateTaskAirProgress(database, taskId, totalAired, undefined, totalPending);
    }

    audit(database, "admin", "task.created", "task", taskId, undefined, {
      tmdbId,
      title,
      mediaType,
      seasons: seasonAired.length,
      created: outcome.created,
    });
    response.status(outcome.created ? 201 : 200).json({
      task: getTask(database, taskId),
      seasons: listTaskSeasons(database, taskId),
      created: outcome.created,
    });
  });

  app.post("/api/tasks/batch-delete", (request, response) => {
    const parsed = BatchDeleteSchema.safeParse(request.body);
    if (!parsed.success) return void response.status(400).json({ error: "invalid_request" });
    const deleted: number[] = [];
    const failed: Array<{ taskId: number; error: string }> = [];
    for (const taskId of parsed.data.taskIds) {
      if (!getTask(database, taskId)) {
        failed.push({ taskId, error: "not_found" });
        continue;
      }
      if (!deleteTask(database, taskId)) {
        failed.push({ taskId, error: "task_is_running" });
        continue;
      }
      deleted.push(taskId);
    }
    response.json({ deleted, failed });
  });

  /**
   * 改绑 TMDB 条目（任务看板行内「改绑」）：选错条目 / 手滑填错 id 时的手动修复路径。
   *
   * 目标条目已存在就合并（任务、库内片源、别名、提供方索引一起改指，旧条目回收），
   * 接着按新条目重建分季与已播/今日更新进度，并作废旧的缺集快照。
   * 具体实现见 library/rebind-tmdb.ts；这里只做校验、审计与响应。
   */
  app.put("/api/tasks/:taskId/tmdb", async (request, response, next) => {
    try {
      const taskId = readTaskId(request.params.taskId);
      const parsed = RebindTmdbSchema.safeParse(request.body);
      if (!taskId || !parsed.success) return void response.status(400).json({ error: "invalid_request" });
      const current = getTask(database, taskId);
      if (!current) return void response.status(404).json({ error: "task_not_found" });
      const mediaItemId = database
        .select({ mediaItemId: mediaTasks.mediaItemId })
        .from(mediaTasks)
        .where(eq(mediaTasks.id, taskId))
        .get()?.mediaItemId;
      if (mediaItemId == null) return void response.status(404).json({ error: "task_not_found" });

      const result = await rebindMediaItemTmdb(database, tmdb, {
        mediaItemId,
        tmdbId: parsed.data.tmdbId,
        mediaType: parsed.data.mediaType,
        title: parsed.data.title,
        graceHours: readMissingGraceHours(database),
      });
      if (!result.ok) {
        return void response
          .status(result.error === "media_item_not_found" ? 404 : 400)
          .json({ error: result.error ?? "rebind_failed" });
      }
      // 条目身份换了：媒体库库存缓存要作废，否则页面还挂着旧标题/旧海报。
      library?.invalidateInventory?.();
      audit(
        database,
        "admin",
        "task.tmdb_rebound",
        "task",
        taskId,
        { tmdbId: current.tmdbId, title: current.title, mediaType: current.mediaType },
        {
          tmdbId: result.tmdbId,
          title: result.title,
          mediaItemId: result.mediaItemId,
          mergedFrom: result.mergedFrom,
          metadataSynced: result.metadataSynced,
        },
      );
      response.json({
        task: getTask(database, taskId),
        seasons: listTaskSeasons(database, taskId),
        mediaItemId: result.mediaItemId,
        merged: result.mergedFrom != null,
        metadataSynced: result.metadataSynced,
      });
    } catch (error) {
      next(error);
    }
  });

  app.put("/api/tasks/:taskId/progress", (request, response) => {
    const taskId = readTaskId(request.params.taskId);
    const parsed = ProgressSchema.safeParse(request.body);
    if (!taskId || !parsed.success) return void response.status(400).json({ error: "invalid_request" });
    const task = updateTaskAirProgress(database, taskId, parsed.data.airProgress);
    if (!task) return void response.status(404).json({ error: "task_not_found" });
    response.json(task);
  });

  app.put("/api/tasks/:taskId/schedule", (request, response) => {
    const taskId = readTaskId(request.params.taskId);
    const parsed = ScheduleSchema.safeParse(request.body);
    if (!taskId || !parsed.success) return void response.status(400).json({ error: "invalid_request" });
    const task = updateTaskSchedule(database, taskId, parsed.data.days, parsed.data.time);
    if (!task) return void response.status(404).json({ error: "task_not_found" });
    response.json(task);
  });

  app.put("/api/tasks/:taskId/season", async (request, response) => {
    const taskId = readTaskId(request.params.taskId);
    const parsed = SeasonSchema.safeParse(request.body);
    if (!taskId || !parsed.success) return void response.status(400).json({ error: "invalid_request" });
    const current = getTask(database, taskId);
    if (!current) return void response.status(404).json({ error: "task_not_found" });
    if (current.mediaType === "movie" && parsed.data.seasonNumber != null) {
      return void response.status(400).json({ error: "invalid_request" });
    }
    let task = updateTaskSeason(database, taskId, parsed.data.seasonNumber);
    if (!task) return void response.status(404).json({ error: "task_not_found" });
    if (task.mediaType === "tv" && task.tmdbId != null && task.seasonNumber != null) {
      try {
        const progress = await tmdb.seasonProgress(
          task.tmdbId,
          task.seasonNumber,
          new Date(),
          readMissingGraceHours(database),
        );
        const pending = progress.pendingEpisodes ?? 0;
        // 任务级与分季行都要写：看板按分季行展示，只写任务级会让"刚刚改完的宽限期/季号"在页面上看不出来。
        writeSeasonProgress(
          database,
          taskId,
          task.seasonNumber,
          progress.airedEpisodes,
          pending,
          new Date().toISOString(),
        );
        task = updateTaskAirProgress(database, taskId, progress.airedEpisodes, undefined, pending) ?? task;
      } catch {
        /* TMDB 暂时不可用时保留原进度 */
      }
    }
    response.json(task);
  });

  app.get("/api/tasks/:taskId/mapping", (request, response) => {
    const taskId = readTaskId(request.params.taskId);
    if (!taskId) return void response.status(400).json({ error: "invalid_request" });
    const task = getTask(database, taskId);
    if (!task) return void response.status(404).json({ error: "task_not_found" });
    const folderEpisodeCount =
      task.mappedRootId && task.mappedFolderPath
        ? (library?.countFolderEpisodes?.(task.mappedRootId, task.mappedFolderPath) ?? 0)
        : 0;
    response.json({ task, folderEpisodeCount });
  });

  app.put("/api/tasks/:taskId/mapping", (request, response) => {
    const taskId = readTaskId(request.params.taskId);
    const parsed = FolderMappingSchema.safeParse(request.body);
    if (!taskId || !parsed.success || !library) return void response.status(400).json({ error: "invalid_request" });
    const task = getTask(database, taskId);
    if (!task) return void response.status(404).json({ error: "task_not_found" });
    const count = library.countFolderEpisodes?.(parsed.data.rootId, parsed.data.folderPath) ?? 0;
    const episodeCount = task.mediaType === "movie" ? (count > 0 ? 1 : 0) : count;
    const updated = setTaskFolderMapping(
      database,
      taskId,
      parsed.data.rootId,
      parsed.data.folderPath,
      episodeCount,
      parsed.data.sourceMode,
    );
    if (!updated) return void response.status(404).json({ error: "task_not_found" });
    response.json({ task: updated, folderEpisodeCount: count });
  });

  app.delete("/api/tasks/:taskId/mapping", (request, response) => {
    const taskId = readTaskId(request.params.taskId);
    if (!taskId) return void response.status(400).json({ error: "invalid_request" });
    const task = clearTaskFolderMapping(database, taskId);
    if (!task) return void response.status(404).json({ error: "task_not_found" });
    response.json({ task });
  });

  app.post("/api/tasks/:taskId/cancel", (request, response) => {
    mutateTask(request.params.taskId, response, database, cancelTask);
  });

  app.post("/api/tasks/:taskId/retry", async (request, response) => {
    const taskId = readTaskId(request.params.taskId);
    if (!taskId) return void response.status(400).json({ error: "invalid_task_id" });
    if (!getTask(database, taskId)) return void response.status(404).json({ error: "task_not_found" });
    const task = retryTask(database, taskId);
    if (!task) return void response.status(409).json({ error: "invalid_task_state" });
    response.json(task);
  });

  app.delete("/api/tasks/:taskId", (request, response) => {
    const taskId = readTaskId(request.params.taskId);
    if (!taskId) return void response.status(400).json({ error: "invalid_task_id" });
    if (!getTask(database, taskId)) return void response.status(404).json({ error: "task_not_found" });
    if (!deleteTask(database, taskId)) return void response.status(409).json({ error: "task_is_running" });
    response.status(204).end();
  });
}
