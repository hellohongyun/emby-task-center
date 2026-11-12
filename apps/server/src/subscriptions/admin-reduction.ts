import { createHash } from "node:crypto";
import { eq, like } from "drizzle-orm";
import { z } from "zod";
import type { AppDatabase } from "@emby-task-center/database/client";
import { renewalEmailOutbox, submissionUsers } from "@emby-task-center/database/schema";
import { audit } from "./domain-utils";
import { getDriveExpiry } from "./drive-expiry";
import { isMemberExpiryCleanupPending } from "./member-expiry-cleanup-guard";
import { getSubmissionUser } from "./membership";
import { enqueueRenewalReceipt } from "./renewal-outbox";

export const reductionSchema = z.strictObject({
  requestId: z.string().uuid(),
  expectedExpiresAt: z.string().datetime().nullable(),
  expectedDeferredMembershipMs: z.number().int().nonnegative(),
  expectedDriveExpiryDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable(),
  days: z.number().int().min(1).max(36500),
  reason: z.string().trim().max(200).default(""),
});
export type ReductionInput = z.infer<typeof reductionSchema>;

function fail(code: string): never {
  throw new Error(code);
}

export function reduceMemberDays(database: AppDatabase, id: number, input: ReductionInput, now = new Date()) {
  // Keep both the UUID and input digest in the durable outbox key. Conflict detection
  // still works after audit retention removes the original event.
  const prefix = `admin-reduce:${id}:${input.requestId}:`;
  const digest = createHash("sha256")
    .update(JSON.stringify(reductionSchema.parse(input)))
    .digest("hex");
  const receiptKey = `${prefix}${digest}`;
  return database.transaction(
    (tx) => {
      const user = getSubmissionUser(tx, id);
      if (!user) fail("user_not_found");
      const prior = tx
        .select({ key: renewalEmailOutbox.key })
        .from(renewalEmailOutbox)
        .where(like(renewalEmailOutbox.key, `${prefix}%`))
        .get();
      if (prior) {
        if (prior.key !== receiptKey) fail("reduction_request_conflict");
        return { user, repeated: true, receiptKey };
      }
      if (isMemberExpiryCleanupPending(tx, id)) fail("reduction_cleanup_pending");
      if (
        user.subscriptionExpiresAt !== input.expectedExpiresAt ||
        user.deferredMembershipMs !== input.expectedDeferredMembershipMs
      )
        fail("reduction_expiry_changed");
      if ((getDriveExpiry(tx)?.date ?? null) !== input.expectedDriveExpiryDate) fail("reduction_drive_expiry_changed");
      if (!user.subscriptionExpiresAt || user.followsDriveExpiry) fail("reduction_unlimited_member");
      const oldExpiry = Date.parse(user.subscriptionExpiresAt);
      if (!Number.isFinite(oldExpiry)) fail("reduction_invalid_expiry");
      const deductedMs = input.days * 86_400_000;
      const fromDeferred = Math.min(user.deferredMembershipMs, deductedMs);
      const expiresAt = new Date(oldExpiry - (deductedMs - fromDeferred));
      if (!Number.isFinite(expiresAt.getTime())) fail("reduction_invalid_expiry");
      const entitlement = {
        subscriptionExpiresAt: expiresAt.toISOString(),
        deferredMembershipMs: user.deferredMembershipMs - fromDeferred,
      };
      const updated = tx
        .update(submissionUsers)
        .set({
          ...entitlement,
          membershipExpiryLabel: null,
          membershipReminderState: null,
          membershipRemindedAt: null,
          driveExpirySyncPending:
            user.driveExpirySyncPending || Boolean(user.embyUserId && expiresAt.getTime() <= now.getTime()),
          updatedAt: now.toISOString(),
        })
        .where(eq(submissionUsers.id, id))
        .returning()
        .get()!;
      audit(
        tx,
        "admin",
        "member.days_reduced",
        "submission_user",
        id,
        {
          subscriptionExpiresAt: user.subscriptionExpiresAt,
          deferredMembershipMs: user.deferredMembershipMs,
          membershipExpiryLabel: user.membershipExpiryLabel,
        },
        { ...entitlement, membershipExpiryLabel: null, requestId: input.requestId, input },
        input.reason,
      );
      enqueueRenewalReceipt(tx, receiptKey, {
        email: user.email,
        method: `管理员扣减 ${input.days} 天`,
        previousExpiresAt: user.subscriptionExpiresAt,
        subscriptionExpiresAt: entitlement.subscriptionExpiresAt,
        reduction: {
          days: input.days,
          previousDeferredMembershipMs: user.deferredMembershipMs,
          deferredMembershipMs: entitlement.deferredMembershipMs,
          reason: input.reason,
        },
      });
      return { user: updated, repeated: false, receiptKey };
    },
    { behavior: "immediate" },
  );
}
