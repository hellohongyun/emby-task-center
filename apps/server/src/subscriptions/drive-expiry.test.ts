import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabase, type DatabaseHandle } from "@emby-task-center/database/client";
import { migrate } from "@emby-task-center/database/migrate";
import { auditLogs, submissionUsers } from "@emby-task-center/database/schema";
import { normalizeExpiryDate } from "./cards";
import { applyDriveExpiry, getDriveExpiry, setDriveExpiry } from "./drive-expiry";

const eod = (date: string) => normalizeExpiryDate(date)!;
const epoch = (date: string) => Date.parse(eod(date));
const now = new Date("2028-04-01T12:00:00.000Z");

describe("drive expiry membership entitlement", () => {
  let handle: DatabaseHandle;
  let emailIndex: number;
  beforeEach(() => {
    handle = createDatabase(":memory:");
    emailIndex = 1;
  });
  afterEach(() => handle.close());
  function seed(expiry: string | null, patch: Partial<typeof submissionUsers.$inferInsert> = {}) {
    return handle.db
      .insert(submissionUsers)
      .values({
        email: `member-${emailIndex++}@example.invalid`,
        subscriptionExpiresAt: expiry,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        ...patch,
      })
      .returning()
      .get();
  }
  const read = (id: number) => handle.db.select().from(submissionUsers).where(eq(submissionUsers.id, id)).get()!;

  it("keeps existing membership unchanged during migration until the administrator saves a limit", () => {
    const old = seed(eod("2029-04-15"));
    const unlimited = seed(null);
    // Simulate the previous schema only in this disposable fixture.
    handle.db.run(sql`ALTER TABLE submission_users DROP COLUMN deferred_membership_ms`);
    handle.db.run(sql`ALTER TABLE submission_users DROP COLUMN follows_drive_expiry`);
    handle.db.run(sql`ALTER TABLE submission_users DROP COLUMN drive_expiry_sync_pending`);
    migrate(handle.db);
    migrate(handle.db);
    expect(getDriveExpiry(handle.db)).toBeNull();
    expect(read(old.id)).toEqual(old);
    expect(read(unlimited.id)).toEqual(unlimited);
    expect(applyDriveExpiry(handle.db, eod("2029-04-15"))).toEqual({
      subscriptionExpiresAt: eod("2029-04-15"),
      deferredMembershipMs: 0,
      followsDriveExpiry: false,
    });
  });

  it("caps only excess expiry, moves permanent members to follow the limit, and makes same-date saves idempotent", () => {
    const beyond = seed(eod("2029-04-15"), {
      membershipExpiryLabel: "保留名称",
      membershipReminderState: "expiring",
      membershipRemindedAt: now.toISOString(),
    });
    const shorter = seed(eod("2028-06-01"), { membershipReminderState: "expiring" });
    const unlimited = seed(null);
    const legacy = seed("historical-invalid");
    const result = setDriveExpiry(handle.db, "2028-08-31", now);
    expect(result).toEqual({
      limit: { date: "2028-08-31", expiresAt: eod("2028-08-31") },
      changedMemberIds: [beyond.id, unlimited.id, legacy.id],
      releasedMembers: 0,
    });
    expect(read(beyond.id)).toMatchObject({
      subscriptionExpiresAt: eod("2028-08-31"),
      deferredMembershipMs: epoch("2029-04-15") - epoch("2028-08-31"),
      followsDriveExpiry: false,
      membershipExpiryLabel: "保留名称",
      membershipReminderState: null,
      membershipRemindedAt: null,
    });
    expect(read(shorter.id)).toEqual(shorter);
    for (const member of [unlimited, legacy]) {
      expect(read(member.id)).toMatchObject({
        subscriptionExpiresAt: eod("2028-08-31"),
        followsDriveExpiry: true,
        deferredMembershipMs: 0,
      });
    }
    expect(getDriveExpiry(handle.db)).toEqual(result.limit);
    expect(setDriveExpiry(handle.db, "2028-08-31", new Date("2028-04-02"))).toEqual({
      limit: result.limit,
      changedMemberIds: [],
      releasedMembers: 0,
    });
    expect(
      handle.db
        .select()
        .from(auditLogs)
        .all()
        .map((row) => row.action),
    ).toEqual([
      "member.drive_expiry_adjusted",
      "member.drive_expiry_adjusted",
      "member.drive_expiry_adjusted",
      "settings.drive_expiry_updated",
    ]);
  });

  it("releases a balance in parts without extending ordinary members or consuming permanent entitlements", () => {
    const finite = seed(eod("2029-04-15"));
    const shorter = seed(eod("2028-05-15"));
    const permanent = seed(null);
    setDriveExpiry(handle.db, "2028-08-31", now);
    expect(setDriveExpiry(handle.db, "2028-12-31", now).releasedMembers).toBe(1);
    expect(read(finite.id)).toMatchObject({
      subscriptionExpiresAt: eod("2028-12-31"),
      deferredMembershipMs: epoch("2029-04-15") - epoch("2028-12-31"),
    });
    expect(setDriveExpiry(handle.db, "2029-04-30", now).releasedMembers).toBe(1);
    expect(read(finite.id)).toMatchObject({ subscriptionExpiresAt: eod("2029-04-15"), deferredMembershipMs: 0 });
    expect(read(permanent.id)).toMatchObject({ subscriptionExpiresAt: eod("2029-04-30"), followsDriveExpiry: true });
    expect(read(shorter.id)).toEqual(shorter);
  });

  it("uses the later of current expiry and now when releasing and preserves unused time when cutting to a past date", () => {
    const finite = seed(eod("2029-04-15"), { embyUserId: "linked-emby-user", enabled: false });
    setDriveExpiry(handle.db, "2028-08-31", now);
    const frozen = read(finite.id).deferredMembershipMs;
    const resumedAt = new Date("2028-09-09T12:00:00.000Z");
    expect(setDriveExpiry(handle.db, "2028-09-30", resumedAt).releasedMembers).toBe(1);
    const released = epoch("2028-09-30") - resumedAt.getTime();
    expect(read(finite.id)).toMatchObject({
      subscriptionExpiresAt: eod("2028-09-30"),
      deferredMembershipMs: frozen - released,
      driveExpirySyncPending: true,
      enabled: false,
    });
    setDriveExpiry(handle.db, "2028-09-01", resumedAt);
    expect(read(finite.id)).toMatchObject({
      subscriptionExpiresAt: eod("2028-09-01"),
      deferredMembershipMs: frozen,
      driveExpirySyncPending: true,
      enabled: false,
    });
  });

  it("adds only the new overflow and excludes any gap since a past cap", () => {
    setDriveExpiry(handle.db, "2028-08-31", now);
    expect(applyDriveExpiry(handle.db, eod("2029-04-15"), 123, now)).toEqual({
      subscriptionExpiresAt: eod("2028-08-31"),
      deferredMembershipMs: epoch("2029-04-15") - epoch("2028-08-31") + 123,
      followsDriveExpiry: false,
    });
    const afterExpiry = new Date("2028-09-09T12:00:00.000Z");
    expect(applyDriveExpiry(handle.db, eod("2028-09-30"), 123, afterExpiry)).toEqual({
      subscriptionExpiresAt: eod("2028-08-31"),
      deferredMembershipMs: epoch("2028-09-30") - afterExpiry.getTime() + 123,
      followsDriveExpiry: false,
    });
    expect(applyDriveExpiry(handle.db, eod("2028-09-01"), 123, afterExpiry).deferredMembershipMs).toBe(123);
    expect(applyDriveExpiry(handle.db, null, 123, afterExpiry)).toEqual({
      subscriptionExpiresAt: eod("2028-08-31"),
      deferredMembershipMs: 123,
      followsDriveExpiry: true,
    });
  });

  it("validates calendar dates and rolls back settings, membership and audit together if saving fails", () => {
    const member = seed(eod("2029-04-15"));
    expect(() => setDriveExpiry(handle.db, "2028-02-30", now)).toThrow("invalid_drive_expiry_date");
    expect(() => setDriveExpiry(handle.db, "2028-08-31T00:00:00Z", now)).toThrow("invalid_drive_expiry_date");
    handle.db.run(sql`CREATE TRIGGER fixture_drive_audit_failure BEFORE INSERT ON audit_logs
      WHEN NEW.action = 'settings.drive_expiry_updated' BEGIN SELECT RAISE(ABORT, 'fixture audit failed'); END`);
    expect(() => setDriveExpiry(handle.db, "2028-08-31", now)).toThrow();
    expect(getDriveExpiry(handle.db)).toBeNull();
    expect(read(member.id)).toEqual(member);
    expect(handle.db.select().from(auditLogs).all()).toHaveLength(0);
  });
});
