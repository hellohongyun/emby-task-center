import { and, count, desc, eq, isNotNull } from "drizzle-orm";
import type { Express, Request, Response } from "express";

import type { AppDatabase } from "@emby-task-center/database/client";
import { libraryItems, mediaItems, mediaRoots, mediaTasks } from "@emby-task-center/database/schema";
import { listSubmissionUsers } from "../subscriptions/membership";

export interface DashboardSummary {
  tasks: { total: number; pending: number; processing: number; completed: number; failed: number };
  library: { roots: number; items: number; matched: number; unmatched: number };
  members: { total: number; active: number; expiring: number; expired: number; concurrencyActive: number };
  recentTasks: Array<{
    id: number;
    title: string;
    mediaType: string;
    taskType: string;
    status: string;
    updatedAt: string;
  }>;
}

/** 首页数据总览：聚合一屏可读的运营指标，全部来自本地 DB，不依赖 Emby 网络、不阻塞。 */
export function getDashboardSummary(database: AppDatabase): DashboardSummary {
  const taskRows = database
    .select({ status: mediaTasks.status, n: count() })
    .from(mediaTasks)
    .groupBy(mediaTasks.status)
    .all();
  const taskByStatus = Object.fromEntries(taskRows.map((row) => [row.status, row.n]));
  const taskTotal = taskRows.reduce((sum, row) => sum + row.n, 0);

  const libItems = database
    .select({ n: count() })
    .from(libraryItems)
    .innerJoin(mediaRoots, eq(libraryItems.mediaRootId, mediaRoots.id))
    .where(eq(mediaRoots.enabled, true))
    .get()!.n;
  const libMatched = database
    .select({ n: count() })
    .from(libraryItems)
    .innerJoin(mediaRoots, eq(libraryItems.mediaRootId, mediaRoots.id))
    .where(and(eq(mediaRoots.enabled, true), isNotNull(libraryItems.mediaItemId)))
    .get()!.n;
  const libRoots = database.select({ n: count() }).from(mediaRoots).where(eq(mediaRoots.enabled, true)).get()!.n;

  // 投稿统计已随投稿功能删除：movie_submissions 不再有写入方，这里不再聚合（表结构保留）。
  const members = listSubmissionUsers(database);

  const recentTasks = database
    .select({
      id: mediaTasks.id,
      title: mediaItems.title,
      mediaType: mediaItems.mediaType,
      taskType: mediaTasks.taskType,
      status: mediaTasks.status,
      updatedAt: mediaTasks.updatedAt,
    })
    .from(mediaTasks)
    .innerJoin(mediaItems, eq(mediaTasks.mediaItemId, mediaItems.id))
    .orderBy(desc(mediaTasks.updatedAt))
    .limit(8)
    .all();

  return {
    tasks: {
      total: taskTotal,
      pending: taskByStatus.pending ?? 0,
      processing: (taskByStatus.claimed ?? 0) + (taskByStatus.running ?? 0),
      completed: taskByStatus.completed ?? 0,
      failed: taskByStatus.failed ?? 0,
    },
    library: { roots: libRoots, items: libItems, matched: libMatched, unmatched: libItems - libMatched },
    members: {
      total: members.length,
      active: members.filter((m) => m.status === "active").length,
      expiring: members.filter((m) => m.status === "expiring").length,
      expired: members.filter((m) => m.status === "expired").length,
      concurrencyActive: members.filter((m) => m.concurrency.disabled || m.concurrency.overshooting).length,
    },
    recentTasks,
  };
}

export function registerDashboardRoutes(app: Express, database: AppDatabase): void {
  app.get("/api/dashboard", (_request: Request, response: Response) => {
    response.json({ summary: getDashboardSummary(database) });
  });
}
