import { z } from "zod";
export const MEDIA_REQUEST_RETENTION_DAYS = 7;

export const mediaRequestStatuses = ["pending", "processing", "available", "unavailable"] as const;
export type MediaRequestStatus = (typeof mediaRequestStatuses)[number];
export type MediaRequestKind = "request" | "supplement";
export const mediaRequestStatusLabels: Record<MediaRequestStatus, string> = {
  pending: "待处理",
  processing: "处理中",
  available: "已入库",
  unavailable: "暂无法提供",
};

export const mediaRequestCreateSchema = z
  .object({
    kind: z.enum(["request", "supplement"]),
    mediaType: z.enum(["movie", "tv"]),
    tmdbId: z.number().int().positive(),
    seasonNumber: z.number().int().min(0).max(9999).nullable().optional(),
    description: z.string().trim().max(2000).default(""),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.mediaType === "movie" && value.seasonNumber != null)
      ctx.addIssue({ code: "custom", message: "电影不能选择季", path: ["seasonNumber"] });
    if (value.mediaType === "tv" && value.seasonNumber == null)
      ctx.addIssue({ code: "custom", message: "剧集必须选择季", path: ["seasonNumber"] });
    if (value.kind === "supplement" && (value.mediaType !== "tv" || !value.description))
      ctx.addIssue({ code: "custom", message: "补集申请需选择剧集并填写缺集说明", path: ["description"] });
  });
export type MediaRequestCreate = z.infer<typeof mediaRequestCreateSchema>;
export interface MediaRequest {
  id: number;
  kind: MediaRequestKind;
  mediaType: "movie" | "tv";
  tmdbId: number;
  seasonNumber: number | null;
  title: string;
  originalTitle: string;
  releaseYear: number | null;
  posterUrl: string | null;
  description: string;
  status: MediaRequestStatus;
  adminNote: string;
  createdAt: string;
  updatedAt: string;
  availableAt?: string | null;
}
export interface AdminMediaRequest extends MediaRequest {
  memberEmail: string;
}
export interface MediaRequestPage<T extends MediaRequest = MediaRequest> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}
