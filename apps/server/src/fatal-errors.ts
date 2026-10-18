import { writeSync } from "node:fs";
import type { Logger, LogEvent } from "./logging/logger";
import { safeError } from "./logging/safe-error";

type FatalKind = "uncaught_exception" | "unhandled_rejection";

interface FatalErrorOptions {
  logger: Pick<Logger, "error" | "close">;
  /** 与正常日志使用同一份设置密钥脱敏器；失败时不输出原始错误。 */
  redact: (text: string) => string;
  process?: Pick<NodeJS.Process, "on" | "off">;
  writeStderr?: (text: string) => void;
  exit?: (code: number) => void;
}

/** 致命异常不能继续提供服务，也不能等待异步关闭；由外部服务管理器重启。 */
export function installFatalErrorHandlers(options: FatalErrorOptions): () => void {
  const target = options.process ?? process;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const writeStderr = options.writeStderr ?? ((text: string) => writeSync(2, text));
  let handling = false;

  function terminate(kind: FatalKind, reason: unknown): void {
    if (handling) {
      exit(1);
      return;
    }
    handling = true;
    let error = "错误详情不可用";
    try {
      error = options
        .redact(safeError(reason))
        .replace(/https?:\/\/[^\s]+/gi, "[URL 已隐藏]")
        .replace(/((?:password|token|secret|api[_-]?key|authorization)\s*[:=]\s*)[^\s,;]+/gi, "$1[已隐藏]")
        .replace(/[\r\n\t]/g, " ")
        .slice(0, 500);
    } catch {
      // 非 Error 的 toString 或设置脱敏器也可能抛错，绝不能递归记录原始值。
    }
    const event: LogEvent = {
      event: kind,
      message: kind === "uncaught_exception" ? "未捕获的同步异常，进程退出" : "未处理的异步异常，进程退出",
      detail: JSON.stringify({ error, exitCode: 1 }),
    };
    // 先写同步 stderr，避免立即退出时异步控制台/数据库日志尚未落盘。
    try {
      writeStderr(`${JSON.stringify({ event: kind, level: "error", source: "server", exitCode: 1 })}\n`);
    } catch {
      // stderr 不可写仍必须退出。
    }
    try {
      try {
        options.logger.error(event);
      } catch {
        // 记录器故障不能阻止退出或再次调用记录器。
      }
      try {
        options.logger.close?.();
      } catch {
        // 只尝试同步、无锁等待的日志清理；不启动正常异步 shutdown。
      }
    } finally {
      exit(1);
    }
  }

  const uncaught = (error: Error) => terminate("uncaught_exception", error);
  const rejected = (reason: unknown) => terminate("unhandled_rejection", reason);
  target.on("uncaughtException", uncaught);
  target.on("unhandledRejection", rejected);
  return () => {
    target.off("uncaughtException", uncaught);
    target.off("unhandledRejection", rejected);
  };
}
