import { eq } from "drizzle-orm";
import type { AppDatabase } from "@emby-task-center/database/client";
import { driveExpirySettings, submissionUsers } from "@emby-task-center/database/schema";
import { normalizeExpiryDate } from "./cards";
import { audit } from "./domain-utils";
import { isMemberExpiryCleanupPending } from "./member-expiry-cleanup-guard";

export interface DriveExpiryLimit {
  date: string;
  expiresAt: string;
}

export interface DriveExpiryEntitlement {
  subscriptionExpiresAt: string | null;
  deferredMembershipMs: number;
  followsDriveExpiry: boolean;
}

export function getDriveExpiry(database: AppDatabase): DriveExpiryLimit | null {
  return (
    database
      .select({ date: driveExpirySettings.date, expiresAt: driveExpirySettings.expiresAt })
      .from(driveExpirySettings)
      .where(eq(driveExpirySettings.id, 1))
      .get() ?? null
  );
}

function capEntitlement(
  requestedExpiry: string | null,
  deferredMembershipMs: number,
  limit: DriveExpiryLimit | null,
  nowMs: number,
): DriveExpiryEntitlement {
  if (!limit) return { subscriptionExpiresAt: requestedExpiry, deferredMembershipMs, followsDriveExpiry: false };
  const requestedMs = requestedExpiry ? Date.parse(requestedExpiry) : NaN;
  // Legacy unparseable expiry values were treated as unlimited by memberStatus.
  if (!Number.isFinite(requestedMs)) {
    return { subscriptionExpiresAt: limit.expiresAt, deferredMembershipMs, followsDriveExpiry: true };
  }
  const limitMs = Date.parse(limit.expiresAt);
  const overflow = Math.max(0, requestedMs - Math.max(limitMs, nowMs));
  const balance = deferredMembershipMs + overflow;
  if (!Number.isSafeInteger(balance) || balance < 0) throw new Error("invalid_deferred_membership");
  return {
    subscriptionExpiresAt: requestedMs > limitMs ? limit.expiresAt : requestedExpiry,
    deferredMembershipMs: balance,
    followsDriveExpiry: false,
  };
}

/** Apply the cap to a new entitlement target that excludes time already in the balance. */
export function applyDriveExpiry(
  database: AppDatabase,
  requestedExpiry: string | null,
  deferredMembershipMs = 0,
  now = new Date(),
): DriveExpiryEntitlement {
  return capEntitlement(requestedExpiry, deferredMembershipMs, getDriveExpiry(database), now.getTime());
}

function releaseDeferredTime(entitlement: DriveExpiryEntitlement, limit: DriveExpiryLimit, nowMs: number): number {
  if (entitlement.followsDriveExpiry || !entitlement.deferredMembershipMs || !entitlement.subscriptionExpiresAt)
    return 0;
  const base = Math.max(Date.parse(entitlement.subscriptionExpiresAt), nowMs);
  const released = Math.min(entitlement.deferredMembershipMs, Math.max(0, Date.parse(limit.expiresAt) - base));
  if (released > 0) {
    entitlement.subscriptionExpiresAt = new Date(base + released).toISOString();
    entitlement.deferredMembershipMs -= released;
  }
  return released;
}

function hasExpired(expiresAt: string | null, nowMs: number): boolean {
  return expiresAt !== null && Date.parse(expiresAt) <= nowMs;
}

export function setDriveExpiry(database: AppDatabase, date: string, now = new Date()) {
  const expiresAt = /^\d{4}-\d{2}-\d{2}$/.test(date) ? normalizeExpiryDate(date) : null;
  if (!expiresAt) throw new Error("invalid_drive_expiry_date");
  const nowMs = now.getTime();
  const timestamp = now.toISOString();
  return database.transaction(
    (tx) => {
      const previous = getDriveExpiry(tx);
      if (previous?.date === date) return { limit: previous, changedMemberIds: [], releasedMembers: 0 };
      const limit = { date, expiresAt };
      const extended = previous && Date.parse(expiresAt) > Date.parse(previous.expiresAt);
      const changedMemberIds: number[] = [];
      let releasedMembers = 0;
      tx.insert(driveExpirySettings)
        .values({ id: 1, ...limit })
        .onConflictDoUpdate({ target: driveExpirySettings.id, set: limit })
        .run();
      for (const row of tx.select().from(submissionUsers).all()) {
        const before: DriveExpiryEntitlement = {
          subscriptionExpiresAt: row.subscriptionExpiresAt,
          deferredMembershipMs: row.deferredMembershipMs,
          followsDriveExpiry: row.followsDriveExpiry,
        };
        const after = capEntitlement(
          row.followsDriveExpiry ? null : row.subscriptionExpiresAt,
          row.deferredMembershipMs,
          limit,
          nowMs,
        );
        if (extended && releaseDeferredTime(after, limit, nowMs) > 0) releasedMembers++;
        const expiryChanged = before.subscriptionExpiresAt !== after.subscriptionExpiresAt;
        if (
          !expiryChanged &&
          before.deferredMembershipMs === after.deferredMembershipMs &&
          before.followsDriveExpiry === after.followsDriveExpiry
        )
          continue;
        if (isMemberExpiryCleanupPending(tx, row.id)) throw new Error("member_cleanup_pending");
        const needsEmbySync =
          Boolean(row.embyUserId) &&
          hasExpired(before.subscriptionExpiresAt, nowMs) !== hasExpired(after.subscriptionExpiresAt, nowMs);
        tx.update(submissionUsers)
          .set({
            ...after,
            driveExpirySyncPending: row.driveExpirySyncPending || needsEmbySync,
            updatedAt: timestamp,
            ...(expiryChanged ? { membershipReminderState: null, membershipRemindedAt: null } : {}),
          })
          .where(eq(submissionUsers.id, row.id))
          .run();
        changedMemberIds.push(row.id);
        audit(tx, "admin", "member.drive_expiry_adjusted", "submission_user", row.id, before, after);
      }
      audit(tx, "admin", "settings.drive_expiry_updated", "drive_expiry_settings", 1, previous, limit);
      return { limit, changedMemberIds, releasedMembers };
    },
    { behavior: "immediate" },
  );
}
