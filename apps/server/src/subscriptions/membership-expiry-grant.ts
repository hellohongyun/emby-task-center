import type { AppDatabase } from "@emby-task-center/database/client";
import { resolveMembershipExpiry, type RedeemResult } from "./cards";
import { applyDriveExpiry } from "./drive-expiry";

type Entitlement = {
  subscriptionExpiresAt: string | null;
  deferredMembershipMs: number;
  followsDriveExpiry: boolean;
};

export function isUnlimitedMembership(user: Entitlement | null): boolean {
  return Boolean(user && (user.followsDriveExpiry || !Number.isFinite(Date.parse(user.subscriptionExpiresAt ?? ""))));
}

export function membershipGrantBase(user: Entitlement | null, now: Date): number {
  const expiry = Date.parse(user?.subscriptionExpiresAt ?? "");
  return Number.isFinite(expiry) ? Math.max(now.getTime(), expiry) : now.getTime();
}

/** A fixed date tops up the total entitlement, including previously saved time. */
export function fixedGrantTarget(target: string, base: number, deferred: number): string {
  return new Date(Math.max(base, Date.parse(target) - deferred)).toISOString();
}

export function cardMembershipExpiry(
  database: AppDatabase,
  card: Pick<RedeemResult, "expiresAt" | "days">,
  existing: Entitlement | null,
  now: Date,
): Entitlement {
  if (existing && isUnlimitedMembership(existing)) {
    const { subscriptionExpiresAt, deferredMembershipMs, followsDriveExpiry } = existing;
    return { subscriptionExpiresAt, deferredMembershipMs, followsDriveExpiry };
  }
  const base = membershipGrantBase(existing, now);
  const deferred = existing?.deferredMembershipMs ?? 0;
  const target = resolveMembershipExpiry(card, base);
  return applyDriveExpiry(database, card.expiresAt ? fixedGrantTarget(target, base, deferred) : target, deferred, now);
}

/** A label on an uncapped grant may describe a different date than the usable expiry. */
export function visibleMembershipExpiryLabel(user: {
  membershipExpiryLabel?: string | null;
  deferredMembershipMs?: number;
  followsDriveExpiry?: boolean;
}): string | null {
  return user.deferredMembershipMs || user.followsDriveExpiry ? null : (user.membershipExpiryLabel ?? null);
}
