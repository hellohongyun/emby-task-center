import { and, asc, eq, lte } from "drizzle-orm";
import type { AppDatabase } from "@emby-task-center/database/client";
import { memberExpiryCleanupJobs as jobs } from "@emby-task-center/database/schema";
import type { EmbyClient } from "../integrations/emby-client";
import {
  currentJob,
  finishJob,
  leaseJob,
  protectedAdmin,
  releaseJob,
  removeMember,
  sameBinding,
  type CleanupJob,
} from "./member-cleanup-jobs";
import { getSubmissionUser } from "./membership";
import { embyAccountKey, embyRoleChangeInFlight } from "./member-expiry-cleanup-guard";
import {
  cleanupDirectory,
  cleanupEligible,
  cleanupPolicy,
  memberCleanupPlan,
  openCleanupSession,
  type CleanupDirectory,
  type CleanupKind,
} from "./member-expiry-cleanup-plan";
import { readMemberPlaybackEvidence } from "./member-inactivity-activity";
import {
  inactivityGraceElapsed,
  loadCleanupPlayback,
  memberInactivityCleanupPlan,
  playbackIsStale,
} from "./member-inactivity-cleanup-plan";

const BATCH_SIZE = 20;
type Policy = ReturnType<typeof cleanupPolicy> & { kind: CleanupKind };
type Candidate = ReturnType<typeof memberCleanupPlan>["candidates"][number];
type Result = "deleted" | "pending" | "skipped";

function stillEligible(database: AppDatabase, id: number, embyUserId: string | null, policy: Policy, now: Date) {
  const current = cleanupPolicy(database, policy.kind);
  if (!current.days || current.revision !== policy.revision) return null;
  const member = getSubmissionUser(database, id);
  return member &&
    member.embyUserId === embyUserId &&
    (!embyUserId || !embyRoleChangeInFlight(database, embyUserId)) &&
    (policy.kind === "inactivity"
      ? inactivityGraceElapsed(member, current.days, now)
      : cleanupEligible(member, current.days, now)) &&
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
  job: CleanupJob,
  now: Date,
  guards: {
    allowDelete: () => boolean;
    verifyBeforeDelete?: () => Promise<boolean>;
    canFinalize: () => boolean;
  },
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
    await directory.session.deleteAccount(job.embyUserId, guards.allowDelete, guards.verifyBeforeDelete, job.serverId);
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
    if ((await confirmedAbsent(directory, job.embyUserId)) && guards.canFinalize())
      return finishJob(database, job, now);
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
  return sweepMemberCleanup("expiry", database, emby, now, running, progress);
}

