import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { createDatabase, type DatabaseHandle } from "@emby-task-center/database/client";
import {
  auditLogs,
  memberExpiryCleanupJobs,
  renewalEmailOutbox,
  submissionUsers,
} from "@emby-task-center/database/schema";
import { reductionSchema, reduceMemberDays } from "./admin-reduction";
import { getDriveExpiry, setDriveExpiry } from "./drive-expiry";
import { addSubmissionUser, getSubmissionUser, memberStatus } from "./membership";
import { cleanupEligible } from "./member-expiry-cleanup-plan";

describe("administrator membership reduction", () => {
  let directory: string;
  let handle: DatabaseHandle;
  const day = 86_400_000;
  const now = new Date("2026-11-13T00:00:00.000Z");
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "member-reduction-"));
    handle = createDatabase(join(directory, "test.db"));
  });
  afterEach(() => {
    handle.close();
    rmSync(directory, { recursive: true, force: true });
  });
  function member(deferred = 0, expiry: string | null = "2026-11-20T00:00:00.000Z") {
    const created = addSubmissionUser(handle.db, { email: "member@example.com", subscriptionExpiresAt: expiry });
    handle.db
      .update(submissionUsers)
      .set({
        deferredMembershipMs: deferred,
        membershipExpiryLabel: "假期结束",
        membershipReminderState: "expired",
        membershipRemindedAt: now.toISOString(),
      })
      .where(eq(submissionUsers.id, created.id))
      .run();
    return getSubmissionUser(handle.db, created.id)!;
  }
  function input(user: ReturnType<typeof member>, days: number) {
    return reductionSchema.parse({
      requestId: randomUUID(),
      days,
      expectedExpiresAt: user.subscriptionExpiresAt,
      expectedDeferredMembershipMs: user.deferredMembershipMs,
      expectedDriveExpiryDate: getDriveExpiry(handle.db)?.date ?? null,
      reason: "测试调整",
    });
  }
  it.each([
    [10 * day, 3, 7 * day, "2026-11-20T00:00:00.000Z"],
    [2.5 * day, 4, 0, "2026-11-18T12:00:00.000Z"],
    [2 * day, 2, 0, "2026-11-20T00:00:00.000Z"],
    [0, 10, 0, "2026-11-10T00:00:00.000Z"],
  ])("deducts from %s deferred ms before shortening expiry for %s days", (deferred, days, remaining, expiry) => {
    const user = member(deferred);
    const result = reduceMemberDays(handle.db, user.id, input(user, days), now);
    expect(result.user).toMatchObject({
      subscriptionExpiresAt: expiry,
      deferredMembershipMs: remaining,
      membershipExpiryLabel: null,
      membershipReminderState: null,
      membershipRemindedAt: null,
    });
    const receipt = handle.db.select().from(renewalEmailOutbox).get()!;
    expect(receipt.subject).toContain("会员时长扣减");
    expect(receipt.text).toContain(`本次扣减：${days} 天`);
    expect(receipt.text).toContain("扣减前待激活时长：");
    expect(receipt.text).toContain("扣减后待激活时长：");
    expect(receipt.text).toContain("测试调整");
    expect(receipt.text).not.toContain("续期已完成");
    expect(handle.db.select().from(auditLogs).get()!.action).toBe("member.days_reduced");
  });
  it("reduces an already expired date without granting time from now and preserves pending access sync", () => {
    const user = member(0, "2020-01-01T00:00:00.000Z");
    handle.db.update(submissionUsers).set({ embyUserId: "emby-1", enabled: false }).run();
    const result = reduceMemberDays(handle.db, user.id, input(user, 1), now);
    expect(result.user).toMatchObject({
      subscriptionExpiresAt: "2019-12-31T00:00:00.000Z",
      enabled: false,
      driveExpirySyncPending: true,
    });
    expect(memberStatus(result.user, now)).toBe("expired");
  });
  it("replays without a second deduction even after audit retention and a database reopen", () => {
    const user = member(4 * day);
    const request = input(user, 1);
    reduceMemberDays(handle.db, user.id, request, now);
    handle.db.delete(auditLogs).run();
    handle.close();
    handle = createDatabase(join(directory, "test.db"));
    expect(reduceMemberDays(handle.db, user.id, request, now)).toMatchObject({
      repeated: true,
      user: { deferredMembershipMs: 3 * day },
    });
    expect(() => reduceMemberDays(handle.db, user.id, { ...request, days: 2 }, now)).toThrow(
      "reduction_request_conflict",
    );
    expect(handle.db.select().from(renewalEmailOutbox).all()).toHaveLength(1);
  });
  it("rejects stale expiry, deferred balance and drive date", () => {
    const user = member(2 * day);
    const request = input(user, 1);
    expect(() =>
      reduceMemberDays(handle.db, user.id, { ...request, expectedExpiresAt: now.toISOString() }, now),
    ).toThrow("reduction_expiry_changed");
    expect(() => reduceMemberDays(handle.db, user.id, { ...request, expectedDeferredMembershipMs: 0 }, now)).toThrow(
      "reduction_expiry_changed",
    );
    setDriveExpiry(handle.db, "2028-08-31", now);
    expect(() => reduceMemberDays(handle.db, user.id, request, now)).toThrow("reduction_drive_expiry_changed");
    expect(handle.db.select().from(renewalEmailOutbox).all()).toHaveLength(0);
  });
  it("blocks unlimited and drive-following members and cleanup-in-progress", () => {
    const user = member(0, null);
    expect(() => reduceMemberDays(handle.db, user.id, input(user, 1), now)).toThrow("reduction_unlimited_member");
    setDriveExpiry(handle.db, "2028-08-31", now);
    const following = getSubmissionUser(handle.db, user.id)!;
    expect(() => reduceMemberDays(handle.db, user.id, input(following, 1), now)).toThrow("reduction_unlimited_member");
    handle.db
      .insert(memberExpiryCleanupJobs)
      .values({
        memberId: user.id,
        serverId: "server",
        embyUserId: "emby-1",
        leaseToken: "lease",
        leaseUntil: Date.now() + 1000,
      })
      .run();
    expect(() => reduceMemberDays(handle.db, user.id, input(following, 1), now)).toThrow("reduction_cleanup_pending");
  });
  it("rolls back the deduction and audit if notification persistence fails", () => {
    const user = member(2 * day);
    handle.db.run(
      sql`CREATE TRIGGER fail_reduction_mail BEFORE INSERT ON renewal_email_outbox BEGIN SELECT RAISE(ABORT,'fixture'); END`,
    );
    expect(() => reduceMemberDays(handle.db, user.id, input(user, 3), now)).toThrow();
    expect(getSubmissionUser(handle.db, user.id)).toEqual(user);
    expect(handle.db.select().from(auditLogs).all()).toHaveLength(0);
  });
  it("makes a newly backdated expiry eligible under the existing cleanup grace period", () => {
    const user = member(2 * day);
    expect(cleanupEligible(user, 1, now)).toBe(false);
    const result = reduceMemberDays(handle.db, user.id, input(user, 10), now);
    expect(result.user.subscriptionExpiresAt).toBe("2026-11-12T00:00:00.000Z");
    expect(cleanupEligible(result.user, 1, now)).toBe(true);
    expect(cleanupEligible(result.user, 2, now)).toBe(false);
  });
  it.each([0, -1, 1.5, 36501])("rejects invalid day count %s", (days) => {
    expect(() => input(member(), days)).toThrow();
  });
});
