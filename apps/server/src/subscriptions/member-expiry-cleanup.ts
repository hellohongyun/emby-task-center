import { randomUUID } from "node:crypto";
import { and, asc, eq, lte } from "drizzle-orm";
import type { AppDatabase } from "@emby-task-center/database/client";
import { memberExpiryCleanupJobs as jobs, submissionUsers } from "@emby-task-center/database/schema";
import type { EmbyClient } from "../integrations/emby-client";
import { readSetting } from "../settings/store";
import { audit } from "./domain-utils";
import { getSubmissionUser } from "./membership";
import { embyAccountKey, embyRoleChangeInFlight } from "./member-expiry-cleanup-guard";
import {
  cleanupDirectory,
  cleanupEligible,
  cleanupPolicy,
  memberCleanupPlan,
  openCleanupSession,
  type CleanupDirectory,
} from "./member-expiry-cleanup-plan";

const BATCH_SIZE = 20;
const LEASE_MS = 120_000;
type Job = typeof jobs.$inferSelect;
type Member = typeof submissionUsers.$inferSelect;
type Policy = ReturnType<typeof cleanupPolicy>;
type Candidate = ReturnType<typeof memberCleanupPlan>["candidates"][number];
type Result = "deleted" | "pending" | "skipped";

function currentJob(job: Job) {
  return and(eq(jobs.memberId, job.memberId), eq(jobs.leaseToken, job.leaseToken));
}

function releaseJob(database: AppDatabase, job: Job) {
  database.delete(jobs).where(currentJob(job)).run();
}

function protectedAdmin(database: AppDatabase, member: Member) {
  return readSetting(database, "admin.username").trim().toLowerCase() === member.email.toLowerCase();
}

function removeMember(database: AppDatabase, member: Member, embyAbsent: boolean) {
  database.delete(submissionUsers).where(eq(submissionUsers.id, member.id)).run();
  audit(
    database,
    "system",
    "member.expiry_cleanup_deleted",
    "submission_user",
    member.id,
    {
      email: member.email,
      expiresAt: member.subscriptionExpiresAt,
      embyUserId: member.embyUserId,
    },
    { embyAbsent },
  );
}

function finishJob(database: AppDatabase, job: Job, now: Date): Result {
  return database.transaction(
    (tx) => {
      if (!tx.select().from(jobs).where(currentJob(job)).get()) return "skipped";
      const member = getSubmissionUser(tx, job.memberId);
      const safe =
        member &&
        member.embyUserId === job.embyUserId &&
        cleanupEligible(member, 1, now) &&
        !protectedAdmin(tx, member);
      if (safe) removeMember(tx, member, true);
      releaseJob(tx, job);
      return safe ? "deleted" : "skipped";
    },
    { behavior: "immediate" },
  );
}

