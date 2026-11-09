import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const share115Statuses = ["queued", "running", "saved", "already_exists", "failed", "unconfirmed"] as const;

export const share115TransferJobs = sqliteTable(
  "share_115_transfer_jobs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    shareUrl: text("share_url").notNull(),
    shareCode: text("share_code").notNull(),
    accessCode: text("access_code").notNull().default(""),
    status: text("status", { enum: share115Statuses }).notNull().default("queued"),
    createdAt: text("created_at").notNull(),
    startedAt: text("started_at"),
    finishedAt: text("finished_at"),
    attemptCount: integer("attempt_count").notNull().default(0),
    nextAttemptAt: text("next_attempt_at").notNull(),
    leaseExpiresAt: text("lease_expires_at"),
    targetFolderId: text("target_folder_id"),
    resultCode: text("result_code"),
    resultMessage: text("result_message"),
    shareTitle: text("share_title"),
    identifiedMediaJson: text("identified_media_json"),
  },
  (table) => [
    check(
      "share_115_jobs_status_check",
      sql`${table.status} IN ('queued','running','saved','already_exists','failed','unconfirmed')`,
    ),
    index("share_115_jobs_due_idx").on(table.status, table.nextAttemptAt, table.id),
    uniqueIndex("share_115_jobs_active_share_idx")
      .on(table.shareCode, table.accessCode)
      .where(sql`${table.status} IN ('queued','running','unconfirmed')`),
  ],
);

export const share115Submissions = sqliteTable(
  "share_115_submissions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    // Preserve the submitting identity in history if the membership is deleted.
    memberId: integer("member_id").notNull(),
    memberEmail: text("member_email").notNull(),
    // A single administrator identity uses the reserved member ID 0.
    adminUsername: text("admin_username"),
    jobId: integer("job_id")
      .notNull()
      .references(() => share115TransferJobs.id),
    note: text("note").notNull().default(""),
    submittedAt: text("submitted_at").notNull(),
  },
  (table) => [
    index("share_115_submissions_member_idx").on(table.memberId, table.submittedAt, table.id),
    index("share_115_submissions_time_idx").on(table.submittedAt, table.id),
    uniqueIndex("share_115_submissions_job_member_idx").on(table.jobId, table.memberId),
  ],
);
