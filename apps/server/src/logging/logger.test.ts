import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { count } from "drizzle-orm";

import { createDatabase, type DatabaseHandle } from "@emby-task-center/database/client";
import { logs } from "@emby-task-center/database/schema";
import { createLogger } from "./logger";

describe("logger retention", () => {
  let directory: string;
  let database: DatabaseHandle;

  afterEach(() => {
    vi.useRealTimers();
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("trims the table to maxRows when a throttled cleanup runs", () => {
    directory = mkdtempSync(join(tmpdir(), "emby-logger-trim-"));
    database = createDatabase(join(directory, "logger.sqlite"));
    vi.useFakeTimers();

    const logger = createLogger(database.db, { retentionDays: 30, maxRows: 5 });
    for (let i = 0; i < 10; i++) logger.info({ event: `event-${i}` });
    expect(countRows()).toBe(10);

    vi.advanceTimersByTime(61_000);
    logger.info({ event: "trigger" });
    expect(countRows()).toBe(5);
  });

  it("clears old rows when retentionDays is zero", () => {
    directory = mkdtempSync(join(tmpdir(), "emby-logger-retention-"));
    database = createDatabase(join(directory, "logger.sqlite"));
    const oldTimestamp = new Date(Date.now() - 10 * 86_400_000).toISOString();
    database.db
      .insert(logs)
      .values([
        { level: "info", source: "server", message: "old-1", createdAt: oldTimestamp },
        { level: "info", source: "server", message: "old-2", createdAt: oldTimestamp },
      ])
      .run();
    expect(countRows()).toBe(2);

    createLogger(database.db, { retentionDays: 0, maxRows: 100 });
    expect(countRows()).toBe(0);
  });

  function countRows(): number {
    return database.db.select({ value: count() }).from(logs).get()?.value ?? 0;
  }
});
