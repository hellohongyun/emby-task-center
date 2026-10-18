import { and, eq, gt, inArray, isNotNull, lte, or, sql } from "drizzle-orm";
import type { CreateTaskInput, TaskStatus, TaskType } from "@emby-task-center/contracts/task";
import type { AppDatabase } from "@emby-task-center/database/client";
import {
  libraryItems,
  mediaAliases,
  mediaItems,
  mediaTasks,
  taskRuns,
  taskSeasons,
} from "@emby-task-center/database/schema";

export const TASK_LEASE_DURATION_MS = 15 * 60 * 1_000;

/**
 * 租约时长：默认 15 分钟；剧集（完结入库）缺集 > 15 集时，每多 1 集 +3 分钟。
 *
 * 原来还按 taskType 分「追更 / 完结入库」两支，追更已整体下线（2026-09）后只剩剧集完结入库，
 * 于是这里只看 mediaType。
 */
function leaseDurationFor(task: Task): number {
  let durationMs = TASK_LEASE_DURATION_MS;
  if (task.mediaType === "tv") {
    const missing = task.missingEpisodes.length;
    if (missing > 15) durationMs += (missing - 15) * 3 * 60_000;
  }
  return durationMs;
}

export interface Task {
  id: number;
  tmdbId: number | null;
  releaseYear: number | null;
  mediaType: CreateTaskInput["mediaType"];
  title: string;
  /** ?????????? media_items.poster_url?TMDB ????????? */
  posterUrl?: string | null;
  taskType: TaskType;
  seasonNumber: number | null;
  /** 完结入库内容类型：series=剧集完结 / variety=综艺完结（仅 TV + ingest 有值）。 */
  contentKind: "series" | "variety" | null;
  status: TaskStatus;
  statusMessage: string | null;
  /** 任务完成时刻（completed 状态有值；已入库电影自动清理倒计时用）。 */
  completedAt: string | null;
  airProgress: number | null;
  /** 已播出、仍在宽限期内（默认=今日更新）的集数：不算缺集，看板标「今日更新」。 */
  airPendingProgress: number | null;
  storedProgress: number | null;
  /** 任务片源计数方式：auto=自动匹配全剧，mapped=仅用片源文件夹映射统计。 */
  sourceMode: "auto" | "mapped";
  /** 正片更新时间：多选星期 + HH:mm（通知门控用）。 */
  releaseDays: number[];
  releaseTime: string | null;
  createdSource: string;
  mappedRootId: string | null;
  mappedFolderPath: string | null;
  version: number;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  lastCheckedAt: string | null;
  scheduleDay: number | null;
  scheduleDays: number[] | null;
  scheduleTime: string | null;
  scheduleAppliedKey: string | null;
  libraryMatched: boolean;
  missingEpisodes: number[];
  /** Manual source-name aliases used for matching, e.g. 斗破苍弯年番. */
  aliases?: string[];
  createdAt: string;
  updatedAt: string;
}

const taskSelection = {
  id: mediaTasks.id,
  tmdbId: mediaItems.tmdbId,
  releaseYear: mediaItems.releaseYear,
  mediaType: mediaItems.mediaType,
  title: mediaItems.title,
  posterUrl: mediaItems.posterUrl,
  taskType: mediaTasks.taskType,
  seasonNumber: mediaTasks.seasonNumber,
  contentKind: mediaTasks.contentKind,
  status: mediaTasks.status,
  statusMessage: mediaTasks.statusMessage,
  completedAt: mediaTasks.completedAt,
  airProgress: mediaTasks.airProgress,
  airPendingProgress: mediaTasks.airPendingProgress,
  storedProgress: mediaTasks.storedProgress,
  sourceMode: mediaTasks.sourceMode,
  createdSource: mediaTasks.createdSource,
  mappedRootId: mediaItems.mappedRootId,
  mappedFolderPath: mediaItems.mappedFolderPath,
  version: mediaTasks.version,
  leaseOwner: mediaTasks.leaseOwner,
  leaseExpiresAt: mediaTasks.leaseExpiresAt,
  lastCheckedAt: mediaTasks.lastCheckedAt,
  scheduleDay: mediaTasks.scheduleDay,
  scheduleDays: mediaTasks.scheduleDays,
  scheduleTime: mediaTasks.scheduleTime,
  scheduleAppliedKey: mediaTasks.scheduleAppliedKey,
  createdAt: mediaTasks.createdAt,
  updatedAt: mediaTasks.updatedAt,
};

