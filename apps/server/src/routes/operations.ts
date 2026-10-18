import type { Express } from "express";
import { desc, eq } from "drizzle-orm";

import type { AppDatabase } from "@emby-task-center/database/client";
import { mediaItems, mediaTasks, taskRuns } from "@emby-task-center/database/schema";
import type { LibraryService } from "../library/service";

export interface OperationsRouteOptions {
  database: AppDatabase;
  library: LibraryService;
}

// P3：位置参数改为选项对象（_notifyQueue 占位已无人使用，直接删除）。
export function registerOperationsRoutes(app: Express, options: OperationsRouteOptions): void {
  const { database, library } = options;
  app.get("/api/activity", (_request, response) => {
    const activity = database
      .select({
        id: taskRuns.id,
        taskId: taskRuns.taskId,
        title: mediaItems.title,
        phase: taskRuns.phase,
        workerId: taskRuns.workerId,
        startedAt: taskRuns.startedAt,
        finishedAt: taskRuns.finishedAt,
        summary: taskRuns.summary,
        error: taskRuns.error,
      })
      .from(taskRuns)
      .innerJoin(mediaTasks, eq(mediaTasks.id, taskRuns.taskId))
      .innerJoin(mediaItems, eq(mediaItems.id, mediaTasks.mediaItemId))
      .orderBy(desc(taskRuns.id))
      .limit(100)
      .all();
    response.json({ activity });
  });

  app.get("/api/system/status", (_request, response) => {
    const roots = library.listRoots();
    const lastScanAt =
      roots
        .flatMap((root) => (root.lastScannedAt ? [root.lastScannedAt] : []))
        .sort()
        .at(-1) ?? null;
    response.json({
      rootCount: roots.length,
      lastScanAt,
      serverTime: new Date().toISOString(),
      serverTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      // mcp / notifyQueue 相关字段已随通知队列与 MCP 功能删除。
    });
  });
}
