import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDatabase, type DatabaseHandle } from "@emby-task-center/database/client";
import { submissionUsers } from "@emby-task-center/database/schema";
import { saveCleanupPolicy } from "../subscriptions/member-expiry-cleanup-plan";
import { MEMBER_EXPIRY_CLEANUP_INTERVAL_MS as INTERVAL, startMemberExpiryCleanup } from "./member-expiry-cleanup";

describe("scheduled member expiry cleanup", () => {
  let database: DatabaseHandle;
  let stop: (() => void) | undefined;
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), request: vi.fn() };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2028-09-10T00:00:00.000Z"));
    database = createDatabase(":memory:");
    vi.clearAllMocks();
  });

  afterEach(() => {
    stop?.();
    stop = undefined;
    database.close();
    vi.useRealTimers();
  });

  function expired(email: string) {
    return database.db
      .insert(submissionUsers)
      .values({
        email,
        createdAt: "2028-01-01T00:00:00.000Z",
        updatedAt: "2028-01-01T00:00:00.000Z",
        subscriptionExpiresAt: "2028-09-01T00:00:00.000Z",
      })
      .returning()
      .get().id;
  }

  const exists = (id: number) =>
    Boolean(database.db.select().from(submissionUsers).where(eq(submissionUsers.id, id)).get());

  it("leaves the default disabled, honors saved settings at the next tick, and stops cleanly", async () => {
    const old = expired("expired@example.test");
    stop = startMemberExpiryCleanup(database.db, undefined, logger);
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(exists(old)).toBe(true);
    saveCleanupPolicy(database.db, 7, null);
    await vi.advanceTimersByTimeAsync(INTERVAL - 1);
    expect(exists(old)).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(exists(old)).toBe(false);
    expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({ event: "member_expiry_cleanup_completed" }));
    const next = expired("next@example.test");
    stop();
    await vi.advanceTimersByTimeAsync(INTERVAL * 2);
    expect(exists(next)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("runs the saved policy at startup and stops new removals after the rule is disabled", async () => {
    saveCleanupPolicy(database.db, 7, null);
    const old = expired("startup@example.test");
    stop = startMemberExpiryCleanup(database.db, undefined, logger);
    await vi.advanceTimersByTimeAsync(0);
    expect(exists(old)).toBe(false);
    const next = expired("disabled@example.test");
    saveCleanupPolicy(database.db, null, null);
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(exists(next)).toBe(true);
  });
});