type Reader = Pick<AppDatabase, "select">;
type Writer = Pick<AppDatabase, "insert">;

function nowIso(now = new Date()): string {
  return now.toISOString();
}

export function getTask(database: Reader, taskId: number): Task | null {
  const task = database
    .select(taskSelection)
    .from(mediaTasks)
    .innerJoin(mediaItems, eq(mediaItems.id, mediaTasks.mediaItemId))
    .where(eq(mediaTasks.id, taskId))
    .get();
  return task ? enrichLibraryState(database, task) : null;
}

function enrichLibraryState(
  database: Reader,
  task: Omit<Task, "libraryMatched" | "missingEpisodes" | "aliases" | "releaseDays" | "releaseTime">,
): Task {
  const media = database
    .select({ id: mediaTasks.mediaItemId, aliases: mediaItems.aliases })
    .from(mediaTasks)
    .innerJoin(mediaItems, eq(mediaItems.id, mediaTasks.mediaItemId))
    .where(eq(mediaTasks.id, task.id))
    .get();
  const aliases = media?.aliases ?? [];
  const files = media
    ? database.select({ id: libraryItems.id }).from(libraryItems).where(eq(libraryItems.mediaItemId, media.id)).all()
    : [];
  // 旧版 AI 通知门控（releaseDays/releaseTime）已移除。
  const releaseDays: number[] = [];
  const releaseTime: string | null = null;
  // 有映射、已存数>0 或匹配文件>0 任一成立即视为媒体库已匹配；映射任务可能无自动匹配文件。
  const libraryMatched =
    Boolean(task.mappedRootId && task.mappedFolderPath) || (task.storedProgress ?? 0) > 0 || files.length > 0;
  if (task.airProgress === null)
    return { ...task, releaseDays, releaseTime, aliases, libraryMatched, missingEpisodes: [] };
  if (task.mediaType === "movie") {
    return {
      ...task,
      releaseDays,
      releaseTime,
      aliases,
      libraryMatched,
      missingEpisodes: task.storedProgress ? [] : [1],
    };
  }
  // 缺集按已存数（storedProgress，映射或自动匹配口径）之后的连续集数计算；
  // 宽限期内（默认=今日更新）的那几集不算缺集：18 点更新、20 点才入库，白天不该报缺集。
  const stored = task.storedProgress ?? 0;
  const airedForMissing = Math.max(0, task.airProgress - (task.airPendingProgress ?? 0));
  const missingEpisodes = Array.from(
    { length: Math.max(0, airedForMissing - stored) },
    (_, index) => stored + 1 + index,
  );
  return { ...task, releaseDays, releaseTime, aliases, libraryMatched, missingEpisodes };
}

function idempotencyKey(mediaItemId: number, input: CreateTaskInput): string {
  return `${mediaItemId}:${input.taskType}:${input.seasonNumber ?? "all"}`;
}

function appendRun(
  database: Writer,
  values: {
    taskId: number;
    workerId: string;
    phase: string;
    timestamp: string;
    beforeStatus: TaskStatus;
    afterStatus: TaskStatus;
    summary?: string | null;
    error?: string | null;
  },
): void {
  database
    .insert(taskRuns)
    .values({
      taskId: values.taskId,
      workerId: values.workerId,
      phase: values.phase,
      startedAt: values.timestamp,
      finishedAt: values.timestamp,
      summary: values.summary,
      error: values.error,
      beforeStatus: values.beforeStatus,
      afterStatus: values.afterStatus,
    })
    .run();
}

export interface CreateTaskOutcome {
  created: boolean;
  task: Task;
}

export interface CanonicalMediaDetails {
  originalTitle: string;
  releaseYear: number | null;
  overview: string;
  posterUrl: string | null;
  backdropUrl: string | null;
  tmdbPayload: Record<string, unknown>;
}

