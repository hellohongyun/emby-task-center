import { and, asc, count, desc, eq, gt, gte, inArray, lte, or, sql, type SQL } from "drizzle-orm";
import type { AppDatabase } from "@emby-task-center/database/client";
import { share115Submissions, share115TransferJobs } from "@emby-task-center/database/schema";

type Submission = typeof share115Submissions.$inferSelect;
export type Share115Job = typeof share115TransferJobs.$inferSelect;
export type Share115Status = Share115Job["status"];
export type Share115SubmissionRow = Omit<Share115Job, "id"> & Submission;
const activeStatuses = ["queued", "running", "unconfirmed"] as const;
type EnqueueInput = Pick<Submission, "memberId" | "memberEmail" | "note"> &
  Pick<Share115Job, "shareUrl" | "shareCode" | "accessCode"> & { now: string; adminUsername?: string };
type AdmissionLimits = { since: string; maxPerMember: number; maxPending: number };

export class Share115AdmissionError extends Error {
  constructor(public readonly code: "rate_limited" | "queue_full") {
    super(code);
  }
}

export function enqueueShare115(
  database: Pick<AppDatabase, "transaction">,
  input: EnqueueInput,
  limits?: AdmissionLimits,
): Share115SubmissionRow {
  const { memberId, memberEmail, adminUsername, note, shareUrl, shareCode, accessCode, now } = input;
  const validSubmitter =
    memberId === 0
      ? memberEmail === "" && adminUsername !== undefined && adminUsername.length > 0 && adminUsername.length <= 64
      : Number.isSafeInteger(memberId) && memberId > 0 && adminUsername === undefined;
  if (!validSubmitter) throw new Error("Invalid 115 share submitter identity");
  return database.transaction(
    (tx) => {
      let job = tx
        .select()
        .from(share115TransferJobs)
        .where(
          and(
            eq(share115TransferJobs.shareCode, shareCode),
            eq(share115TransferJobs.accessCode, accessCode),
            inArray(share115TransferJobs.status, activeStatuses),
          ),
        )
        .get();
      if (job) {
        const existing = tx
          .select()
          .from(share115Submissions)
          .where(and(eq(share115Submissions.jobId, job.id), eq(share115Submissions.memberId, memberId)))
          .get();
        if (existing) return { ...job, ...existing };
      }
      if (limits) {
        const recent = tx
          .select({ total: count() })
          .from(share115Submissions)
          .where(and(eq(share115Submissions.memberId, memberId), gte(share115Submissions.submittedAt, limits.since)))
          .get()!;
        if (recent.total >= limits.maxPerMember) throw new Share115AdmissionError("rate_limited");
        if (!job) {
          const pending = tx
            .select({ total: count() })
            .from(share115TransferJobs)
            .where(inArray(share115TransferJobs.status, ["queued", "running"]))
            .get()!;
          if (pending.total >= limits.maxPending) throw new Share115AdmissionError("queue_full");
        }
      }
      job ??= tx
        .insert(share115TransferJobs)
        .values({ shareUrl, shareCode, accessCode, createdAt: now, nextAttemptAt: now })
        .returning()
        .get();
      const submission = tx
        .insert(share115Submissions)
        .values({ memberId, memberEmail, adminUsername, note, jobId: job.id, submittedAt: now })
        .returning()
        .get();
      return { ...job, ...submission };
    },
    { behavior: "immediate" },
  );
}

export function enqueueShare115Batch(database: AppDatabase, inputs: EnqueueInput[], limits: AdmissionLimits) {
  if (!inputs.length) return [];
  return database.transaction(
    (transaction) =>
      inputs.map((input) => {
        try {
          return { row: enqueueShare115(transaction, input, limits) };
        } catch (error) {
          if (error instanceof Share115AdmissionError) return { error: error.code };
          throw error;
        }
      }),
    { behavior: "immediate" },
  );
}

