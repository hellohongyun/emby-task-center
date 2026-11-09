import type { AppDatabase } from "@emby-task-center/database/client";
import {
  isTgtoDriveShare115Configured,
  transfer115Share,
  type TgtoDriveShare115Result,
} from "../integrations/tgtodrive-share115";
import type { Logger } from "../logging/logger";
import type { RuntimeSettings } from "../settings/runtime";
import { claimShare115Job, completeShare115Job, recoverExpiredShare115Jobs } from "./store";

const pollIntervalMs = 3_000;
const leaseMs = 60_000;

export function startShare115Worker(options: {
  database: AppDatabase;
  readConfig(): RuntimeSettings["share115"];
  logger: Pick<Logger, "info" | "warn" | "error">;
}) {
  const { database, readConfig, logger } = options;
  let stopped = false;
  let active: Promise<void> | undefined;
  let controller: AbortController | undefined;

  function configured() {
    const config = readConfig();
    if (!config.enabled || !isTgtoDriveShare115Configured(config.baseUrl, config.token)) return undefined;
    return config;
  }

  async function run() {
    const now = new Date();
    const recovered = recoverExpiredShare115Jobs(database, now.toISOString());
    if (recovered) {
      logger.warn({
        module: "share_115",
        event: "share_115_result_unconfirmed",
        message: "115 转存任务中断，结果待确认",
        detail: JSON.stringify({ count: recovered }),
      });
    }
    const config = configured();
    if (!config) return;

    const leaseExpiresAt = new Date(now.getTime() + leaseMs).toISOString();
    const job = claimShare115Job(database, { now: now.toISOString(), leaseExpiresAt });
    if (!job) return;
    controller = new AbortController();
    let result: TgtoDriveShare115Result;
    try {
      result = await transfer115Share({ ...config, shareUrl: job.shareUrl, signal: controller.signal });
    } catch {
      result = { status: "unconfirmed", resultCode: "TRANSFER_INTERRUPTED", resultMessage: "转存中断，结果待确认" };
    } finally {
      controller = undefined;
    }

    const { identifiedMedia, ...outcome } = result;
    const updated = completeShare115Job(database, {
      id: job.id,
      leaseExpiresAt,
      now: new Date().toISOString(),
      ...outcome,
      identifiedMediaJson: identifiedMedia ? JSON.stringify(identifiedMedia) : undefined,
    });
    if (updated) {
      logger.info({
        module: "share_115",
        event: "share_115_transfer_finished",
        message: "115 转存任务已更新",
        detail: JSON.stringify({ jobId: job.id, status: result.status }),
      });
    }
  }

  function wake() {
    if (stopped || active) return;
    active = run()
      .catch(() => {
        logger.error({ module: "share_115", event: "share_115_worker_failed", message: "115 转存队列执行失败" });
      })
      .finally(() => {
        active = undefined;
      });
  }

  const timer = setInterval(wake, pollIntervalMs);
  timer.unref();
  wake();
  return {
    accepting: () => !stopped && Boolean(configured()),
    wake,
    stop() {
      stopped = true;
      clearInterval(timer);
      controller?.abort();
    },
    async close() {
      await active;
    },
  };
}
