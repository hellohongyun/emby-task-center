import type { AppDatabase } from "@emby-task-center/database/client";
import type { EmbyClient } from "../integrations/emby-client";
import type { Logger } from "../logging/logger";
import { safeError } from "../logging/safe-error";
import { sweepMemberExpiryCleanup } from "../subscriptions/member-expiry-cleanup";
import { createSingleRoundRunner } from "./single-round-runner";

export const MEMBER_EXPIRY_CLEANUP_INTERVAL_MS = 5 * 60_000;

export function startMemberExpiryCleanup(
  database: AppDatabase,
  emby: EmbyClient | undefined,
  logger: Logger,
): () => void {
  let stopped = false;
  const progress = { lastLinkedMemberId: 0 };
  const runner = createSingleRoundRunner(async () => {
    try {
      const result = await sweepMemberExpiryCleanup(database, emby, new Date(), () => !stopped, progress);
      if (!stopped && (result.deleted || result.pending || result.skipped)) {
        logger.info({
          event: "member_expiry_cleanup_completed",
          message: "过期会员清理检查完成",
          detail: JSON.stringify(result),
        });
      }
    } catch (error) {
      if (!stopped)
        logger.warn({
          event: "member_expiry_cleanup_failed",
          message: "过期会员清理检查失败",
          detail: safeError(error),
        });
    }
  });
  const interval = setInterval(() => void runner.run(), MEMBER_EXPIRY_CLEANUP_INTERVAL_MS);
  interval.unref?.();
  void runner.run();
  return () => {
    stopped = true;
    runner.stop();
    clearInterval(interval);
  };
}
