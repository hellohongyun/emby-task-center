import { randomUUID } from "node:crypto";
import type { LogLevel, Logger } from "./logger";

export type WorkflowLogger = Pick<Logger, LogLevel>;
export type WorkflowLog = ReturnType<typeof workflowLog>;

export function workflowLog(logger: WorkflowLogger | undefined, module: string, runId: string = randomUUID()) {
  return {
    runId,
    write(level: LogLevel, event: string, message: string, detail?: Record<string, unknown>, durationMs?: number) {
      if (!logger) return;
      logger[level]({
        module,
        runId,
        event,
        message,
        ...(detail ? { detail: JSON.stringify(detail) } : {}),
        ...(durationMs === undefined ? {} : { durationMs }),
      });
    },
  };
}
