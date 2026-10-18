import { z } from "zod";
import { MediaTypeSchema } from "./media";

// 追更（follow）任务类型已整体下线（2026-09）：库里只剩「完结入库」一种任务。
export const TaskTypeSchema = z.enum(["ingest"]);

export const TaskStatusSchema = z.enum(["pending", "claimed", "running", "completed", "failed", "cancelled"]);

export const CreateTaskSchema = z
  .object({
    mediaType: MediaTypeSchema,
    taskType: TaskTypeSchema,
    title: z.string().trim().min(1),
    tmdbId: z.number().int().positive(),
    /** 分季剧集：可指定指向第几季（1 起）；不填则按整剧所有季合计。 */
    seasonNumber: z.number().int().min(0).max(100).optional(),
    /** 完结入库内容类型：series=剧集完结 / variety=综艺完结（仅 TV + ingest 使用）。 */
    contentKind: z.enum(["series", "variety"]).optional(),
  })
  .superRefine(({ mediaType, taskType, seasonNumber, contentKind }, context) => {
    if (mediaType === "movie" && seasonNumber != null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Movies cannot use a season number.",
        path: ["seasonNumber"],
      });
    }
    if (contentKind != null && !(mediaType === "tv" && taskType === "ingest")) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Content kind is only valid for finished TV/variety ingest tasks.",
        path: ["contentKind"],
      });
    }
  });

export type TaskType = z.infer<typeof TaskTypeSchema>;
export type TaskStatus = z.infer<typeof TaskStatusSchema>;
export type CreateTaskInput = z.infer<typeof CreateTaskSchema>;
