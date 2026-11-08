import type { AppDatabase } from "@emby-task-center/database/client";
import { sweepExpiredMediaRequests } from "../media-requests/retention";
import type { Logger } from "../logging/logger";
import { safeError } from "../logging/safe-error";

export const MEDIA_REQUEST_RETENTION_INTERVAL_MS = 60 * 60_000;

/** Start with one bounded sweep, then hourly; stop never starts or queues another round. */
export function startMediaRequestRetention(database: AppDatabase, logger: Logger): () => void {
  let stopped = false;
  let running = false;
  async function run() {
    if (stopped || running) return;
    running = true;
    try {
      const deleted = await sweepExpiredMediaRequests(database, new Date());
      if (!stopped && deleted > 0)
        logger.info({
          event: "media_request_retention_completed",
          message: "已入库求片申请保留期清理完成",
          detail: JSON.stringify({ deleted }),
        });
    } catch (error) {
      if (!stopped)
        logger.error({
          event: "media_request_retention_failed",
          message: "已入库求片申请保留期清理失败",
          detail: JSON.stringify({ error: safeError(error) }),
        });
    } finally {
      running = false;
    }
  }
  const timer = setInterval(() => void run(), MEDIA_REQUEST_RETENTION_INTERVAL_MS);
  timer.unref?.();
  void run();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
