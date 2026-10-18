import type { Express } from "express";
import { z } from "zod";
import { eq } from "drizzle-orm";

import type { AppDatabase } from "@emby-task-center/database/client";
import { mediaItems, mediaTasks } from "@emby-task-center/database/schema";
import { getTask } from "@emby-task-center/task-domain/task-service";
import { readTaskAliases, saveTaskAliases } from "../automation/task-settings";
import { type LibraryService } from "../library/service";

const AliasListSchema = z.strictObject({ aliases: z.array(z.string().trim().min(1).max(200)).max(20) });

export interface TaskSettingsRouteOptions {
  database: AppDatabase;
  library?: LibraryService | undefined;
}

// P3：位置参数改为选项对象（notifier 占位已无人使用，直接删除）。
// 任务收件人（POST/DELETE /recipients）随「任务更新通知」整条链删除（2026-09）：
// 那条邮件链已经没有发送方，接口留着也只是让人填一个不会生效的邮箱。
export function registerTaskSettingsRoutes(app: Express, options: TaskSettingsRouteOptions): void {
  const { database, library } = options;
  app.get("/api/tasks/:taskId/settings", (request, response) => {
    const taskId = readId(request.params.taskId);
    if (!taskId || !getTask(database, taskId)) return void response.status(404).json({ error: "task_not_found" });
    response.json({ aliases: readTaskAliases(database, taskId) });
  });

  app.put("/api/tasks/:taskId/aliases", (request, response) => {
    const taskId = readId(request.params.taskId);
    const parsed = AliasListSchema.safeParse(request.body);
    if (!taskId || !parsed.success) return void response.status(400).json({ error: "invalid_request" });
    if (!getTask(database, taskId)) return void response.status(404).json({ error: "task_not_found" });
    try {
      const aliases = saveTaskAliases(database, taskId, parsed.data.aliases);
      // 立即从数据库现有库存匹配（别名优先），并后台扫描一次补新文件
      const mediaItemId =
        database.select({ id: mediaTasks.mediaItemId }).from(mediaTasks).where(eq(mediaTasks.id, taskId)).get()?.id ??
        null;
      if (mediaItemId) {
        const mediaItem = database.select().from(mediaItems).where(eq(mediaItems.id, mediaItemId)).get();
        if (mediaItem) library?.matchInventory(mediaItem);
      }
      void library?.scanEnabledRoots().catch(() => undefined);
      response.json({ aliases });
    } catch (error) {
      response.status(400).json({ error: (error as Error).message });
    }
  });

  app.post("/api/tasks/:taskId/notify-agent", (request, response) => {
    // AI 通知已移除：保留端点但恒返回“未配置”，避免破坏前端调用。
    return void response.status(409).json({ error: "agent_webhook_not_configured" });
  });
}

function readId(value: string): number | null {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}