function leaseJob(database: AppDatabase, input: Omit<Job, "leaseToken" | "leaseUntil">, existing?: Job): Job | null {
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

function sameBinding(database: AppDatabase, member: Member) {
  if (!member.embyUserId) return true;
  const key = embyAccountKey(member.embyUserId);
  return !database
    .select({ id: submissionUsers.id, embyUserId: submissionUsers.embyUserId })
    .from(submissionUsers)
    .all()
    .some((row) => row.id !== member.id && row.embyUserId && embyAccountKey(row.embyUserId) === key);
}

function stillEligible(database: AppDatabase, id: number, embyUserId: string | null, policy: Policy, now: Date) {
  const current = cleanupPolicy(database);
  if (!current.days || current.revision !== policy.revision) return null;
  const member = getSubmissionUser(database, id);
  return member &&
    member.embyUserId === embyUserId &&
    (!embyUserId || !embyRoleChangeInFlight(database, embyUserId)) &&
    cleanupEligible(member, current.days, now) &&
    !protectedAdmin(database, member) &&
    sameBinding(database, member)
    ? member
    : null;
}

async function confirmedAbsent(directory: CleanupDirectory, embyUserId: string) {
  return (
    (await directory.session.readRole(embyUserId)) === "missing" &&
    (await directory.session.serverId()) === directory.serverId
  );
}

async function runRemoteDelete(
  database: AppDatabase,
  directory: CleanupDirectory,
  job: Job,
  now: Date,
  allowDelete: () => boolean,
  resumed = false,
): Promise<Result> {
  try {
    if ((await directory.session.serverId()) !== job.serverId) throw new Error("emby_cleanup_server_changed");
  } catch {
    if (resumed) return "pending";
    releaseJob(database, job);
    return "skipped";
  }
  try {
    await directory.session.deleteAccount(job.embyUserId, allowDelete);
  } catch (error) {
    const failure = error as { deleteStarted?: boolean; status?: number } | undefined;
    if (failure?.deleteStarted === false || failure?.status === 401 || failure?.status === 403) {
      releaseJob(database, job);
      return "skipped";
    }
    // A lost response might hide a successful deletion. Keep the durable claim.
    return "pending";
  }
  try {
    if (await confirmedAbsent(directory, job.embyUserId)) return finishJob(database, job, now);
  } catch {
    // A subsequent round can reconcile the claim against the same server.
  }
  return "pending";
}

export async function sweepMemberExpiryCleanup(
  database: AppDatabase,
  emby: EmbyClient | undefined,
  now = new Date(),
  running = () => true,
  progress = { lastLinkedMemberId: 0 },
) {
  const counts = { deleted: 0, pending: 0, skipped: 0 };
  const policy = cleanupPolicy(database);
  const unresolved = Boolean(database.select({ id: jobs.memberId }).from(jobs).limit(1).get());
  if (!policy.days && !unresolved) return counts;
  const directory = await cleanupDirectory(database, emby);
  const isConnected = () => directory && openCleanupSession(database, emby)?.identity === directory.session.identity;
  const allows = (job: Job) =>
    Boolean(
      running() &&
      isConnected() &&
      job.leaseUntil > Date.now() &&
      database.select().from(jobs).where(currentJob(job)).get() &&
      policy.serverId === job.serverId &&
      stillEligible(database, job.memberId, job.embyUserId, policy, now),
    );

  const resumed = new Set<number>();
  if (directory) {
    const expired = database
      .select()
      .from(jobs)
      .where(and(eq(jobs.serverId, directory.serverId), lte(jobs.leaseUntil, Date.now())))
      .orderBy(asc(jobs.leaseUntil), asc(jobs.memberId))
      .limit(BATCH_SIZE)
      .all();
    for (const previous of expired) {
      if (!running() || !isConnected()) break;
      const job = leaseJob(database, previous, previous);
      if (!job) continue;
      resumed.add(job.memberId);
      let role: Awaited<ReturnType<CleanupDirectory["session"]["readRole"]>>;
      try {
        role = await directory.session.readRole(job.embyUserId);
        if ((await directory.session.serverId()) !== job.serverId) throw new Error("emby_cleanup_server_changed");
      } catch {
        counts.pending++;
        continue;
      }
      if (role === "missing") counts[finishJob(database, job, now)]++;
      else if (role === "administrator" || (role === "ordinary" && !allows(job))) {
        releaseJob(database, job);
        counts.skipped++;
      } else if (role === "ordinary")
        counts[await runRemoteDelete(database, directory, job, now, () => allows(job), true)]++;
      else counts.pending++;
    }
  }

  if (!policy.days || !running() || cleanupPolicy(database).revision !== policy.revision) return counts;
  const boundDirectory = directory?.serverId === policy.serverId ? directory : null;
  const plan = memberCleanupPlan(database, policy.days, now, directory, Boolean(boundDirectory));
  const due = plan.candidates.filter(({ id }) => !resumed.has(id));
  // Local-only removals cannot be starved by a broken or unavailable Emby connection.
  const linked = due.filter(({ linked }) => linked);
  const split = linked.findIndex(({ id }) => id > progress.lastLinkedMemberId);
  const rotated = split > 0 ? [...linked.slice(split), ...linked.slice(0, split)] : linked;
  const batch = [...due.filter(({ linked }) => !linked).slice(0, BATCH_SIZE), ...rotated.slice(0, BATCH_SIZE)];
  for (const candidate of batch) {
    if (!running() || cleanupPolicy(database).revision !== policy.revision) break;
    if (!candidate.embyUserId) {
      counts[removeLocalCandidate(database, candidate, policy, now)]++;
      continue;
    }
    if (!boundDirectory || !isConnected()) continue;
    progress.lastLinkedMemberId = candidate.id;
    // Only a verified point lookup can prove a stale binding's account is absent.
    const known = boundDirectory.accounts.some(
      ({ id }) => embyAccountKey(id) === embyAccountKey(candidate.embyUserId!),
    );
    if (!known) {
      let absent = false;
      try {
        absent = await confirmedAbsent(boundDirectory, candidate.embyUserId);
      } catch {
        /* retry */
      }
      if (absent && running() && isConnected()) counts[removeLocalCandidate(database, candidate, policy, now, true)]++;
      else counts.skipped++;
      continue;
    }
    const job = database.transaction(
      (tx) => {
        const member = stillEligible(tx, candidate.id, candidate.embyUserId, policy, now);
        if (!member || member.subscriptionExpiresAt !== candidate.expiresAt) return null;
        return leaseJob(tx, {
          memberId: member.id,
          serverId: boundDirectory.serverId,
          embyUserId: candidate.embyUserId!,
        });
      },
      { behavior: "immediate" },
    );
    if (job) counts[await runRemoteDelete(database, boundDirectory, job, now, () => allows(job))]++;
  }
  return counts;
}

function removeLocalCandidate(
  database: AppDatabase,
  candidate: Candidate,
  policy: Policy,
  now: Date,
  embyAbsent = false,
): Result {
  return database.transaction(
    (tx) => {
      const member = stillEligible(tx, candidate.id, candidate.embyUserId, policy, now);
      if (
        !member ||
        member.subscriptionExpiresAt !== candidate.expiresAt ||
        tx.select().from(jobs).where(eq(jobs.memberId, candidate.id)).get()
      )
        return "skipped";
      removeMember(tx, member, embyAbsent);
      return "deleted";
    },
    { behavior: "immediate" },
  );
}