export function listShare115(
  database: AppDatabase,
  options: { memberId?: number; status?: Share115Status; page: number; pageSize: number; q?: string },
): { items: Share115SubmissionRow[]; total: number } {
  const conditions: SQL[] = [];
  if (options.memberId !== undefined) conditions.push(eq(share115Submissions.memberId, options.memberId));
  if (options.status) conditions.push(eq(share115TransferJobs.status, options.status));
  if (options.q) {
    const query = options.q;
    conditions.push(
      or(
        sql`instr(lower(${share115Submissions.memberEmail}), lower(${query})) > 0`,
        sql`instr(lower(${share115Submissions.adminUsername}), lower(${query})) > 0`,
        sql`instr(lower(${share115Submissions.note}), lower(${query})) > 0`,
        sql`instr(lower(${share115TransferJobs.shareCode}), lower(${query})) > 0`,
        sql`instr(lower(${share115TransferJobs.shareTitle}), lower(${query})) > 0`,
      )!,
    );
  }
  const where = and(...conditions);
  return database.transaction((tx) => ({
    items: tx
      .select({ submission: share115Submissions, job: share115TransferJobs })
      .from(share115Submissions)
      .innerJoin(share115TransferJobs, eq(share115Submissions.jobId, share115TransferJobs.id))
      .where(where)
      .orderBy(desc(share115Submissions.submittedAt), desc(share115Submissions.id))
      .limit(options.pageSize)
      .offset((options.page - 1) * options.pageSize)
      .all()
      .map(({ submission, job }) => ({ ...job, ...submission })),
    total: tx
      .select({ total: count() })
      .from(share115Submissions)
      .innerJoin(share115TransferJobs, eq(share115Submissions.jobId, share115TransferJobs.id))
      .where(where)
      .get()!.total,
  }));
}

export function claimShare115Job(
  database: AppDatabase,
  { now, leaseExpiresAt }: { now: string; leaseExpiresAt: string },
): Share115Job | undefined {
  return database.transaction(
    (tx) => {
      const running = tx
        .select({ id: share115TransferJobs.id })
        .from(share115TransferJobs)
        .where(eq(share115TransferJobs.status, "running"))
        .limit(1)
        .get();
      if (running) return undefined;
      const next = tx
        .select({ id: share115TransferJobs.id })
        .from(share115TransferJobs)
        .where(and(eq(share115TransferJobs.status, "queued"), lte(share115TransferJobs.nextAttemptAt, now)))
        .orderBy(asc(share115TransferJobs.nextAttemptAt), asc(share115TransferJobs.id))
        .limit(1)
        .get();
      if (!next) return undefined;
      return tx
        .update(share115TransferJobs)
        .set({
          status: "running",
          startedAt: now,
          leaseExpiresAt,
          attemptCount: sql`${share115TransferJobs.attemptCount} + 1`,
        })
        .where(eq(share115TransferJobs.id, next.id))
        .returning()
        .get();
    },
    { behavior: "immediate" },
  );
}

export function recoverExpiredShare115Jobs(database: AppDatabase, now: string): number {
  return database
    .update(share115TransferJobs)
    .set({
      status: "unconfirmed",
      leaseExpiresAt: null,
      resultCode: "transfer_lease_expired",
      resultMessage: "转存执行中断，需核对网盘结果",
    })
    .where(and(eq(share115TransferJobs.status, "running"), lte(share115TransferJobs.leaseExpiresAt, now)))
    .run().changes;
}

export function completeShare115Job(
  database: AppDatabase,
  input: {
    id: number;
    leaseExpiresAt: string;
    now: string;
    status: Exclude<Share115Status, "queued" | "running">;
  } & Partial<
    Pick<Share115Job, "targetFolderId" | "resultCode" | "resultMessage" | "shareTitle" | "identifiedMediaJson">
  >,
): boolean {
  const { id, leaseExpiresAt, now, status, ...result } = input;
  return (
    database
      .update(share115TransferJobs)
      .set({ ...result, status, finishedAt: status === "unconfirmed" ? null : now, leaseExpiresAt: null })
      .where(
        and(
          eq(share115TransferJobs.id, id),
          eq(share115TransferJobs.status, "running"),
          eq(share115TransferJobs.leaseExpiresAt, leaseExpiresAt),
          gt(share115TransferJobs.leaseExpiresAt, now),
        ),
      )
      .run().changes === 1
  );
}

export function resolveShare115Job(
  database: AppDatabase,
  input: { id: number; now: string; status: "saved" | "failed"; resultMessage?: string },
): boolean {
  return (
    database
      .update(share115TransferJobs)
      .set({
        status: input.status,
        finishedAt: input.now,
        resultCode: input.status === "saved" ? "confirmed_saved" : "confirmed_failed",
        resultMessage: input.resultMessage || (input.status === "saved" ? "管理员确认已保存" : "管理员确认转存失败"),
      })
      .where(and(eq(share115TransferJobs.id, input.id), eq(share115TransferJobs.status, "unconfirmed")))
      .run().changes === 1
  );
}
