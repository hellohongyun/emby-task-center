/**
 * 任务路由的校验 schema 与共享小工具（P4：从 routes/tasks.ts 抽出，行为不变）。
 *
 * 只放"不是路由"的东西：zod schema、任务 ID 解析、以及把"改一个任务"的公共响应逻辑收在一处的 mutateTask。
 */
import type { Express, Request, Response } from "express";
import { z } from "zod";

import type { AppDatabase } from "@emby-task-center/database/client";
import { cancelTask, getTask } from "@emby-task-center/task-domain/task-service";

export type { Express, Request };

/**
 * 新建任务（完结入库）：任务中心唯一的创建入口 —— 追更（follow）已经整体下线，
 * 现在建的只有"把 TMDB 已播而 Emby 库里缺的集补齐"这一种任务。
 */
export const CreateTaskSchema = z.strictObject({
  tmdbId: z.number().int().positive(),
  title: z.string().trim().min(1).max(200),
  mediaType: z.enum(["tv", "movie"]).default("tv"),
  seasonNumber: z.number().int().min(0).max(100).nullable().optional(),
});
export const BatchDeleteSchema = z.strictObject({ taskIds: z.array(z.number().int().positive()).min(1).max(100) });

/**
 * 改绑 TMDB 条目（任务看板行内「改绑」）。
 *
 * `tmdbId` 必填；`mediaType` / `title` 只在"手填 id"这条路径上用得上：
 * TMDB 查得到就用 TMDB 的标题与类型，查不到（或暂时不可用）时用 title 兜底，元数据等下次同步补齐。
 */
export const RebindTmdbSchema = z.strictObject({
  tmdbId: z.number().int().positive(),
  mediaType: z.enum(["tv", "movie"]).optional(),
  title: z.string().trim().min(1).max(200).optional(),
});
export const ProgressSchema = z.strictObject({ airProgress: z.number().int().nonnegative() });
export const SeasonSchema = z.strictObject({ seasonNumber: z.number().int().min(0).max(100).nullable() });
export const ScheduleSchema = z.strictObject({
  days: z.array(z.number().int().min(0).max(6)).max(7),
  time: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
    .nullable(),
});
export const FolderMappingSchema = z.strictObject({
  rootId: z.string().min(1),
  folderPath: z
    .string()
    .min(1)
    .refine((value) => !value.startsWith("/") && !value.includes(".."), { message: "invalid_path" }),
  sourceMode: z.enum(["auto", "mapped"]).optional(),
});

export function mutateTask(
  value: string,
  response: Response,
  database: AppDatabase,
  mutation: (database: AppDatabase, taskId: number) => ReturnType<typeof cancelTask>,
): void {
  const taskId = readTaskId(value);
  if (!taskId) return void response.status(400).json({ error: "invalid_task_id" });
  if (!getTask(database, taskId)) return void response.status(404).json({ error: "task_not_found" });
  const task = mutation(database, taskId);
  if (!task) return void response.status(409).json({ error: "invalid_task_state" });
  response.json(task);
}

export function readTaskId(value: string): number | null {
  const taskId = Number(value);
  return Number.isInteger(taskId) && taskId > 0 ? taskId : null;
}
