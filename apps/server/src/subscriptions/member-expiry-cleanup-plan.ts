import { randomUUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import type { AppDatabase } from "@emby-task-center/database/client";
import { memberExpiryCleanupJobs, memberExpiryCleanupPolicy, submissionUsers } from "@emby-task-center/database/schema";
import type { EmbyClient } from "../integrations/emby-client";
import type { EmbyMemberCleanupSession } from "../integrations/emby-member-cleanup-client";
import { readSetting } from "../settings/store";
import { audit } from "./domain-utils";
import { embyAccountKey, embyRoleChangeInFlight } from "./member-expiry-cleanup-guard";

export const MAX_EXPIRY_CLEANUP_DAYS = 3650;
const DAY_MS = 86_400_000;
type Member = typeof submissionUsers.$inferSelect;
type Account = Awaited<ReturnType<EmbyMemberCleanupSession["listAccounts"]>>[number];

export function cleanupPolicy(database: AppDatabase) {
  const stored = database.select().from(memberExpiryCleanupPolicy).where(eq(memberExpiryCleanupPolicy.id, 1)).get();
  return { days: stored?.days ?? null, serverId: stored?.serverId ?? null, revision: stored?.revision ?? null };
}

export function saveCleanupPolicy(database: AppDatabase, days: number | null, serverId: string | null) {
  const before = cleanupPolicy(database);
  if (before.days === days && before.serverId === serverId) return;
  const values = { days, serverId, revision: randomUUID() };
  database
    .insert(memberExpiryCleanupPolicy)
    .values({ id: 1, ...values })
    .onConflictDoUpdate({ target: memberExpiryCleanupPolicy.id, set: values })
    .run();
  audit(
    database,
    "admin",
    "member.expiry_cleanup_policy_changed",
    "member_expiry_cleanup",
    undefined,
    { days: before.days },
    { days },
  );
}

export function cleanupEligible(
  member: Member,
  days: number,
  now: Date,
): member is Member & { subscriptionExpiresAt: string } {
  if (member.deferredMembershipMs !== 0 || member.followsDriveExpiry || !member.subscriptionExpiresAt) return false;
  const expiry = Date.parse(member.subscriptionExpiresAt);
  return Number.isFinite(expiry) && expiry <= now.getTime() - days * DAY_MS;
}

export function openCleanupSession(database: AppDatabase, emby: EmbyClient | undefined) {
  return readSetting(database, "emby.enabled") ? emby?.openMemberCleanupSession?.() : undefined;
}

export type CleanupDirectory = { serverId: string; session: EmbyMemberCleanupSession; accounts: Account[] };

export async function cleanupDirectory(
  database: AppDatabase,
  emby: EmbyClient | undefined,
): Promise<CleanupDirectory | null> {
  const session = openCleanupSession(database, emby);
  if (!session) return null;
  try {
    const serverId = await session.serverId();
    const accounts = await session.listAccounts();
    return openCleanupSession(database, emby)?.identity === session.identity ? { serverId, session, accounts } : null;
  } catch {
    return null;
  }
}

export type CleanupBlockedReason = "administrator" | "role_unverified" | "linked_elsewhere" | "cleanup_in_progress";

export function memberCleanupPlan(
  database: AppDatabase,
  days: number,
  now: Date,
  directory: CleanupDirectory | null,
  allowLinked = Boolean(directory),
) {
  const members = database.select().from(submissionUsers).orderBy(asc(submissionUsers.id)).all();
  const pending = new Set(
    database
      .select({ id: memberExpiryCleanupJobs.memberId })
      .from(memberExpiryCleanupJobs)
      .all()
      .map(({ id }) => id),
  );
  const adminUsername = readSetting(database, "admin.username").trim().toLowerCase();
  const accounts = new Map(directory?.accounts.map((account) => [embyAccountKey(account.id), account]));
  const adminNames = new Set(
    directory?.accounts.filter(({ role }) => role === "administrator").map(({ name }) => name.toLowerCase()),
  );
  const links = new Map<string, number>();
  for (const { embyUserId } of members) {
    if (embyUserId) {
      const key = embyAccountKey(embyUserId);
      links.set(key, (links.get(key) ?? 0) + 1);
    }
  }
  const candidates: Array<{
    id: number;
    email: string;
    expiresAt: string;
    linked: boolean;
    embyUserId: string | null;
  }> = [];
  const blocked: Array<{ id: number; email: string; expiresAt: string; reason: CleanupBlockedReason }> = [];
  for (const member of members) {
    if (!cleanupEligible(member, days, now)) continue;
    const { id, email, embyUserId, subscriptionExpiresAt: expiresAt } = member;
    const accountKey = embyUserId ? embyAccountKey(embyUserId) : "";
    const role = accounts.get(accountKey)?.role;
    let reason: CleanupBlockedReason | undefined;
    if (
      email.toLowerCase() === adminUsername ||
      role === "administrator" ||
      (!embyUserId && adminNames.has((member.embyUsername ?? email).toLowerCase()))
    )
      reason = "administrator";
    else if (pending.has(id)) reason = "cleanup_in_progress";
    else if (embyUserId && (links.get(accountKey) ?? 0) > 1) reason = "linked_elsewhere";
    else if (embyUserId && (!allowLinked || role === "unknown" || embyRoleChangeInFlight(database, embyUserId)))
      reason = "role_unverified";
    if (reason) blocked.push({ id, email, expiresAt, reason });
    else candidates.push({ id, email, expiresAt, linked: Boolean(embyUserId), embyUserId });
  }
  return { candidates, blocked };
}
