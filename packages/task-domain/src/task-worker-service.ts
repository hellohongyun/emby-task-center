import { and, eq, gt, inArray, isNotNull, sql } from "drizzle-orm";

import type { TaskStatus } from "@emby-task-center/contracts/task";
import type { AppDatabase } from "@emby-task-center/database/client";
import { mediaTasks, taskRuns } from "@emby-task-center/database/schema";
import { claimTask, getTask, listTasks, TASK_LEASE_DURATION_MS, type Task } from "./task-service";

export interface ProgressUpdate {
  statusMessage: string;
  airProgress?: number;
  storedProgress?: number;
}

/** 心跳续租：AI 处理中周期调用，延长租约并（可选）更新状态消息；不递增版本、不记执行流水。 */
export function renewTaskLease(
  database: AppDatabase,
  taskId: number,
  workerId: string,
  now = new Date(),
  statusMessage?: string,
): Task | null {
  const current = getTask(database, taskId);
  if (!current) return null;
  if (current.status !== "claimed" && current.status !== "running") return null;
  if (current.leaseOwner !== workerId) return null;
  if (current.leaseExpiresAt && Date.parse(current.leaseExpiresAt) <= now.getTime()) return null;
  const updated = database
    .update(mediaTasks)
    .set({
      leaseExpiresAt: new Date(now.getTime() + TASK_LEASE_DURATION_MS).toISOString(),
      ...(statusMessage !== undefined ? { statusMessage } : {}),
      updatedAt: now.toISOString(),
    })
    .where(
      and(
        eq(mediaTasks.id, taskId),
        inArray(mediaTasks.status, ["claimed", "running"]),
        eq(mediaTasks.leaseOwner, workerId),
      ),
    )
    .returning({ id: mediaTasks.id })
    .get();
  return updated ? getTask(database, taskId) : null;
}

export function claimNextTask(database: AppDatabase, workerId: string, now = new Date()): Task | null {
  for (const candidate of listTasks(database)) {
    const claimed = claimTask(database, candidate.id, workerId, now);
    if (claimed) return claimed;
  }
  return null;
}

export function reportTaskProgress(
  database: AppDatabase,
  taskId: number,
  workerId: string,
  expectedVersion: number,
  progress: ProgressUpdate,
  now = new Date(),
): Task | null {
  return transitionActiveLease(database, taskId, workerId, now, (transaction, current, timestamp) => {
    const updated = transaction
      .update(mediaTasks)
      .set({
        status: "running",
        statusMessage: progress.statusMessage,
        airProgress: progress.airProgress,
        storedProgress: progress.storedProgress,
        leaseExpiresAt: new Date(now.getTime() + TASK_LEASE_DURATION_MS).toISOString(),
        updatedAt: timestamp,
        version: sql`${mediaTasks.version} + 1`,
      })
      .where(activeLease(taskId, workerId, expectedVersion, timestamp))
      .returning({ id: mediaTasks.id })
      .get();
    if (!updated) return null;
    appendTransition(
      transaction,
      taskId,
      workerId,
      "progress",
      current.status,
      "running",
      timestamp,
      progress.statusMessage,
    );
    return getTask(transaction, taskId);
  });
}

export function releaseTask(
  database: AppDatabase,
  taskId: number,
  workerId: string,
  expectedVersion: number,
  now = new Date(),
): Task | null {
  return transitionActiveLease(database, taskId, workerId, now, (transaction, current, timestamp) => {
    const updated = transaction
      .update(mediaTasks)
      .set({
        status: "pending",
        statusMessage: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        updatedAt: timestamp,
        version: sql`${mediaTasks.version} + 1`,
      })
      .where(activeLease(taskId, workerId, expectedVersion, timestamp))
      .returning({ id: mediaTasks.id })
      .get();
    if (!updated) return null;
    appendTransition(transaction, taskId, workerId, "release", current.status, "pending", timestamp);
    return getTask(transaction, taskId);
  });
}

function activeLease(taskId: number, workerId: string, expectedVersion: number, timestamp: string) {
  return and(
    eq(mediaTasks.id, taskId),
    inArray(mediaTasks.status, ["claimed", "running"]),
    eq(mediaTasks.leaseOwner, workerId),
    eq(mediaTasks.version, expectedVersion),
    isNotNull(mediaTasks.leaseExpiresAt),
    gt(mediaTasks.leaseExpiresAt, timestamp),
  );
}

function transitionActiveLease(
  database: AppDatabase,
  taskId: number,
  workerId: string,
  now: Date,
  transition: (
    transaction: Parameters<Parameters<AppDatabase["transaction"]>[0]>[0],
    current: Task,
    timestamp: string,
  ) => Task | null,
): Task | null {
  return database.transaction((transaction) => {
    const current = getTask(transaction, taskId);
    if (!current) return null;
    return transition(transaction, current, now.toISOString());
  });
}

function appendTransition(
  database: AppDatabase,
  taskId: number,
  workerId: string,
  phase: string,
  beforeStatus: TaskStatus,
  afterStatus: TaskStatus,
  timestamp: string,
  summary: string | null = null,
): void {
  database
    .insert(taskRuns)
    .values({
      taskId,
      workerId,
      phase,
      startedAt: timestamp,
      finishedAt: timestamp,
      summary,
      beforeStatus,
      afterStatus,
    })
    .run();
}
