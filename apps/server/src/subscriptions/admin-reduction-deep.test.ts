import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDatabase, type DatabaseHandle } from "@emby-task-center/database/client";
import { renewalEmailOutbox, submissionUsers } from "@emby-task-center/database/schema";
import type { EmailNotifier } from "../notifications/email-service";
import { reductionSchema, reduceMemberDays } from "./admin-reduction";
import { renewalSchema, renewMember } from "./admin-renewal";
import { getDriveExpiry, setDriveExpiry } from "./drive-expiry";
import { addSubmissionUser, getSubmissionUser } from "./membership";
import { deliverRenewalReceipt, retryRenewalReceipts } from "./renewal-outbox";
import { saveCleanupPolicy } from "./member-expiry-cleanup-plan";
import { sweepMemberExpiryCleanup } from "./member-expiry-cleanup";

describe("reduction cross-connection entitlement and mail", () => {
  let directory: string;
  let first: DatabaseHandle;
  let second: DatabaseHandle;
  const day = 86_400_000;
  const now = new Date("2026-01-01T00:00:00.000Z");
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "reduction-deep-"));
    first = createDatabase(join(directory, "test.db"));
    second = createDatabase(join(directory, "test.db"));
  });
  afterEach(() => {
    first.close();
    second.close();
    rmSync(directory, { recursive: true, force: true });
  });
  function member() {
    return addSubmissionUser(first.db, {
      email: "deep@example.invalid",
      subscriptionExpiresAt: "2030-01-01T00:00:00.000Z",
    });
  }
  function reduction(user: ReturnType<typeof member>, days = 1) {
    return reductionSchema.parse({
      requestId: randomUUID(),
      days,
      expectedExpiresAt: user.subscriptionExpiresAt,
      expectedDeferredMembershipMs: user.deferredMembershipMs,
      expectedDriveExpiryDate: getDriveExpiry(first.db)?.date ?? null,
    });
  }
  function renewal(user: ReturnType<typeof member>, days = 1) {
    return renewalSchema.parse({
      mode: "days",
      days,
      requestId: randomUUID(),
      expectedExpiresAt: user.subscriptionExpiresAt,
      expectedDeferredMembershipMs: user.deferredMembershipMs,
      expectedDriveExpiryDate: getDriveExpiry(first.db)?.date ?? null,
    });
  }
  it.each(["renewal-first", "reduction-first"])("rejects stale work across connections for %s", (order) => {
    const user = member();
    const down = reduction(user, 3);
    const up = renewal(user, 4);
    if (order === "renewal-first") {
      renewMember(first.db, user.id, up, now);
      expect(() => reduceMemberDays(second.db, user.id, down, now)).toThrow("reduction_expiry_changed");
      expect(getSubmissionUser(second.db, user.id)?.subscriptionExpiresAt).toBe("2030-01-05T00:00:00.000Z");
    } else {
      reduceMemberDays(first.db, user.id, down, now);
      expect(() => renewMember(second.db, user.id, up, now)).toThrow("renewal_expiry_changed");
      expect(getSubmissionUser(second.db, user.id)?.subscriptionExpiresAt).toBe("2029-12-29T00:00:00.000Z");
    }
    expect(second.db.select().from(renewalEmailOutbox).all()).toHaveLength(1);
  });
  it("rejects old cap previews even when changing cap leaves the member expiry unchanged", () => {
    const user = member();
    const down = reduction(user);
    setDriveExpiry(second.db, "2035-01-01", now);
    expect(getSubmissionUser(first.db, user.id)?.subscriptionExpiresAt).toBe(user.subscriptionExpiresAt);
    expect(() => reduceMemberDays(first.db, user.id, down, now)).toThrow("reduction_drive_expiry_changed");
    expect(first.db.select().from(renewalEmailOutbox).all()).toHaveLength(0);
  });
  it("conserves exact milliseconds across 90 mixed reductions, grants, cap changes and database reopens", () => {
    const user = member();
    let expected = Date.parse(user.subscriptionExpiresAt!);
    for (let index = 0; index < 90; index++) {
      const db = index % 2 ? first.db : second.db;
      const current = getSubmissionUser(db, user.id)!;
      if (index % 3 === 0) {
        const days = 1 + (index % 5);
        reduceMemberDays(db, user.id, reduction(current, days), now);
        expected -= days * day;
      } else if (index % 3 === 1) {
        const days = 1 + (index % 7);
        renewMember(db, user.id, renewal(current, days), now);
        expected += days * day;
      } else setDriveExpiry(db, index % 2 ? "2028-02-29" : "2031-12-31", now);
      const after = getSubmissionUser(first.db, user.id)!;
      expect(Date.parse(after.subscriptionExpiresAt!) + after.deferredMembershipMs).toBe(expected);
      expect(after.deferredMembershipMs).toBeGreaterThanOrEqual(0);
      if (index % 10 === 9) {
        second.close();
        second = createDatabase(join(directory, "test.db"));
        expect(getSubmissionUser(second.db, user.id)).toEqual(after);
      }
    }
    expect(first.db.select().from(renewalEmailOutbox).all()).toHaveLength(60);
  });
  it("retains a reduction receipt while SMTP is absent and sends its original result after later renewal", async () => {
    const user = member();
    const reduced = reduceMemberDays(first.db, user.id, reduction(user, 2), now);
    const send = vi.fn().mockResolvedValue(undefined);
    const mail = { configured: false, sendNotification: send } as unknown as EmailNotifier;
    expect(await deliverRenewalReceipt(first.db, mail, reduced.receiptKey)).toBe("pending");
    expect(first.db.select().from(renewalEmailOutbox).get()?.attempts).toBe(0);
    renewMember(second.db, user.id, renewal(reduced.user, 10), now);
    mail.configured = true;
    await retryRenewalReceipts(second.db, mail);
    expect(send).toHaveBeenCalledTimes(2);
    const [, subject, text] = send.mock.calls.find((args) => String(args[1]).includes("时长扣减"))!;
    expect(subject).toContain("会员时长扣减");
    expect(text).toContain(new Date("2029-12-30T00:00:00.000Z").toLocaleString());
    expect(text).not.toContain(new Date("2030-01-09T00:00:00.000Z").toLocaleString());
    await retryRenewalReceipts(first.db, mail);
    expect(send).toHaveBeenCalledTimes(2);
  });
  it("executes saved expiry cleanup after reduction crosses grace while preserving members with deferred time", async () => {
    const current = new Date("2030-01-02T00:00:00.000Z");
    const user = member();
    first.db
      .update(submissionUsers)
      .set({ deferredMembershipMs: 2 * day })
      .run();
    saveCleanupPolicy(first.db, 1, null);
    const protectedMember = getSubmissionUser(first.db, user.id)!;
    reduceMemberDays(first.db, user.id, reduction(protectedMember, 1), current);
    expect(await sweepMemberExpiryCleanup(second.db, undefined, current)).toMatchObject({ deleted: 0 });
    expect(getSubmissionUser(second.db, user.id)?.deferredMembershipMs).toBe(day);
    const pending = getSubmissionUser(second.db, user.id)!;
    reduceMemberDays(second.db, user.id, reduction(pending, 2), current);
    expect(await sweepMemberExpiryCleanup(first.db, undefined, current)).toMatchObject({ deleted: 1 });
    expect(getSubmissionUser(first.db, user.id)).toBeNull();
    // Deleting the member must not erase the already committed adjustment notices.
    expect(first.db.select().from(renewalEmailOutbox).all()).toHaveLength(2);
  });
});