export async function sweepMemberCleanup(
  kind: CleanupKind,
  database: AppDatabase,
  emby: EmbyClient | undefined,
  now: Date,
  running: () => boolean,
  progress: { lastLinkedMemberId: number },
) {
  const counts = { deleted: 0, pending: 0, skipped: 0 };
  const policy = { ...cleanupPolicy(database, kind), kind };
  const unresolved = Boolean(database.select({ id: jobs.memberId }).from(jobs).where(eq(jobs.kind, kind)).get());
  if (!policy.days && !unresolved) return counts;
  const directory = await cleanupDirectory(database, emby);
  const isConnected = () => directory && openCleanupSession(database, emby)?.identity === directory.session.identity;
  const canFinalize = () => running() && Boolean(isConnected());
  const allows = (job: CleanupJob) =>
    Boolean(
      running() &&
      isConnected() &&
      job.leaseUntil > Date.now() &&
      database.select().from(jobs).where(currentJob(job)).get() &&
      policy.serverId === job.serverId &&
      stillEligible(database, job.memberId, job.embyUserId, policy, now),
    );
  const verifyPlayback = (job: CleanupJob) =>
    kind === "inactivity" && directory
      ? async () => {
          if (!policy.days || !allows(job)) return false;
          const evidence = await readMemberPlaybackEvidence(database, directory.session, job.embyUserId);
          return Boolean(evidence && playbackIsStale(evidence, policy.days, now));
        }
      : undefined;

  const resumed = new Set<number>();
  if (directory) {
    const expired = database
      .select()
      .from(jobs)
      .where(and(eq(jobs.kind, kind), eq(jobs.serverId, directory.serverId), lte(jobs.leaseUntil, Date.now())))
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
      if (!canFinalize()) {
        counts.pending++;
        continue;
      }
      if (role === "missing") counts[finishJob(database, job, now)]++;
      else if (role === "administrator" || (role === "ordinary" && !allows(job))) {
        releaseJob(database, job);
        counts.skipped++;
      } else if (role === "ordinary")
        counts[
          await runRemoteDelete(
            database,
            directory,
            job,
            now,
            {
              allowDelete: () => allows(job),
              verifyBeforeDelete: verifyPlayback(job),
              canFinalize,
            },
            true,
          )
        ]++;
      else counts.pending++;
    }
  }

  const current = () => running() && cleanupPolicy(database, kind).revision === policy.revision;
  if (!policy.days || !current()) return counts;
  const boundDirectory = directory?.serverId === policy.serverId ? directory : null;
  const plan =
    kind === "expiry"
      ? memberCleanupPlan(database, policy.days, now, directory, Boolean(boundDirectory))
      : boundDirectory &&
        (await inactivityPlan(database, policy.days, now, boundDirectory, () => current() && !!isConnected()));
  if (!plan) return counts;
  const due = plan.candidates.filter(({ id }) => !resumed.has(id));
  // Local-only removals cannot be starved by a broken or unavailable Emby connection.
  const linked = due.filter(({ embyUserId }) => embyUserId);
  const split = linked.findIndex(({ id }) => id > progress.lastLinkedMemberId);
  const rotated = split > 0 ? [...linked.slice(split), ...linked.slice(0, split)] : linked;
  const batch = [...due.filter(({ embyUserId }) => !embyUserId).slice(0, BATCH_SIZE), ...rotated.slice(0, BATCH_SIZE)];
  for (const candidate of batch) {
    if (!current()) break;
    if (!candidate.embyUserId) {
      if ("expiresAt" in candidate) counts[removeLocalCandidate(database, candidate, policy, now)]++;
      continue;
    }
    if (!boundDirectory || !isConnected()) continue;
    progress.lastLinkedMemberId = candidate.id;
    // Only a verified point lookup can prove a stale binding's account is absent.
    const known = boundDirectory.accounts.some(
      ({ id }) => embyAccountKey(id) === embyAccountKey(candidate.embyUserId!),
    );
    if (!known && "expiresAt" in candidate) {
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
        if (
          !member ||
          ("expiresAt" in candidate
            ? member.subscriptionExpiresAt !== candidate.expiresAt
            : member.createdAt !== candidate.createdAt)
        )
          return null;
        return leaseJob(tx, {
          memberId: member.id,
          serverId: boundDirectory.serverId,
          embyUserId: candidate.embyUserId!,
          kind,
        });
      },
      { behavior: "immediate" },
    );
    if (job)
      counts[
        await runRemoteDelete(database, boundDirectory, job, now, {
          allowDelete: () => allows(job),
          verifyBeforeDelete: verifyPlayback(job),
          canFinalize,
        })
      ]++;
  }
  return counts;
}

async function inactivityPlan(
  database: AppDatabase,
  days: number,
  now: Date,
  directory: CleanupDirectory,
  running: () => boolean,
) {
  const playback = await loadCleanupPlayback(database, directory, days, now, running);
  return playback && running() ? memberInactivityCleanupPlan(database, days, now, directory, playback) : null;
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
      removeMember(tx, member, embyAbsent, policy.kind);
      return "deleted";
    },
    { behavior: "immediate" },
  );
}
