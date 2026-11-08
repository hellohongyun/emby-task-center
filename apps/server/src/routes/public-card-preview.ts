import type { AppDatabase } from "@emby-task-center/database/client";
import type { submissionUsers } from "@emby-task-center/database/schema";
import { expiryDisplay, type CardInspection } from "../subscriptions/cards";
import { getDriveExpiry } from "../subscriptions/drive-expiry";
import { cardMembershipExpiry, visibleMembershipExpiryLabel } from "../subscriptions/membership-expiry-grant";

export function publicCardPreview(
  database: AppDatabase,
  inspection: Extract<CardInspection, { ok: true }>,
  user: typeof submissionUsers.$inferSelect | null,
  now: Date,
) {
  const entitlement = getDriveExpiry(database)
    ? inspection.idempotent && user
      ? user
      : cardMembershipExpiry(database, inspection, user, now)
    : null;
  const expiresAt = entitlement ? entitlement.subscriptionExpiresAt : inspection.expiresAt;
  const expiryLabel = entitlement
    ? visibleMembershipExpiryLabel({ ...entitlement, membershipExpiryLabel: inspection.expiryLabel })
    : inspection.expiryLabel;
  const expiry = expiryDisplay({ expiresAt, expiryLabel, days: inspection.days }, now);
  return {
    kind: inspection.kind,
    label: inspection.label,
    days: inspection.days,
    idempotent: inspection.idempotent,
    name: inspection.name,
    expiresAt,
    expiryLabel,
    expiryText: expiry.text,
    expiryDetail: expiry.detail,
    expiryDays: expiry.days,
    blessing: inspection.blessing,
  };
}
