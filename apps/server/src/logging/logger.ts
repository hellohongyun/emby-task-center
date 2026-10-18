import type { RequestHandler } from "express";
import type { AppDatabase } from "@emby-task-center/database/client";
import { describeRequest } from "./describe";
import { createLogWriter } from "./log-writer";

export type LogLevel = "info" | "warn" | "error";
export type LogSource = "server" | "web";

export interface LogEvent {
  event?: string;
  level?: LogLevel;
  source?: LogSource;
  message?: string;
  method?: string | null;
  path?: string | null;
  status?: number | null;
  durationMs?: number | null;
  detail?: string | null;
}

export interface LoggerOptions {
  /** 生产环境使用独立、遇锁立即返回的日志连接，避免扫描写锁阻塞 HTTP 事件循环。 */
  databasePath?: string;
  retentionDays?: number;
  maxRows?: number;
  /** 日志脱敏：写库与前打印前对 message/detail 做一次替换（P1：抹掉设置里的密钥明文）。 */
  redact?: (text: string) => string;
}

export interface Logger {
  info(event: LogEvent): void;
  warn(event: LogEvent): void;
  error(event: LogEvent): void;
  request: RequestHandler;
  /** 关闭独立日志连接；不关闭调用方传入的数据库。 */
  close?(): void;
}

const defaultRetentionDays = 7;
const defaultMaxRows = 5_000;
const maxMessageLength = 500;
const maxDetailLength = 2_000;

export function createLogger(database: AppDatabase, options: LoggerOptions = {}): Logger {
  const retentionDays = options.retentionDays ?? defaultRetentionDays;
  const maxRows = options.maxRows ?? defaultMaxRows;
  const redact = options.redact ?? ((text: string) => text);
  const writer = createLogWriter(database, { databasePath: options.databasePath, retentionDays, maxRows });

  function write(level: LogLevel, event: LogEvent): void {
    const source = event.source ?? "server";
    const createdAt = new Date().toISOString();
    const row = {
      level,
      source,
      message: truncate(redact(event.message ?? event.event ?? ""), maxMessageLength),
      method: event.method ?? null,
      path: event.path ?? null,
      status: event.status ?? null,
      durationMs: event.durationMs ?? null,
      detail: event.detail == null ? null : truncate(redact(event.detail), maxDetailLength),
      createdAt,
    };
    writer.write(row);
    const output = {
      ...event,
      level,
      source,
      createdAt,
      ...(event.message ? { message: redact(event.message) } : {}),
      ...(event.detail ? { detail: redact(event.detail) } : {}),
    };
    if (level === "warn") console.warn(JSON.stringify(output));
    else if (level === "error") console.error(JSON.stringify(output));
    else console.info(JSON.stringify(output));
  }

  const request: RequestHandler = (request, response, next) => {
    const requestPath = request.path;
    if (requestPath === "/health" || requestPath === "/api/logs") return next();
    if (!requestPath.startsWith("/api")) return next();
    const startedAt = Date.now();
    let recorded = false;
    response.once("finish", () => {
      if (recorded) return;
      recorded = true;
      const status = response.statusCode;
      const level: LogLevel = status < 400 ? "info" : status < 500 ? "warn" : "error";
      write(level, {
        event: "request",
        source: "server",
        message: describeRequest(request.method, requestPath),
        method: request.method,
        path: requestPath,
        status,
        durationMs: Date.now() - startedAt,
      });
    });
    response.once("close", () => {
      if (recorded) return;
      recorded = true;
      write("warn", {
        event: "request_aborted",
        source: "server",
        message: `请求连接中断：${describeRequest(request.method, requestPath)}`,
        method: request.method,
        path: requestPath,
        status: null,
        durationMs: Date.now() - startedAt,
      });
    });
    next();
  };

  return {
    info: (event) => write("info", event),
    warn: (event) => write("warn", event),
    error: (event) => write("error", event),
    request,
    close: () => writer.close(),
  };
}

function truncate(value: string, maxLength: number): string;
function truncate(value: string | null | undefined, maxLength: number): string | null;
function truncate(value: string | null | undefined, maxLength: number): string | null {
  if (value == null) return null;
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}
