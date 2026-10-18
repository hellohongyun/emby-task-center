import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { count } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDatabase, type DatabaseHandle } from "@emby-task-center/database/client";
import { logs } from "@emby-task-center/database/schema";
import { createLogger, type Logger } from "./logger";

describe("logger with a separate nonwaiting SQLite connection", () => {
  let directory: string;
  let databasePath: string;
  let database: DatabaseHandle;
  let lock: BetterSqlite3.Database;
  let logger: Logger | undefined;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "emby-log-writer-"));
    databasePath = join(directory, "logs.sqlite");
    database = createDatabase(databasePath);
    lock = new BetterSqlite3(databasePath, { timeout: 0 });
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    if (lock.inTransaction) lock.exec("ROLLBACK");
    logger?.close?.();
    logger = undefined;
    lock.close();
    database.close();
    rmSync(directory, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const rowCount = () => database.db.select({ value: count() }).from(logs).get()!.value;
  const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 80));

  it("returns promptly under a write lock, keeps timers responsive, then persists redacted rows", async () => {
    lock.exec("BEGIN IMMEDIATE");
    const start = performance.now();
    logger = createLogger(database.db, {
      databasePath,
      retentionDays: 30,
      redact: (text) => text.replaceAll("secret", "[redacted]"),
    });
    logger.info({ message: "request secret", method: "GET", path: "/api/test", status: 200, detail: "secret" });
    logger.warn({ message: "second" });
    expect(performance.now() - start).toBeLessThan(250);
    await tick();
    expect(performance.now() - start).toBeLessThan(500);
    expect(rowCount()).toBe(0);
    expect(console.error).not.toHaveBeenCalled();

    lock.exec("ROLLBACK");
    await vi.waitFor(() => expect(rowCount()).toBe(2));
    expect(database.db.select().from(logs).all()).toMatchObject([
      {
        level: "info",
        source: "server",
        message: "request [redacted]",
        method: "GET",
        path: "/api/test",
        status: 200,
        detail: "[redacted]",
      },
      { level: "warn", message: "second" },
    ]);
  });

  it("retries startup retention cleanup on the same nonwaiting connection", async () => {
    database.db
      .insert(logs)
      .values({
        level: "info",
        source: "server",
        message: "old",
        createdAt: new Date(Date.now() - 10 * 86_400_000).toISOString(),
      })
      .run();
    lock.exec("BEGIN IMMEDIATE");
    logger = createLogger(database.db, { databasePath, retentionDays: 1, maxRows: 100 });
    const start = performance.now();
    await tick();
    expect(performance.now() - start).toBeLessThan(500);
    expect(rowCount()).toBe(1);
    lock.exec("ROLLBACK");
    await vi.waitFor(() => expect(rowCount()).toBe(0));
    expect(console.error).not.toHaveBeenCalled();
  });

  it("bounds buffered rows during a long lock and reports discarded records", async () => {
    lock.exec("BEGIN IMMEDIATE");
    logger = createLogger(database.db, { databasePath, retentionDays: -1, maxRows: 0 });
    for (let i = 0; i < 1005; i++) logger.info({ message: `event-${i}` });
    await tick();
    expect(rowCount()).toBe(0);
    lock.exec("ROLLBACK");
    await vi.waitFor(() => expect(rowCount()).toBe(1000), { timeout: 2000 });
    expect(database.db.select().from(logs).get()?.message).toBe("event-5");
    expect(console.error).toHaveBeenCalledWith(JSON.stringify({ event: "log_buffer_overflow", droppedRows: 5 }));
  });

  it("flushes pending rows at close without closing the caller's database", () => {
    logger = createLogger(database.db, { databasePath, retentionDays: -1, maxRows: 0 });
    logger.info({ message: "before-close" });
    logger.close?.();
    logger.close?.();
    expect(rowCount()).toBe(1);
    logger.info({ message: "after-close" });
    expect(rowCount()).toBe(1);
  });

  it("does not wait for a lock or leave retries running after close", async () => {
    lock.exec("BEGIN IMMEDIATE");
    logger = createLogger(database.db, { databasePath });
    logger.error({ message: "pending" });
    const start = performance.now();
    logger.close?.();
    expect(performance.now() - start).toBeLessThan(250);
    expect(console.error).toHaveBeenCalledWith(JSON.stringify({ event: "log_shutdown_pending", droppedRows: 1 }));
    lock.exec("ROLLBACK");
    await tick();
    expect(rowCount()).toBe(0);
  });
});
