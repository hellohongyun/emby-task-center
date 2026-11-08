import { MEDIA_REQUEST_RETENTION_DAYS, type MediaRequest } from "@emby-task-center/contracts/media-request";

export const mediaRequestRetentionNotice = `已入库申请保留 ${MEDIA_REQUEST_RETENTION_DAYS} 天后自动删除`;

export function mediaRequestRemovalTime(item: MediaRequest): string | null {
  if (item.status !== "available" || !item.availableAt) return null;
  const timestamp = Date.parse(item.availableAt);
  if (!Number.isFinite(timestamp)) return null;
  const removal = new Date(timestamp + MEDIA_REQUEST_RETENTION_DAYS * 86_400_000);
  return Number.isFinite(removal.getTime()) ? removal.toISOString() : null;
}
