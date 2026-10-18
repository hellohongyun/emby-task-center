import { asc, eq } from "drizzle-orm";

import type { AppDatabase } from "@emby-task-center/database/client";
import { concurrencyEscalationState, submissionUsers } from "@emby-task-center/database/schema";

export type MemberStatus = "active" | "expiring" | "expired" | "none";

/** 会员的并发超限升级状态（用于管理列表展示与一键恢复）。 */
export interface ConcurrencyMemberStatus {
  /** 是否处于“超限 → 邮件提醒 → 停用”升级时间线中（已超限未停用）。 */
  overshooting: boolean;
  /** 是否已发出超限提醒邮件。 */
  notified: boolean;
  /** 是否因超限被暂停，等待自动恢复。 */
  disabled: boolean;
  disabledUntil: string | null;
  /** 距自动恢复剩余毫秒数（disabled 时才有值）。 */
  remainingMs: number | null;
}

/** 到期前多少天视为「临期」（默认 3 天，仅用于提醒与标色，不影响投稿）。 */
export const EXPIRY_REMINDER_DAYS = 3;

export function memberStatus(user: { subscriptionExpiresAt: string | null }, now: Date): MemberStatus {
  if (!user.subscriptionExpiresAt) return "active"; // 长期有效
  const expires = Date.parse(user.subscriptionExpiresAt);
  if (Number.isNaN(expires)) return "active";
  if (expires <= now.getTime()) return "expired";
  if (expires <= now.getTime() + EXPIRY_REMINDER_DAYS * 86_400_000) return "expiring";
  return "active";
}

export function listSubmissionUsers(
  database: AppDatabase,
): Array<ReturnType<typeof getSubmissionUser> & { status: MemberStatus; concurrency: ConcurrencyMemberStatus }> {
  const rows = database.select().from(submissionUsers).orderBy(asc(submissionUsers.id)).all();
  const states = new Map(
    database
      .select()
      .from(concurrencyEscalationState)
      .all()
      .map((s) => [s.memberId, s]),
  );
  return rows.map((row) => ({
    ...row,
    status: memberStatus(row, new Date()),
    concurrency: memberConcurrencyStatus(row, states.get(row.id), new Date()),
  }));
}

/** 由会员行 + 升级状态算出用于管理展示的并发状态（未设上限/无记录 = 一切正常）。 */
export function memberConcurrencyStatus(
  member: { embyMaxStreams: number | null },
  state: typeof concurrencyEscalationState.$inferSelect | undefined,
  now = new Date(),
): ConcurrencyMemberStatus {
  // 冻结**先判**：未登记上限的会员同样会被冻结（按「默认并发路数」参与管控），
  // 所以不能在"有没有登记上限"这一关就把冻结状态过滤掉——那会让被冻的会员在门户与会员列表里
  // 都显示成"正常"：既看不到解冻时间，也点不了解冻按钮，管理员在列表里也找不到他。
  // 登记上限只影响"超限中"这一档（它本来就只有登记过的会员才算得出来）。
  const disabledUntil = state?.disabledUntil ? Date.parse(state.disabledUntil) : null;
  if (disabledUntil != null && !Number.isNaN(disabledUntil)) {
    return {
      overshooting: false,
      notified: false,
      disabled: true,
      disabledUntil: state!.disabledUntil!,
      remainingMs: Math.max(0, disabledUntil - now.getTime()),
    };
  }
  if (member.embyMaxStreams == null || member.embyMaxStreams <= 0) {
    return { overshooting: false, notified: false, disabled: false, disabledUntil: null, remainingMs: null };
  }
  return {
    overshooting: state?.overshootSince != null,
    notified: state?.notifiedAt != null,
    disabled: false,
    disabledUntil: null,
    remainingMs: null,
  };
}

export function getSubmissionUser(database: AppDatabase, id: number) {
  return database.select().from(submissionUsers).where(eq(submissionUsers.id, id)).get() ?? null;
}

export function getSubmissionUserByEmail(database: AppDatabase, email: string) {
  return (
    database.select().from(submissionUsers).where(eq(submissionUsers.email, email.toLowerCase().trim())).get() ?? null
  );
}

