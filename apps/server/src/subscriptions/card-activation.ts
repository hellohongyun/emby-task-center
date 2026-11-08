import { eq } from "drizzle-orm";
import type { AppDatabase } from "@emby-task-center/database/client";
import { submissionUsers } from "@emby-task-center/database/schema";
import { redeemCard } from "./cards";
import { getSubmissionUserByEmail } from "./membership";
import { queueCardRenewalReceipt } from "./card-renewal-receipt";
import { readSetting } from "../settings/store";
import { cardMembershipExpiry, isUnlimitedMembership, visibleMembershipExpiryLabel } from "./membership-expiry-grant";
import { isMemberExpiryCleanupPending } from "./member-expiry-cleanup-guard";

/** Only synchronous SQLite changes belong here; SMTP and Emby run after commit. */
export function activateMembershipWithCard(database: AppDatabase, code: string, email: string, now = new Date()) {
  return database.transaction(
    (tx) => {
      const existing = getSubmissionUserByEmail(tx, email);
      if (existing?.enabled === false) throw Object.assign(new Error("member_disabled"), { status: 403 });
      const card = redeemCard(tx, code, email, now);
      if (card.idempotent) return { card, existing, receiptKey: null };
      // Rejecting here also rolls back the redemption made above in this transaction.
      if (existing && isMemberExpiryCleanupPending(tx, existing.id)) throw new Error("member_cleanup_pending");
      if (isUnlimitedMembership(existing)) throw Object.assign(new Error("member_renewal_not_needed"), { status: 409 });
      const entitlement = cardMembershipExpiry(tx, card, existing, now);
      const expiryLabel = card.expiryLabel ?? null;
      const timestamp = now.toISOString();
      let receiptKey: string | null = null;
      if (existing) {
        tx.update(submissionUsers)
          .set({
            ...entitlement,
            membershipExpiryLabel: expiryLabel,
            membershipReminderState: null,
            membershipRemindedAt: null,
            updatedAt: timestamp,
          })
          .where(eq(submissionUsers.id, existing.id))
          .run();
        receiptKey = queueCardRenewalReceipt(
          tx,
          card,
          existing,
          entitlement.subscriptionExpiresAt,
          visibleMembershipExpiryLabel({ ...entitlement, membershipExpiryLabel: expiryLabel }),
          !entitlement.deferredMembershipMs && !entitlement.followsDriveExpiry,
        );
      } else {
        tx.insert(submissionUsers)
          .values({
            email,
            ...entitlement,
            membershipExpiryLabel: expiryLabel,
            enabled: true,
            embyMaxStreams: readSetting(tx, "member.newMemberMaxStreams"),
            note: `卡密开通(${card.kind})`,
            createdAt: timestamp,
            updatedAt: timestamp,
          })
          .run();
      }
      return { card, existing, receiptKey };
    },
    { behavior: "immediate" },
  );
}
