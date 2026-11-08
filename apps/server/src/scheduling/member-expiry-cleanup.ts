import type { AppDatabase } from "@emby-task-center/database/client";
import type { EmbyClient } from "../integrations/emby-client";
import type { Logger } from "../logging/logger";
import { safeError } from "../logging/safe-error";
import { sweepMemberExpiryCleanup } from "../subscriptions/member-expiry-cleanup";
import { sweepMemberInactivityCleanup } from "../subscriptions/member-inactivity-cleanup";
import { createSingleRoundRunner } from "./single-round-runner";

export const MEMBER_EXPIRY_CLEANUP_INTERVAL_MS = 5 * 60_000;

export function startMemberExpiryCleanup(
  database: AppDatabase,
  emby: EmbyClient | undefined,
  logger: Logger,
): () => void {
  return startMemberCleanup(database, emby, logger, sweepMemberExpiryCleanup, "expiry", "过期会员清理");
}

export function startMemberInactivityCleanup(
  database: AppDatabase,
  emby: EmbyClient | undefined,
  logger: Logger,
): () => void {
  return startMemberCleanup(database, emby, logger, sweepMemberInactivityCleanup, "inactivity", "保号清理");
}

function startMemberCleanup(
  database: AppDatabase,
  emby: EmbyClient | undefined,
  logger: Logger,
  sweep: typeof sweepMemberExpiryCleanup,
  kind: "expiry" | "inactivity",
  label: string,
): () => void {
  let stopped = false;
  const progress = { lastLinkedMemberId: 0 };
  const runner = createSingleRoundRunner(async () => {
    try {
      const result = await sweep(database, emby, new Date(), () => !stopped, progress);
      if (!stopped && (result.deleted || result.pending || result.skipped)) {
        logger.info({
          event: `member_${kind}_cleanup_completed`,
          message: `${label}检查完成`,
          detail: JSON.stringify(result),
        });
      }
    } catch (error) {
      if (!stopped)
        logger.warn({
          event: `member_${kind}_cleanup_failed`,
          message: `${label}检查失败`,
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
