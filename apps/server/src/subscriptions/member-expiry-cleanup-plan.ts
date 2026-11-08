import { randomUUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import type { AppDatabase } from "@emby-task-center/database/client";
import {
  memberExpiryCleanupJobs,
  memberExpiryCleanupPolicy,
  memberInactivityCleanupPolicy,
  submissionUsers,
} from "@emby-task-center/database/schema";
import type { EmbyClient } from "../integrations/emby-client";
import type { EmbyMemberCleanupSession } from "../integrations/emby-member-cleanup-client";
import { readSetting } from "../settings/store";
import { audit } from "./domain-utils";
import { embyAccountKey, embyRoleChangeInFlight } from "./member-expiry-cleanup-guard";

export const MAX_EXPIRY_CLEANUP_DAYS = 3650;
export const CLEANUP_DAY_MS = 86_400_000;
export type CleanupMember = typeof submissionUsers.$inferSelect;
export type CleanupKind = (typeof memberExpiryCleanupJobs.$inferSelect)["kind"];
type Account = Awaited<ReturnType<EmbyMemberCleanupSession["listAccounts"]>>[number];

function policyTable(kind: CleanupKind) {
  return kind === "expiry" ? memberExpiryCleanupPolicy : memberInactivityCleanupPolicy;
}

export function cleanupPolicy(database: AppDatabase, kind: CleanupKind = "expiry") {
  const table = policyTable(kind);
  const stored = database.select().from(table).where(eq(table.id, 1)).get();
  return { days: stored?.days ?? null, serverId: stored?.serverId ?? null, revision: stored?.revision ?? null };
}

export function saveCleanupPolicy(
  database: AppDatabase,
  days: number | null,
  serverId: string | null,
  kind: CleanupKind = "expiry",
) {
  const before = cleanupPolicy(database, kind);
  if (before.days === days && before.serverId === serverId) return;
  const table = policyTable(kind);
  const values = { days, serverId, revision: randomUUID() };
  database
    .insert(table)
    .values({ id: 1, ...values })
    .onConflictDoUpdate({ target: table.id, set: values })
    .run();
  audit(
    database,
    "admin",
    `member.${kind}_cleanup_policy_changed`,
    `member_${kind}_cleanup`,
    undefined,
    { days: before.days },
    { days },
  );
}

export function cleanupEligible(
  member: CleanupMember,
  days: number,
  now: Date,
): member is CleanupMember & { subscriptionExpiresAt: string } {
  if (member.deferredMembershipMs !== 0 || member.followsDriveExpiry || !member.subscriptionExpiresAt) return false;
  const expiry = Date.parse(member.subscriptionExpiresAt);
  return Number.isFinite(expiry) && expiry <= now.getTime() - days * CLEANUP_DAY_MS;
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

export type CleanupBlockedReason =
  "administrator" | "role_unverified" | "linked_elsewhere" | "cleanup_in_progress" | "activity_unverified";

export function memberCleanupContext(database: AppDatabase, directory: CleanupDirectory | null) {
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
  function blockedReason(
    member: CleanupMember,
    allowLinked: boolean,
    requireExisting = false,
  ): CleanupBlockedReason | undefined {
    const { id, email, embyUserId } = member;
    const accountKey = embyUserId ? embyAccountKey(embyUserId) : "";
    const role = accounts.get(accountKey)?.role;
    if (
      email.toLowerCase() === adminUsername ||
      role === "administrator" ||
      (!embyUserId && adminNames.has((member.embyUsername ?? email).toLowerCase()))
    )
      return "administrator";
    if (pending.has(id)) return "cleanup_in_progress";
    if (embyUserId && (links.get(accountKey) ?? 0) > 1) return "linked_elsewhere";
    if (
      embyUserId &&
      (!allowLinked || role === "unknown" || (requireExisting && !role) || embyRoleChangeInFlight(database, embyUserId))
    )
      return "role_unverified";
  }
  return { members, blockedReason };
}

export function memberCleanupPlan(
  database: AppDatabase,
  days: number,
  now: Date,
  directory: CleanupDirectory | null,
  allowLinked = Boolean(directory),
) {
  const { members, blockedReason } = memberCleanupContext(database, directory);
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
    const reason = blockedReason(member, allowLinked);
    if (reason) blocked.push({ id, email, expiresAt, reason });
    else candidates.push({ id, email, expiresAt, linked: Boolean(embyUserId), embyUserId });
  }
  return { candidates, blocked };
}
