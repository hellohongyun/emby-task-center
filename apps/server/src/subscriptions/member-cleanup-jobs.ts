import { randomUUID } from "node:crypto";
import { and, eq, lte } from "drizzle-orm";
import type { AppDatabase } from "@emby-task-center/database/client";
import { memberExpiryCleanupJobs as jobs, submissionUsers } from "@emby-task-center/database/schema";
import { readSetting } from "../settings/store";
import { audit } from "./domain-utils";
import { getSubmissionUser } from "./membership";
import { embyAccountKey } from "./member-expiry-cleanup-guard";
import { cleanupEligible, type CleanupKind, type CleanupMember } from "./member-expiry-cleanup-plan";

const LEASE_MS = 120_000;
export type CleanupJob = typeof jobs.$inferSelect;

export function currentJob(job: CleanupJob) {
  return and(eq(jobs.memberId, job.memberId), eq(jobs.leaseToken, job.leaseToken));
}

export function releaseJob(database: AppDatabase, job: CleanupJob) {
  database.delete(jobs).where(currentJob(job)).run();
}

export function protectedAdmin(database: AppDatabase, member: CleanupMember) {
  return readSetting(database, "admin.username").trim().toLowerCase() === member.email.toLowerCase();
}

export function removeMember(database: AppDatabase, member: CleanupMember, embyAbsent: boolean, kind: CleanupKind) {
  database.delete(submissionUsers).where(eq(submissionUsers.id, member.id)).run();
  audit(
    database,
    "system",
    `member.${kind}_cleanup_deleted`,
    "submission_user",
    member.id,
    { email: member.email, expiresAt: member.subscriptionExpiresAt, embyUserId: member.embyUserId },
    { embyAbsent },
  );
}

export function finishJob(database: AppDatabase, job: CleanupJob, now: Date) {
  return database.transaction(
    (tx) => {
      if (!tx.select().from(jobs).where(currentJob(job)).get()) return "skipped";
      const member = getSubmissionUser(tx, job.memberId);
      const safe =
        member &&
        member.embyUserId === job.embyUserId &&
        (job.kind === "inactivity" ? sameBinding(tx, member) : cleanupEligible(member, 1, now)) &&
        !protectedAdmin(tx, member);
      if (safe) removeMember(tx, member, true, job.kind);
      releaseJob(tx, job);
      return safe ? "deleted" : "skipped";
    },
    { behavior: "immediate" },
  );
}

export function leaseJob(
  database: AppDatabase,
  input: Omit<CleanupJob, "leaseToken" | "leaseUntil">,
  existing?: CleanupJob,
): CleanupJob | null {
  const now = Date.now();
  const leased = { ...input, leaseToken: randomUUID(), leaseUntil: now + LEASE_MS };
  if (existing) {
    const updated = database
      .update(jobs)
      .set({ leaseToken: leased.leaseToken, leaseUntil: leased.leaseUntil })
      .where(and(currentJob(existing), lte(jobs.leaseUntil, now)))
      .run();
    return updated.changes === 1 ? leased : null;
  }
  return database.insert(jobs).values(leased).onConflictDoNothing().returning().get() ?? null;
}

export function sameBinding(database: AppDatabase, member: CleanupMember) {
  if (!member.embyUserId) return true;
  const key = embyAccountKey(member.embyUserId);
  return !database
    .select({ id: submissionUsers.id, embyUserId: submissionUsers.embyUserId })
    .from(submissionUsers)
    .all()
    .some((row) => row.id !== member.id && row.embyUserId && embyAccountKey(row.embyUserId) === key);
}
