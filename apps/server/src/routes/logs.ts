import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Express } from "express";
import { and, asc, desc, eq, gt, isNotNull, isNull, like, lt, lte, or, type SQL } from "drizzle-orm";
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
    const { before, after } = request.query;
    const cursor = readCursor(after);
    if (after !== undefined && (cursor === undefined || before !== undefined)) {
      response.status(400).json({ error: "invalid_cursor" });
      return;
    }
    const conditions = filters(request.query);
    const highWater = latestId(database);
    conditions.push(lte(logs.id, highWater));
    const olderThan = readCursor(before);
    if (olderThan) conditions.push(lt(logs.id, olderThan));
    if (cursor !== undefined) conditions.push(gt(logs.id, cursor));
    const limit = readLimit(request.query.limit);

    const rows = database
      .select()
      .from(logs)
      .where(and(...conditions))
      .orderBy(cursor === undefined ? desc(logs.id) : asc(logs.id))
      .limit(limit + 1)
      .all();
    const hasMore = rows.length > limit;
    if (hasMore) rows.pop();
    const nextAfter = cursor !== undefined && hasMore ? (rows.at(-1)?.id ?? cursor) : highWater;
    response.set("Cache-Control", "no-store").json({ logs: rows, hasMore, nextAfter });
  });

  app.get("/api/logs/download", async (request, response) => {
    const highWater = latestId(database);
    const conditions = [...filters(request.query), lte(logs.id, highWater)];
    const filename = `emby-system-${new Date().toISOString().slice(0, 10)}.log`;
    response.set({
      "Cache-Control": "no-store",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Type": "text/plain; charset=utf-8",
    });

    async function* lines() {
      let after = 0;
      while (after < highWater && !response.destroyed) {
        const rows = database
          .select()
          .from(logs)
          .where(and(...conditions, gt(logs.id, after)))
          .orderBy(asc(logs.id))
          .limit(maxLimit)
          .all();
        if (!rows.length) return;
        for (const row of rows) yield downloadLine(row);
        after = rows.at(-1)!.id;
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }

    try {
      await pipeline(Readable.from(lines()), response);
    } catch (error) {
      if (!response.destroyed) throw error;
    }
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
      module: "web",
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

function latestId(database: AppDatabase): number {
  return database.select({ id: logs.id }).from(logs).orderBy(desc(logs.id)).limit(1).get()?.id ?? 0;
}

function filters(query: Record<string, unknown>): (SQL | undefined)[] {
  const conditions: (SQL | undefined)[] = [];
  const level = z.enum(logLevels).safeParse(query.level);
  if (level.success) conditions.push(eq(logs.level, level.data));
  const source = z.enum(logSources).safeParse(query.source);
  if (source.success) conditions.push(eq(logs.source, source.data));
  if (typeof query.module === "string" && query.module.trim()) {
    const module = query.module.trim();
    const exact = eq(logs.module, module);
    if (module === "http") {
      conditions.push(or(exact, and(isNull(logs.module), eq(logs.source, "server"), isNotNull(logs.method))));
    } else if (module === "server") {
      conditions.push(or(exact, and(isNull(logs.module), eq(logs.source, "server"), isNull(logs.method))));
    } else if (module === "web") {
      conditions.push(or(exact, and(isNull(logs.module), eq(logs.source, "web"))));
    } else conditions.push(exact);
  }
  if (typeof query.runId === "string" && query.runId.trim()) conditions.push(eq(logs.runId, query.runId.trim()));
  if (typeof query.q === "string" && query.q.trim()) {
    const pattern = `%${query.q.trim()}%`;
    conditions.push(
      or(like(logs.message, pattern), like(logs.path, pattern), like(logs.detail, pattern), like(logs.event, pattern)),
    );
  }
  return conditions;
}

function readCursor(value: unknown): number | undefined {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return undefined;
  const cursor = Number(value);
  return Number.isSafeInteger(cursor) ? cursor : undefined;
}

function downloadLine(row: typeof logs.$inferSelect): string {
  const module = row.module ?? (row.source === "server" && row.method ? "http" : row.source);
  const values = [
    row.createdAt,
    module,
    row.level.toUpperCase(),
    row.message,
    row.runId && `run=${row.runId}`,
    row.event && `event=${row.event}`,
    row.method,
    row.path,
    row.status,
    row.durationMs == null ? null : `${row.durationMs}ms`,
    row.detail,
  ];
  return (
    values
      .filter((value) => value != null && value !== "")
      .map((value) => String(value).replace(/[\r\n\t]+/g, " "))
      .join("\t") + "\n"
  );
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