function envInt(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}
/** 求片队列每日自动入库数（默认 2，按邮箱用户）。 */
export const SUBMISSION_DAILY_LIMIT = envInt("SUBMISSION_DAILY_LIMIT", 2);
/** 求片队列首批自动入库数（默认 10）。 */
export const SUBMISSION_FIRST_BATCH = envInt("SUBMISSION_FIRST_BATCH", 10);

export function addSubmissionUser(
  database: AppDatabase,
  input: {
    email: string;
    subscriptionExpiresAt?: string | null;
    embyUsername?: string | null;
    embyMaxStreams?: number | null;
    note?: string | null;
    processPerDay?: number;
    processFirstBatch?: number;
  },
) {
  const timestamp = new Date().toISOString();
  return database
    .insert(submissionUsers)
    .values({
      email: input.email.toLowerCase().trim(),
      enabled: true,
      subscriptionExpiresAt: input.subscriptionExpiresAt ?? null,
      embyUsername: input.embyUsername ?? null,
      embyMaxStreams: input.embyMaxStreams ?? null,
      processPerDay: input.processPerDay ?? SUBMISSION_DAILY_LIMIT,
      processFirstBatch: input.processFirstBatch ?? SUBMISSION_FIRST_BATCH,
      note: input.note ?? null,
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    .returning()
    .get();
}

export function updateSubmissionUser(
  database: AppDatabase,
  id: number,
  input: {
    subscriptionExpiresAt?: string | null;
    embyUsername?: string | null;
    embyMaxStreams?: number | null;
    note?: string | null;
    enabled?: boolean;
    processPerDay?: number;
    processFirstBatch?: number;
  },
) {
  const timestamp = new Date().toISOString();
  const values: Partial<typeof submissionUsers.$inferInsert> = { updatedAt: timestamp };
  if (input.subscriptionExpiresAt !== undefined) values.subscriptionExpiresAt = input.subscriptionExpiresAt;
  if (input.embyUsername !== undefined) values.embyUsername = input.embyUsername;
  if (input.embyMaxStreams !== undefined) values.embyMaxStreams = input.embyMaxStreams;
  if (input.note !== undefined) values.note = input.note;
  if (input.enabled !== undefined) values.enabled = input.enabled;
  if (input.processPerDay !== undefined) values.processPerDay = input.processPerDay;
  if (input.processFirstBatch !== undefined) values.processFirstBatch = input.processFirstBatch;
  return database.update(submissionUsers).set(values).where(eq(submissionUsers.id, id)).returning().get() ?? null;
}

/** 计算会员今日剩余投稿额度（沿用首次批量→每日额度的模型，可由管理员设置）。 */
export function readSubmissionQuota(
  database: AppDatabase,
  email: string,
): { limit: number; used: number; remaining: number } {
  const user = getSubmissionUserByEmail(database, email);
  const limit = user && !user.processFirstBatchUsed ? user.processFirstBatch : (user?.processPerDay ?? 2);
  const used = user?.processUsedToday ?? 0;
  return { limit, used, remaining: Math.max(0, limit - used) };
}

export function deleteSubmissionUser(database: AppDatabase, id: number): boolean {
  return database.delete(submissionUsers).where(eq(submissionUsers.id, id)).run().changes === 1;
}

/** 邮箱是否可登录（必须在允许名单且启用）；已到期会员仍可登录查看「我的提交」，只是不能提交。 */
export function loginAccess(database: AppDatabase, email: string): { allowed: boolean; status: MemberStatus } {
  const user = getSubmissionUserByEmail(database, email);
  if (!user || !user.enabled) return { allowed: false, status: "none" };
  return { allowed: true, status: memberStatus(user, new Date()) };
}

/** 邮箱是否可投稿（必须在允许名单且启用且未到期）；返回允许与否与会员状态。 */
export function submissionAccess(
  database: AppDatabase,
  email: string,
  now = new Date(),
): { allowed: boolean; status: MemberStatus; reason: string | null } {
  const user = getSubmissionUserByEmail(database, email);
  if (!user || !user.enabled) return { allowed: false, status: "none", reason: "unregistered" };
  const status = memberStatus(user, now);
  if (status === "expired") return { allowed: false, status, reason: "membership_expired" };
  return { allowed: true, status, reason: null };
}
