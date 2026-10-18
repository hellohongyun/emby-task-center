import { eq } from "drizzle-orm";

import type { AppDatabase } from "@emby-task-center/database/client";
import { mediaItems, mediaTasks } from "@emby-task-center/database/schema";

// 任务收件人（task_notification_recipients 的增删改查 + 任务详情的 recipients 字段）
// 随「任务更新通知」整条链删除（2026-09）：它唯一的消费方是 email-service 的任务更新邮件，
// 而那个发送方在追更下线后已经没有调用方，留着只会让人以为"填了邮箱就会收到邮件"。
// 全局收件人（global_notification_recipients）同理，见 notifications/ 与 routes/integrations.ts。

/** 读取任务的 TMDB 别名（手动匹配名覆盖）。 */
export function readTaskAliases(database: AppDatabase, taskId: number): string[] {
  const row = database
    .select({ mediaItemId: mediaTasks.mediaItemId })
    .from(mediaTasks)
    .where(eq(mediaTasks.id, taskId))
    .get();
  if (!row) return [];
  return (
    database.select({ aliases: mediaItems.aliases }).from(mediaItems).where(eq(mediaItems.id, row.mediaItemId)).get()
      ?.aliases ?? []
  );
}

/** 替换任务的 TMDB 别名（手动匹配名覆盖）。 */
export function saveTaskAliases(database: AppDatabase, taskId: number, aliases: string[]): string[] {
  const row = database
    .select({ mediaItemId: mediaTasks.mediaItemId })
    .from(mediaTasks)
    .where(eq(mediaTasks.id, taskId))
    .get();
  if (!row) throw new Error("task_not_found");
  const normalized = [...new Set(aliases.map((alias) => alias.trim()).filter(Boolean))];
  database
    .update(mediaItems)
    .set({ aliases: normalized, updatedAt: new Date().toISOString() })
    .where(eq(mediaItems.id, row.mediaItemId))
    .run();
  return normalized;
}
