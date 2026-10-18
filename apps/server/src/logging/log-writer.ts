import BetterSqlite3 from "better-sqlite3";
import { count, lt, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { AppDatabase } from "@emby-task-center/database/client";
import { logs, schema } from "@emby-task-center/database/schema";

interface LogWriterOptions {
  databasePath?: string;
  retentionDays: number;
  maxRows: number;
}

export interface LogWriter {
  write(row: typeof logs.$inferInsert): void;
  close(): void;
}

const cleanupIntervalMs = 60_000;
const retryDelayMs = 50;
const maxPendingRows = 1_000;
const maxBatchRows = 50;

function isLocked(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth++) {
    const { code, cause } = current as { code?: string; cause?: unknown };
    if (typeof code === "string" && (code.startsWith("SQLITE_BUSY") || code.startsWith("SQLITE_LOCKED"))) return true;
    current = cause;
  }
  return false;
}

function report(event: string, error: unknown): void {
  console.error(JSON.stringify({ event, error: error instanceof Error ? error.message : String(error) }));
}

/** 独立连接不等待扫描进程的写锁；不跑迁移、不调整调用方连接的 busy_timeout。 */
export function createLogWriter(database: AppDatabase, options: LogWriterOptions): LogWriter {
  const sqlite = options.databasePath ? new BetterSqlite3(options.databasePath, { timeout: 0 }) : null;
  const target = sqlite ? drizzle(sqlite, { schema }) : database;
  const pending: Array<typeof logs.$inferInsert> = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastCleanupAt = 0;
  let cleanupPending = true;
  let droppedRows = 0;
  let closed = false;

  function cleanup(): boolean {
    if (!cleanupPending && Date.now() - lastCleanupAt < cleanupIntervalMs) return true;
    cleanupPending = true;
    try {
      if (options.retentionDays >= 0) {
        const cutoff = new Date(Date.now() - options.retentionDays * 86_400_000).toISOString();
        target.delete(logs).where(lt(logs.createdAt, cutoff)).run();
      }
      if (options.maxRows > 0) {
        const total = target.select({ value: count() }).from(logs).get()?.value ?? 0;
        if (total > options.maxRows) {
          const excess = total - options.maxRows;
          target
            .delete(logs)
            .where(sql`${logs.id} IN (SELECT id FROM logs ORDER BY id ASC LIMIT ${excess})`)
            .run();
        }
      }
    } catch (error) {
      if (sqlite && isLocked(error)) return false;
      report("log_cleanup_failed", error);
    }
    cleanupPending = false;
    lastCleanupAt = Date.now();
    return true;
  }

  function insert(row: typeof logs.$inferInsert): boolean {
    try {
      target.insert(logs).values(row).run();
      return true;
    } catch (error) {
      if (sqlite && isLocked(error)) return false;
      report("log_write_failed", error);
      return true; // 非锁错误延续原行为：报告该条失败，不让坏数据永久挡住队列。
    }
  }

  function reportDropped(): void {
    if (!droppedRows) return;
    console.error(JSON.stringify({ event: "log_buffer_overflow", droppedRows }));
    droppedRows = 0;
  }

  function schedule(delay: number): void {
    if (timer || closed) return;
    timer = setTimeout(() => {
      timer = undefined;
      drain();
    }, delay);
    timer.unref();
  }

  function drain(): void {
    const deadline = performance.now() + 8;
    let processed = 0;
    while (pending.length && processed < maxBatchRows && performance.now() < deadline) {
      if (!insert(pending[0]!)) return schedule(retryDelayMs);
      pending.shift();
      processed++;
    }
    if (!cleanup()) return schedule(retryDelayMs);
    reportDropped();
    if (pending.length) schedule(0);
  }

  if (sqlite) schedule(0);
  else cleanup();

  return {
    write(row) {
      if (closed) return;
      if (!sqlite) {
        insert(row);
        cleanup();
        return;
      }
      if (pending.length >= maxPendingRows) {
        pending.shift();
        droppedRows++;
      }
      pending.push(row);
      schedule(0);
    },
    close() {
      if (closed) return;
      closed = true;
      if (timer) clearTimeout(timer);
      // 退出时只尝试立即可写的日志；持锁时不等待，也不延误服务关闭。
      while (pending.length && insert(pending[0]!)) pending.shift();
      if (pending.length) console.error(JSON.stringify({ event: "log_shutdown_pending", droppedRows: pending.length }));
      pending.length = 0;
      reportDropped();
      sqlite?.close();
    },
  };
}
