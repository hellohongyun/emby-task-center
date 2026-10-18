import type { Express } from "express";
import { and, desc, eq, like, lt, or, type SQL } from "drizzle-orm";
import { z } from "zod";

import type { AppDatabase } from "@emby-task-center/database/client";
import { logs } from "@emby-task-center/database/schema";
import type { AppLogger } from "../app";

const logLevels = ["info", "warn", "error"] as const;
// 只有服务端与前端会写日志：MCP 来源随 MCP 功能删除（表结构的 CHECK 约束保留，不重建库）。
const logSources = ["server", "web"] as const;

const WebLogSchema = z
  .object({
    level: z.enum(logLevels),
    source: z.literal("web"),
    message: z.string(),
    method: z.string().optional(),
    path: z.string().optional(),
    status: z.number().optional(),
    durationMs: z.number().optional(),
    detail: z.string().optional(),
  })
  .strict();

const LogBatchSchema = z
  .object({
    logs: z.array(WebLogSchema).max(100),
  })
  .strict();

const defaultLimit = 100;
const maxLimit = 500;
const maxMessageLength = 500;
const maxDetailLength = 2_000;

export function registerLogRoutes(app: Express, database: AppDatabase, _logger?: AppLogger): void {
  app.get("/api/logs", (request, response) => {
    const conditions: (SQL | undefined)[] = [];
    const level = z.enum(logLevels).safeParse(request.query.level);
    if (level.success) conditions.push(eq(logs.level, level.data));
    const source = z.enum(logSources).safeParse(request.query.source);
    if (source.success) conditions.push(eq(logs.source, source.data));
    if (typeof request.query.q === "string" && request.query.q.trim()) {
      const pattern = `%${request.query.q}%`;
      conditions.push(or(like(logs.message, pattern), like(logs.path, pattern)));
    }
    const before = Number(request.query.before);
    if (Number.isSafeInteger(before) && before > 0) conditions.push(lt(logs.id, before));
    const limit = readLimit(request.query.limit);

    const rows = database
      .select()
      .from(logs)
      .where(and(...conditions))
      .orderBy(desc(logs.id))
      .limit(limit)
      .all();
    response.json({ logs: rows });
  });

  app.post("/api/logs", (request, response) => {
    const parsed = LogBatchSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: "invalid_request" });
      return;
    }
    const rows = parsed.data.logs.map((entry) => ({
      level: entry.level,
      source: entry.source,
      message: truncate(entry.message, maxMessageLength),
      method: entry.method ?? null,
      path: entry.path ?? null,
      status: entry.status ?? null,
      durationMs: entry.durationMs ?? null,
      detail: truncate(entry.detail ?? null, maxDetailLength),
      createdAt: new Date().toISOString(),
    }));
    if (rows.length > 0) database.insert(logs).values(rows).run();
    response.status(201).json({ accepted: rows.length });
  });
}

function readLimit(value: unknown): number {
  const parsed = typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 1) return defaultLimit;
  return Math.min(parsed, maxLimit);
}

function truncate(value: string, maxLength: number): string;
function truncate(value: string | null | undefined, maxLength: number): string | null;
function truncate(value: string | null | undefined, maxLength: number): string | null {
  if (value == null) return null;
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}
