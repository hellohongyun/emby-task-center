import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { AppDatabase } from "@emby-task-center/database/client";
import { auditLogs, renewalEmailOutbox, submissionUsers } from "@emby-task-center/database/schema";
import { normalizeExpiryDate } from "./cards";
import { audit } from "./domain-utils";
import { getSubmissionUser } from "./membership";
import { enqueueRenewalReceipt } from "./renewal-outbox";
import { applyDriveExpiry, getDriveExpiry } from "./drive-expiry";
import { fixedGrantTarget, membershipGrantBase, visibleMembershipExpiryLabel } from "./membership-expiry-grant";
import { isMemberExpiryCleanupPending } from "./member-expiry-cleanup-guard";

const common = {
  requestId: z.string().uuid(),
  expectedExpiresAt: z.string().datetime().nullable(),
  expectedDeferredMembershipMs: z.number().int().nonnegative().optional(),
  expectedDriveExpiryDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .optional(),
  reason: z.string().trim().max(200).default(""),
  expiryLabel: z
    .string()
    .trim()
    .max(60)
    .nullable()
    .optional()
    .transform((value) => value || null),
};
export const renewalSchema = z.discriminatedUnion("mode", [
  z.strictObject({ ...common, mode: z.literal("days"), days: z.number().int().min(1).max(36500) }),
  z.strictObject({ ...common, mode: z.literal("date"), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }),
]);
export type RenewalInput = z.infer<typeof renewalSchema>;

function fail(code: string): never {
  throw new Error(code);
}

/** The outbox key survives audit retention, including grants that leave the usable expiry unchanged. */
export function renewMember(database: AppDatabase, id: number, input: RenewalInput, now = new Date()) {
  return database.transaction(
    (tx) => {
      const user = getSubmissionUser(tx, id);
      if (!user) fail("user_not_found");
      const previous = tx
        .select()
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.action, "member.renewed"),
            eq(auditLogs.targetType, "submission_user"),
            eq(auditLogs.targetId, id),
          ),
        )
        .all()
        .find((row) => {
          try {
            return JSON.parse(row.after ?? "{}").requestId === input.requestId;
          } catch {
            return false;
          }
        });
      if (previous) {
        const recorded = JSON.parse(previous.after!);
        const normalized = renewalSchema.safeParse(recorded.input);
        if (!normalized.success || JSON.stringify(normalized.data) !== JSON.stringify(input))
          fail("renewal_request_conflict");
        return { user, repeated: true };
      }
      const receiptKey = `admin:${id}:${input.requestId}`;
      if (
        tx
          .select({ key: renewalEmailOutbox.key })
          .from(renewalEmailOutbox)
          .where(eq(renewalEmailOutbox.key, receiptKey))
          .get()
      )
        return { user, repeated: true };
      if (isMemberExpiryCleanupPending(tx, id)) fail("renewal_cleanup_pending");
      if (
        user.subscriptionExpiresAt !== input.expectedExpiresAt ||
        (input.expectedDeferredMembershipMs !== undefined &&
          user.deferredMembershipMs !== input.expectedDeferredMembershipMs)
      )
        fail("renewal_expiry_changed");
      if (
        input.expectedDriveExpiryDate !== undefined &&
        (getDriveExpiry(tx)?.date ?? null) !== input.expectedDriveExpiryDate
      )
        fail("renewal_drive_expiry_changed");
      // null means unlimited membership; renewal must never reduce that entitlement.
      if (!user.subscriptionExpiresAt || user.followsDriveExpiry) fail("renewal_unlimited_member");
      const oldExpiry = Date.parse(user.subscriptionExpiresAt);
      if (!Number.isFinite(oldExpiry)) fail("renewal_invalid_expiry");
      const base = membershipGrantBase(user, now);
      const desired =
        input.mode === "days"
          ? new Date(base + input.days * 86_400_000).toISOString()
          : normalizeExpiryDate(input.date);
      if (!desired || Date.parse(desired) <= now.getTime()) fail("renewal_invalid_date");
      if (input.mode === "date" && Date.parse(desired) <= base + user.deferredMembershipMs)
        fail("renewal_date_not_later");
      const target = input.mode === "date" ? fixedGrantTarget(desired, base, user.deferredMembershipMs) : desired;
      const entitlement = applyDriveExpiry(tx, target, user.deferredMembershipMs, now);
      const updated = tx
        .update(submissionUsers)
        .set({
          ...entitlement,
          membershipExpiryLabel: input.expiryLabel,
          membershipReminderState: null,
          membershipRemindedAt: null,
          updatedAt: now.toISOString(),
        })
        .where(eq(submissionUsers.id, id))
        .returning()
        .get()!;
      audit(
        tx,
        "admin",
        "member.renewed",
        "submission_user",
        id,
        {
          subscriptionExpiresAt: user.subscriptionExpiresAt,
          deferredMembershipMs: user.deferredMembershipMs,
          membershipExpiryLabel: user.membershipExpiryLabel,
        },
        { ...entitlement, membershipExpiryLabel: input.expiryLabel, requestId: input.requestId, input },
        input.reason,
      );
      enqueueRenewalReceipt(tx, receiptKey, {
        email: user.email,
        method: entitlement.deferredMembershipMs
          ? "管理员续期"
          : input.mode === "days"
            ? `管理员续期：增加 ${input.days} 天`
            : "管理员续期：指定到期日期",
        previousExpiresAt: user.subscriptionExpiresAt,
        subscriptionExpiresAt: entitlement.subscriptionExpiresAt,
        expiryLabel: visibleMembershipExpiryLabel(updated),
      });
      return { user: updated, repeated: false, previousExpiresAt: user.subscriptionExpiresAt };
    },
    { behavior: "immediate" },
  );
}