export function createTaskWithOutcome(
  database: AppDatabase,
  input: CreateTaskInput,
  details?: CanonicalMediaDetails,
): CreateTaskOutcome {
  return database.transaction((transaction) => {
    const timestamp = nowIso();
    const mediaInsert = transaction.insert(mediaItems).values({
      tmdbId: input.tmdbId,
      mediaType: input.mediaType,
      title: input.title,
      ...details,
      syncedAt: details ? timestamp : null,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    if (details) {
      mediaInsert
        .onConflictDoUpdate({
          target: [mediaItems.mediaType, mediaItems.tmdbId],
          set: { title: input.title, ...details, syncedAt: timestamp, updatedAt: timestamp },
        })
        .run();
    } else {
      mediaInsert.onConflictDoNothing({ target: [mediaItems.mediaType, mediaItems.tmdbId] }).run();
    }

    const mediaItem = transaction
      .select({ id: mediaItems.id })
      .from(mediaItems)
      .where(and(eq(mediaItems.mediaType, input.mediaType), eq(mediaItems.tmdbId, input.tmdbId)))
      .get();
    if (!mediaItem) throw new Error("Media item was not created.");

    const key = idempotencyKey(mediaItem.id, input);
    const inserted = transaction
      .insert(mediaTasks)
      .values({
        mediaItemId: mediaItem.id,
        taskType: input.taskType,
        seasonNumber: input.seasonNumber ?? null,
        contentKind: input.contentKind ?? null,
        status: "pending",
        idempotencyKey: key,
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .onConflictDoNothing({ target: mediaTasks.idempotencyKey })
      .returning({ id: mediaTasks.id })
      .get();

    const task = transaction
      .select({ id: mediaTasks.id })
      .from(mediaTasks)
      .where(eq(mediaTasks.idempotencyKey, key))
      .get();
    if (!task) throw new Error("Task was not created.");
    registerAliasAndSeason(
      transaction,
      mediaItem.id,
      task.id,
      input.title,
      details?.originalTitle ?? input.title,
      input.seasonNumber ?? null,
      timestamp,
    );
    return { created: Boolean(inserted), task: getTask(transaction, task.id)! };
  });
}

export function createTask(database: AppDatabase, input: CreateTaskInput): Task {
  return createTaskWithOutcome(database, input).task;
}

export function claimTask(database: AppDatabase, taskId: number, workerId: string, now = new Date()): Task | null {
  return database.transaction((transaction) => {
    const current = getTask(transaction, taskId);
    if (!current) return null;

    const timestamp = nowIso(now);
    const leaseExpiresAt = nowIso(new Date(now.getTime() + leaseDurationFor(current)));
    const expiredLease = and(
      inArray(mediaTasks.status, ["claimed", "running"]),
      isNotNull(mediaTasks.leaseExpiresAt),
      lte(mediaTasks.leaseExpiresAt, timestamp),
    );
    const claimed = transaction
      .update(mediaTasks)
      .set({
        status: "claimed",
        leaseOwner: workerId,
        leaseExpiresAt,
        updatedAt: timestamp,
        version: sql`${mediaTasks.version} + 1`,
      })
      .where(and(eq(mediaTasks.id, taskId), or(eq(mediaTasks.status, "pending"), expiredLease)))
      .returning({ id: mediaTasks.id })
      .get();
    if (!claimed) return null;

    appendRun(transaction, {
      taskId,
      workerId,
      phase: current.status === "pending" ? "claim" : "reclaim",
      timestamp,
      beforeStatus: current.status,
      afterStatus: "claimed",
    });
    return getTask(transaction, taskId);
  });
}

function finishTask(
  database: AppDatabase,
  taskId: number,
  workerId: string,
  expectedVersion: number,
  status: "completed" | "failed",
  message: string | null,
  now = new Date(),
): Task | null {
  return database.transaction((transaction) => {
    const current = getTask(transaction, taskId);
    if (!current) return null;
    const timestamp = nowIso(now);
    const updated = transaction
      .update(mediaTasks)
      .set({
        status,
        statusMessage: message,
        completedAt: status === "completed" ? timestamp : null,
        leaseOwner: null,
        leaseExpiresAt: null,
        updatedAt: timestamp,
        version: sql`${mediaTasks.version} + 1`,
      })
      .where(
        and(
          eq(mediaTasks.id, taskId),
          inArray(mediaTasks.status, ["claimed", "running"]),
          eq(mediaTasks.leaseOwner, workerId),
          eq(mediaTasks.version, expectedVersion),
          isNotNull(mediaTasks.leaseExpiresAt),
          gt(mediaTasks.leaseExpiresAt, timestamp),
        ),
      )
      .returning({ id: mediaTasks.id })
      .get();
    if (!updated) return null;

    appendRun(transaction, {
      taskId,
      workerId,
      phase: status,
      timestamp,
      beforeStatus: current.status,
      afterStatus: status,
      summary: status === "completed" ? message : null,
      error: status === "failed" ? message : null,
    });
    return getTask(transaction, taskId);
  });
}

export function completeTask(
  database: AppDatabase,
  taskId: number,
  workerId: string,
  expectedVersion: number,
  now = new Date(),
  summary: string | null = null,
): Task | null {
  return finishTask(database, taskId, workerId, expectedVersion, "completed", summary, now);
}

export function failTask(
  database: AppDatabase,
  taskId: number,
  workerId: string,
  expectedVersion: number,
  reason: string,
  now = new Date(),
): Task | null {
  return finishTask(database, taskId, workerId, expectedVersion, "failed", reason, now);
}

export function listTasks(database: AppDatabase): Task[] {
  return database
    .select(taskSelection)
    .from(mediaTasks)
    .innerJoin(mediaItems, eq(mediaItems.id, mediaTasks.mediaItemId))
    .orderBy(mediaTasks.id)
    .all()
    .map((task) => enrichLibraryState(database, task));
}

/** 任务的分季行（剧集追踪看板按季展示用；movie / 单季任务也会有一条 season 0 行）。 */
export interface TaskSeasonRow {
  seasonNumber: number;
  status: "tracking" | "finished";
  airProgress: number | null;
  /** 已播出、仍在宽限期内（默认=今日更新）的集数：不算缺集。 */
  airPendingProgress: number | null;
  storedProgress: number | null;
  lastCheckedAt: string | null;
}

export function listTaskSeasons(database: Reader, taskId: number): TaskSeasonRow[] {
  return database
    .select({
      seasonNumber: taskSeasons.seasonNumber,
      status: taskSeasons.status,
      airProgress: taskSeasons.airProgress,
      airPendingProgress: taskSeasons.airPendingProgress,
      storedProgress: taskSeasons.storedProgress,
      lastCheckedAt: taskSeasons.lastCheckAt,
    })
    .from(taskSeasons)
    .where(eq(taskSeasons.taskId, taskId))
    .all()
    .sort((left, right) => left.seasonNumber - right.seasonNumber);
}

/**
 * 缺哪几集：已播之后还没入库的集号。
 *
 * 与任务级 `missingEpisodes`（enrichLibraryState）同一口径：只知道"已播 N 集 / 已存 M 集"，
 * 所以缺的是 M+1..N 这一段连续集号；真正的逐集比对要等媒体库拿到逐集明细。
 */
export function missingEpisodesBetween(airProgress: number | null, storedProgress: number | null): number[] {
  const aired = airProgress ?? 0;
  const stored = storedProgress ?? 0;
  return Array.from({ length: Math.max(0, aired - stored) }, (_, index) => stored + 1 + index);
}

export function cancelTask(database: AppDatabase, taskId: number, now = new Date()): Task | null {
  const timestamp = nowIso(now);
  const updated = database
    .update(mediaTasks)
    .set({
      status: "cancelled",
      statusMessage: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      updatedAt: timestamp,
      version: sql`${mediaTasks.version} + 1`,
    })
    .where(and(eq(mediaTasks.id, taskId), inArray(mediaTasks.status, ["pending", "failed"])))
    .returning({ id: mediaTasks.id })
    .get();
  return updated ? getTask(database, taskId) : null;
}

export function retryTask(database: AppDatabase, taskId: number, now = new Date()): Task | null {
  const timestamp = nowIso(now);
  const updated = database
    .update(mediaTasks)
    .set({
      status: "pending",
      statusMessage: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      updatedAt: timestamp,
      version: sql`${mediaTasks.version} + 1`,
    })
    .where(and(eq(mediaTasks.id, taskId), inArray(mediaTasks.status, ["failed", "cancelled"])))
    .returning({ id: mediaTasks.id })
    .get();
  return updated ? getTask(database, taskId) : null;
}

export function deleteTask(database: AppDatabase, taskId: number, now = new Date()): boolean {
  return database.transaction((transaction) => {
    const row = transaction
      .select({
        id: mediaTasks.id,
        mediaItemId: mediaTasks.mediaItemId,
        status: mediaTasks.status,
      })
      .from(mediaTasks)
      .where(eq(mediaTasks.id, taskId))
      .get();
    if (!row || row.status === "claimed" || row.status === "running") return false;
    transaction.delete(taskRuns).where(eq(taskRuns.taskId, taskId)).run();
    // 追踪数据是任务私有的：分季行与进度快照不跟着删就会变成查不到主人的残留。
    transaction.delete(taskSeasons).where(eq(taskSeasons.taskId, taskId)).run();
    const removed = transaction.delete(mediaTasks).where(eq(mediaTasks.id, taskId)).run().changes === 1;
    if (removed) {
      // 释放孤儿条目名下的匹配片源，便于以后重建同剧任务时重新匹配
      const remaining = transaction
        .select({ id: mediaTasks.id })
        .from(mediaTasks)
        .where(eq(mediaTasks.mediaItemId, row.mediaItemId))
        .get();
      if (!remaining) {
        const timestamp = nowIso(now);
        transaction
          .update(libraryItems)
          .set({
            mediaItemId: null,
            recognitionStatus: "unresolved",
            confidence: null,
            updatedAt: timestamp,
          })
          .where(eq(libraryItems.mediaItemId, row.mediaItemId))
          .run();
      }
    }
    return removed;
  });
}

/**
 * 清理已到期（completed 超过 retentionHours）的入库任务（电影 / 剧集完结 / 综艺完结）。
 * 只删任务（含自动化设置/运行记录），媒体库片源记录保留；retentionHours <= 0 时关闭。
 * （任务的「收件人」随任务更新通知整条链删除，2026-09：那张表已不存在。）
 */
export function sweepExpiredCompletedIngestTasks(
  database: AppDatabase,
  retentionHours: number,
  now = new Date(),
): number {
  if (retentionHours <= 0) return 0;
  const cutoffMs = now.getTime() - retentionHours * 3_600_000;
  const expired = listTasks(database).filter(
    (task) =>
      task.taskType === "ingest" &&
      task.status === "completed" &&
      (task.storedProgress ?? 0) > 0 &&
      Date.parse(task.completedAt ?? task.updatedAt) <= cutoffMs,
  );
  let deleted = 0;
  for (const task of expired) {
    if (deleteTask(database, task.id, now)) deleted += 1;
  }
  return deleted;
}

export function updateTaskAirProgress(
  database: AppDatabase,
  taskId: number,
  airProgress: number,
  now = new Date(),
  /** 宽限期内（今日更新）的集数；不传=不动这一列（老调用点行为不变）。 */
  pendingProgress?: number | null,
): Task | null {
  const timestamp = nowIso(now);
  database
    .update(mediaTasks)
    .set({
      airProgress,
      ...(pendingProgress === undefined ? {} : { airPendingProgress: pendingProgress }),
      lastCheckedAt: timestamp,
      updatedAt: timestamp,
    })
    .where(eq(mediaTasks.id, taskId))
    .run();
  return getTask(database, taskId);
}

/** 设置/清除任务跟踪的季号（分季剧集）；null 表示按整剧所有季合计。 */
export function updateTaskSeason(
  database: AppDatabase,
  taskId: number,
  seasonNumber: number | null,
  now = new Date(),
): Task | null {
  const timestamp = nowIso(now);
  database
    .update(mediaTasks)
    .set({
      seasonNumber,
      lastCheckedAt: timestamp,
      updatedAt: timestamp,
      version: sql`${mediaTasks.version} + 1`,
    })
    .where(eq(mediaTasks.id, taskId))
    .run();
  return getTask(database, taskId);
}

/** 为手动任务设置片源文件夹映射，并把已播数(storedProgress)同步为该文件夹集数。 */
export function setTaskFolderMapping(
  database: AppDatabase,
  taskId: number,
  rootId: string,
  folderPath: string,
  episodeCount: number,
  sourceMode?: "auto" | "mapped",
  now = new Date(),
): Task | null {
  const row = database
    .select({ mediaItemId: mediaTasks.mediaItemId })
    .from(mediaTasks)
    .where(eq(mediaTasks.id, taskId))
    .get();
  if (!row) return null;
  const timestamp = nowIso(now);
  database
    .update(mediaItems)
    .set({ mappedRootId: rootId, mappedFolderPath: folderPath })
    .where(eq(mediaItems.id, row.mediaItemId))
    .run();
  database
    .update(mediaTasks)
    .set({
      storedProgress: episodeCount,
      ...(sourceMode ? { sourceMode } : {}),
      lastCheckedAt: timestamp,
      updatedAt: timestamp,
    })
    .where(eq(mediaTasks.id, taskId))
    .run();
  return getTask(database, taskId);
}

/** 清除手动任务的片源文件夹映射（不动 storedProgress）。 */
export function clearTaskFolderMapping(database: AppDatabase, taskId: number): Task | null {
  const row = database
    .select({ mediaItemId: mediaTasks.mediaItemId })
    .from(mediaTasks)
    .where(eq(mediaTasks.id, taskId))
    .get();
  if (!row) return null;
  database
    .update(mediaItems)
    .set({ mappedRootId: null, mappedFolderPath: null })
    .where(eq(mediaItems.id, row.mediaItemId))
    .run();
  return getTask(database, taskId);
}

export interface ManualTaskInput {
  mediaType: CreateTaskInput["mediaType"];
  taskType: TaskType;
  title: string;
  seasonNumber?: number | null;
  contentKind?: "series" | "variety" | null;
  releaseYear?: number | null;
  posterUrl?: string | null;
  overview?: string | null;
  /** 创建来源标识（默认 manual）。 */
  createdSource?: string;
}

/** 创建不依赖 TMDB 的手动任务（tmdbId 为空，可后续用别名匹配片源）。 */
export function createManualTask(database: AppDatabase, input: ManualTaskInput): Task {
  return database.transaction((transaction) => {
    const timestamp = nowIso();
    const mediaItem = transaction
      .insert(mediaItems)
      .values({
        tmdbId: null,
        mediaType: input.mediaType,
        title: input.title,
        releaseYear: input.releaseYear ?? null,
        posterUrl: input.posterUrl ?? null,
        overview: input.overview ?? null,
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .returning({ id: mediaItems.id })
      .get();
    const key = `manual:${input.title.toLocaleLowerCase().trim()}:${input.taskType}:${input.seasonNumber ?? "all"}`;
    const inserted = transaction
      .insert(mediaTasks)
      .values({
        mediaItemId: mediaItem.id,
        taskType: input.taskType,
        seasonNumber: input.seasonNumber ?? null,
        contentKind: input.contentKind ?? null,
        status: "pending",
        createdSource: input.createdSource ?? "manual",
        idempotencyKey: key,
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .onConflictDoNothing({ target: mediaTasks.idempotencyKey })
      .returning({ id: mediaTasks.id })
      .get();
    const taskId =
      inserted?.id ??
      transaction.select({ id: mediaTasks.id }).from(mediaTasks).where(eq(mediaTasks.idempotencyKey, key)).get()?.id;
    if (!taskId) throw new Error("Task was not created.");
    const task = getTask(database, taskId);
    if (!task) throw new Error("Task was not created.");
    registerAliasAndSeason(
      transaction,
      mediaItem.id,
      taskId,
      input.title,
      undefined,
      input.seasonNumber ?? null,
      timestamp,
    );
    return task;
  });
}

/** 登记内容别名（中文/原题）与任务分季行（多季跟踪）。 */
export function registerAliasAndSeason(
  transaction: AppDatabase,
  itemId: number,
  taskId: number,
  title: string,
  originalTitle?: string | null,
  seasonNumber?: number | null,
  timestamp?: string,
): void {
  const now = timestamp ?? nowIso();
  const names = [title, originalTitle].filter(
    (name): name is string => typeof name === "string" && name.trim().length > 0,
  );
  for (const name of names) {
    transaction
      .insert(mediaAliases)
      .values({
        itemId,
        name: name.trim(),
        lang: "zh",
        source: "auto",
        createdAt: now,
      })
      .onConflictDoNothing({ target: [mediaAliases.itemId, mediaAliases.name] })
      .run();
  }
  const season = seasonNumber ?? 0;
  // 这一行的 status 现在只表示「该季还没入库完成」：追更已整体下线（2026-09），
  // 于是只有未完成任务会写分季行，完成后的收尾由任务级状态表达。
  transaction
    .insert(taskSeasons)
    .values({
      taskId,
      seasonNumber: season,
      status: "tracking",
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: [taskSeasons.taskId, taskSeasons.seasonNumber] })
    .run();
}

/** 设置每周自动更新已播数的排期（day: 0=周日..6=周六；time: "HH:MM"）。 */
export function updateTaskSchedule(
  database: AppDatabase,
  taskId: number,
  scheduleDays: number[],
  scheduleTime: string | null,
  now = new Date(),
): Task | null {
  const timestamp = nowIso(now);
  database
    .update(mediaTasks)
    .set({
      scheduleDays: scheduleDays.length ? scheduleDays : null,
      scheduleDay: scheduleDays[0] ?? null,
      scheduleTime,
      scheduleAppliedKey: null,
      updatedAt: timestamp,
      version: sql`${mediaTasks.version} + 1`,
    })
    .where(eq(mediaTasks.id, taskId))
    .run();
  return getTask(database, taskId);
}

/** 每到配置的每周更新日+时间，已播数自动 +1（每个更新日只加一次）。返回更新数量。 */
export function applyScheduledAirProgress(database: AppDatabase, now = new Date()): number {
  const day = now.getDay();
  const hhmm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const rows = database
    .select({
      id: mediaTasks.id,
      airProgress: mediaTasks.airProgress,
      scheduleDay: mediaTasks.scheduleDay,
      scheduleDays: mediaTasks.scheduleDays,
      scheduleTime: mediaTasks.scheduleTime,
      scheduleAppliedKey: mediaTasks.scheduleAppliedKey,
    })
    .from(mediaTasks)
    .where(
      and(
        or(isNotNull(mediaTasks.scheduleDays), isNotNull(mediaTasks.scheduleDay)),
        isNotNull(mediaTasks.scheduleTime),
      ),
    )
    .all();
  let updated = 0;
  for (const row of rows) {
    const days =
      row.scheduleDays && row.scheduleDays.length ? row.scheduleDays : row.scheduleDay != null ? [row.scheduleDay] : [];
    if (!days.includes(day) || !row.scheduleTime || row.scheduleTime > hhmm || row.scheduleAppliedKey === today)
      continue;
    database
      .update(mediaTasks)
      .set({
        airProgress: (row.airProgress ?? 0) + 1,
        scheduleAppliedKey: today,
        updatedAt: nowIso(now),
        version: sql`${mediaTasks.version} + 1`,
      })
      .where(eq(mediaTasks.id, row.id))
      .run();
    updated += 1;
  }
  return updated;
}

/**
 * 已同步任务自动完成并记录完成时刻：
 * - 完结入库（剧集、综艺）缺集全部补齐（已存 ≥ 已播）且仍为 pending；
 * - 电影入库片源已到位（已存数 > 0）。
 *
 * 原 reactivateMissingFollowTasks（把缺集的已完成追更任务退回 pending）随追更整体下线（2026-09）删除：
 * 它只服务 follow 任务，入库任务是一次性收尾，不再需要自动复活。
 */
export function completeSyncedTasks(database: AppDatabase, now = new Date()): Task[] {
  const timestamp = nowIso(now);
  const completed: Task[] = [];
  for (const task of listTasks(database)) {
    if (task.status !== "pending") continue;
    const synced =
      task.mediaType === "movie"
        ? task.taskType === "ingest" && (task.storedProgress ?? 0) > 0
        : task.airProgress !== null && task.missingEpisodes.length === 0 && (task.airPendingProgress ?? 0) === 0;
    if (!synced) continue;
    database
      .update(mediaTasks)
      .set({
        status: "completed",
        statusMessage: null,
        completedAt: timestamp,
        leaseOwner: null,
        leaseExpiresAt: null,
        updatedAt: timestamp,
        version: sql`${mediaTasks.version} + 1`,
      })
      .where(and(eq(mediaTasks.id, task.id), eq(mediaTasks.status, "pending")))
      .run();
    const updated = getTask(database, task.id);
    if (updated) completed.push(updated);
  }
  return completed;
}
