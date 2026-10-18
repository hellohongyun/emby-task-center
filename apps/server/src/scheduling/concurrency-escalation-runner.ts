import type { Logger } from "../logging/logger";
import type { EscalationOutcome } from "../subscriptions/concurrency-escalation";

/** Drop ticks while the previous escalation round is still applying account changes. */
export function createConcurrencyEscalationRunner(execute: () => Promise<EscalationOutcome>, logger: Logger) {
  let running = false;
  let stopped = false;

  return {
    async run(): Promise<void> {
      if (running || stopped) return;
      running = true;
      try {
        const outcome = await execute();
        if (outcome.failures.length) {
          logger.warn({
            event: "concurrency_escalation_failed",
            message: outcome.failures.map((item) => `${item.email}：${item.reason}`).join("；"),
          });
        }
        if (outcome.reasserted.length) {
          logger.warn({
            event: "concurrency_freeze_reasserted",
            message: `冻结期内停用位被改回启用、已重新停用：${outcome.reasserted.join("、")}`,
          });
        }
        if (!outcome.reminded.length && !outcome.frozen.length && !outcome.released.length) return;
        logger.info({
          event: "concurrency_escalation",
          message: [
            outcome.reminded.length ? `提醒 ${outcome.reminded.join("、")}` : "",
            outcome.frozen.length ? `冻结 ${outcome.frozen.join("、")}` : "",
            outcome.released.length ? `解冻 ${outcome.released.join("、")}` : "",
            outcome.terminated ? `断开 ${outcome.terminated} 个会话/设备` : "",
          ]
            .filter(Boolean)
            .join("；"),
        });
      } finally {
        running = false;
      }
    },
    stop(): void {
      stopped = true;
    },
  };
}
