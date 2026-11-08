import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createDatabase, type DatabaseHandle } from "@emby-task-center/database/client";
import { auditLogs, mediaItems, mediaRequests, submissionUsers } from "@emby-task-center/database/schema";
import { createMediaRequestStore } from "./store";
import { RETENTION_BATCH_SIZE, sweepExpiredMediaRequests } from "./retention";

describe("available media request seven-day retention", () => {
  let handle: DatabaseHandle;
  let directory: string;
  let identity = 1;
  const now = new Date("2026-11-03T12:30:00.000Z");
  const cutoff = "2026-10-27T12:30:00.000Z";
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "request-retention-"));
    handle = createDatabase(join(directory, "test.db"));
    identity = 1;
  });
  afterEach(() => {
    vi.useRealTimers();
    handle.close();
    rmSync(directory, { recursive: true, force: true });
  });
  function seed(
    status: "pending" | "processing" | "available" | "unavailable" = "available",
    availableAt: string | null = cutoff,
  ) {
    return handle.db
      .insert(mediaRequests)
      .values({
        memberId: 99,
        memberEmail: "fixture@example.invalid",
        kind: "request",
        mediaType: "movie",
        tmdbId: identity++,
        title: "保留边界测试",
        originalTitle: "Fixture",
        status,
        availableAt,
        createdAt: "2020-01-01T00:00:00.000Z",
        updatedAt: "2026-11-03T00:00:00.000Z",
      })
      .returning()
      .get();
  }
  it("deletes exactly at seven full days, keeps newer/future/null/malformed timestamps and every other status", () => {
    const old = seed("available", "2020-01-01T00:00:00.000Z");
    const exact = seed();
    const kept = [
      seed("available", "2026-10-27T12:30:00.001Z"),
      seed("available", "2030-01-01T00:00:00.000Z"),
      seed("available", null),
      seed("available", "invalid"),
      seed("available", "2026-02-30T00:00:00.000Z"),
      seed("pending", "2020-01-01T00:00:00.000Z"),
      seed("processing", "2020-01-01T00:00:00.000Z"),
      seed("unavailable", "2020-01-01T00:00:00.000Z"),
    ];
    expect(sweepExpiredMediaRequests(handle.db, now)).toBe(2);
    expect(
      handle.db
        .select()
        .from(mediaRequests)
        .all()
        .map((row) => row.id),
    ).toEqual(kept.map((row) => row.id));
    const log = handle.db.select().from(auditLogs).get()!;
    expect(log.action).toBe("media_request.retention_deleted");
    expect(JSON.parse(log.after!)).toEqual({ count: 2, ids: [old.id, exact.id], retentionDays: 7 });
    expect(log.before).toBeNull();
    expect(sweepExpiredMediaRequests(handle.db, now)).toBe(0);
    expect(handle.db.select().from(auditLogs).all()).toHaveLength(1);
  });
  it("starts the clock on completion, preserves it for notes, and resets it only after reopening and recompleting", () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const store = createMediaRequestStore(handle.db);
    const pending = seed("pending", null);
    const completed = store.update(
      pending.id,
      pending.updatedAt,
      { status: "available", adminNote: "已补齐" },
      "admin",
    );
    expect(completed.availableAt).toBe(now.toISOString());
    vi.setSystemTime(new Date(now.getTime() + 86_400_000));
    const edited = store.update(
      completed.id,
      completed.updatedAt,
      { status: "available", adminNote: "补充反馈" },
      "admin",
    );
    expect(edited.availableAt).toBe(completed.availableAt);
    const reopened = store.update(edited.id, edited.updatedAt, { status: "processing" }, "admin");
    expect(reopened.availableAt).toBeNull();
    expect(sweepExpiredMediaRequests(handle.db, new Date("2030-01-01"))).toBe(0);
    const recompleted = store.update(reopened.id, reopened.updatedAt, { status: "available" }, "admin");
    expect(recompleted.availableAt).toBe(recompleted.updatedAt);
    expect(Date.parse(recompleted.availableAt!)).toBeGreaterThan(Date.parse(completed.availableAt!));
    expect(
      sweepExpiredMediaRequests(handle.db, new Date(Date.parse(recompleted.availableAt!) + 7 * 86_400_000 - 1)),
    ).toBe(0);
    expect(sweepExpiredMediaRequests(handle.db, new Date(Date.parse(recompleted.availableAt!) + 7 * 86_400_000))).toBe(
      1,
    );
  });
  it("limits each transaction to 500 and preserves members, media, inventory tables and previous audits", () => {
    const timestamp = now.toISOString();
    handle.db
      .insert(submissionUsers)
      .values({ email: "protected@example.invalid", createdAt: timestamp, updatedAt: timestamp })
      .run();
    handle.db
      .insert(mediaItems)
      .values({
        mediaType: "movie",
        title: "媒体不能删除",
        tmdbPayload: { cached: true },
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .run();
    handle.db
      .insert(auditLogs)
      .values({
        operator: "admin",
        action: "media_request.updated",
        targetType: "media_request",
        targetId: 1,
        createdAt: timestamp,
      })
      .run();
    const members = handle.db.select().from(submissionUsers).all();
    const media = handle.db.select().from(mediaItems).all();
    for (let i = 0; i < RETENTION_BATCH_SIZE + 1; i++) seed();
    expect(sweepExpiredMediaRequests(handle.db, now)).toBe(500);
    expect(handle.db.select().from(mediaRequests).all()).toHaveLength(1);
    expect(sweepExpiredMediaRequests(handle.db, now)).toBe(1);
    expect(handle.db.select().from(submissionUsers).all()).toEqual(members);
    expect(handle.db.select().from(mediaItems).all()).toEqual(media);
    expect(handle.db.select().from(auditLogs).all()).toHaveLength(3);
  });
  it("rolls deletion back if audit insertion fails and persists a successful sweep across reopen", () => {
    const row = seed();
    handle.db.run(
      sql`CREATE TRIGGER fixture_fail_retention_audit BEFORE INSERT ON audit_logs BEGIN SELECT RAISE(ABORT,'fixture audit failed'); END`,
    );
    expect(() => sweepExpiredMediaRequests(handle.db, now)).toThrow();
    expect(handle.db.select().from(mediaRequests).where(eq(mediaRequests.id, row.id)).get()).toBeTruthy();
    handle.db.run(sql`DROP TRIGGER fixture_fail_retention_audit`);
    expect(sweepExpiredMediaRequests(handle.db, now)).toBe(1);
    handle.close();
    handle = createDatabase(join(directory, "test.db"));
    expect(handle.db.select().from(mediaRequests).all()).toHaveLength(0);
    expect(handle.db.select().from(auditLogs).get()?.action).toBe("media_request.retention_deleted");
  });
  it("gives internally created available rows a completion timestamp and clears it for other states", () => {
    const store = createMediaRequestStore(handle.db);
    const row = seed();
    const { id: _id, ...input } = row;
    const created = store.create({ ...input, tmdbId: 999, availableAt: null }).row;
    expect(created.availableAt).toBe(input.updatedAt);
    const pending = store.create({ ...input, tmdbId: 1000, status: "pending", availableAt: cutoff }).row;
    expect(pending.availableAt).toBeNull();
  });
});
