import { and, eq } from "drizzle-orm";

import type { AppDatabase } from "@emby-task-center/database/client";
import { concurrencyEscalationState, memberUnfreezeEvents, submissionUsers } from "@emby-task-center/database/schema";
import type { ConcurrencyPolicy } from "../integrations/concurrency-policy-config";
import { getConcurrencyPolicy } from "../integrations/concurrency-policy-config";
import type { EmbyClient } from "../integrations/emby-client";
import type { EmailNotifier } from "../notifications/email-service";
import { renderTemplate } from "../util/template";
import { releaseFrozenMember } from "./concurrency-escalation";
import { audit } from "./domain-utils";
import { getSubmissionUserByEmail, memberConcurrencyStatus, memberStatus } from "./membership";
import { buildHtml } from "./send-notifications";

/**
 * 会员自助解冻：被并发超限冻结的会员，可以登录平台自己把账号解冻，不用干等到期。
 *
 * 三个关键口径（都不是"前端做做样子"）：
 *  1. **强制等待由服务端算**：点开弹窗时把「申请时刻」落库（state.unfreeze_requested_at），
 *     确认解冻时服务端按它校验是否等满 `unfreezeWaitSeconds`。只做前端倒计时的话，
 *     直接打接口就能秒解冻，等于没有等待。
 *  2. **每月次数上限**：每成功一次写一行 {@link memberUnfreezeEvents}，按自然月统计；
 *     解冻失败（Emby 没确认恢复）不记次数、不发信 —— 和冻结那边"绝不发假的已冻结邮件"同一口径。
 *  3. **文案全部后台可改**：标题/正文/等待秒数/每月次数/平台地址都来自「并发超限升级」面板，
 *     正文支持 `{{email}}` `{{unfreezeAt}}` `{{remaining}}` `{{maxStreams}}` `{{monthlyLimit}}`
 *     `{{usedThisMonth}}` `{{remainingChances}}` `{{platformUrl}}`。
 */

export type UnfreezeBlockReason =
  "not_member" | "member_disabled" | "membership_expired" | "not_frozen" | "unfreeze_disabled" | "limit_reached";
export type UnfreezeError = UnfreezeBlockReason | "not_requested" | "wait_not_elapsed" | "release_failed";

/** 门户「我的」页拿到的自助解冻状态：按钮显不显示、弹窗长什么样，全由它决定。 */
export interface MemberUnfreezeView {
  /** 现在能不能自助解冻（冻结中 + 开关打开 + 本月还有次数）。 */
  enabled: boolean;
  /** 是否处于冻结中。 */
  frozen: boolean;
  /** 不能自助解冻的原因（前端据此解释"为什么没有按钮"）。 */
  reason: UnfreezeBlockReason | null;
  /** 原定解冻时间（ISO）。 */
  disabledUntil: string | null;
  /** 强制等待秒数。 */
  waitSeconds: number;
  monthlyLimit: number;
  usedThisMonth: number;
  /**
   * 本月**当前**还剩几次（= 上限 - 已用，不扣本次）。
   *
   * 门户横幅「本月还可自助解冻 N 次」、解冻成功后的弹窗都用它 —— 一次没用过就该显示
   * 满额的 3 次，而不是"扣掉本次"的 2 次（那正是曾经的 bug）。
   */
  remainingChances: number;
  /** 若"这一次"解冻成功，之后本月还剩几次（上限 - 已用 - 1）。只用于"本次解冻后还剩"的文案。 */
  remainingAfterThis: number;
  /** 已经点开过弹窗的时刻（ISO）：刷新页面后倒计时接着走，不会被重置。 */
  requestedAt: string | null;
  /** 倒计时结束时刻（ISO）：requestedAt + waitSeconds。 */
  readyAt: string | null;
  /** 弹窗标题（后台文案，已渲染占位符）。 */
  title: string;
  /** 弹窗正文（后台文案，已渲染占位符）。 */
  notice: string;
}

export interface UnfreezeResult {
  ok: boolean;
  error?: UnfreezeError;
  /** wait_not_elapsed：还要等多少毫秒。 */
  retryAfterMs?: number;
  usedThisMonth?: number;
  remainingChances?: number;
}

/** 自然月键（YYYY-MM，服务器本地时区）：每月自助解冻次数按它统计。 */
export function unfreezeMonthKey(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

/** 本月已成功自助解冻的次数。 */
export function countMonthlyUnfreezes(database: AppDatabase, memberId: number, month: string): number {
  return database
    .select()
    .from(memberUnfreezeEvents)
    .where(and(eq(memberUnfreezeEvents.memberId, memberId), eq(memberUnfreezeEvents.month, month)))
    .all().length;
}

/** 文本模板渲染：只替换已知占位符，未知的原样留着（后台一眼能看出写错了哪个）。 */
export function renderUnfreezeText(template: string, context: Record<string, string | number>): string {
  return renderTemplate(template, context);
}

/** 解冻时刻：本地「月-日 时:分」。 */
function formatUnfreezeAt(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

/** 剩余时长：小时/分钟（够用）。 */
function formatRemaining(ms: number | null): string {
  if (!ms || ms <= 0) return "即将解冻";
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  if (hours > 0) return `${hours} 小时${minutes > 0 ? ` ${minutes} 分` : ""}`;
  return `${Math.max(1, minutes)} 分`;
}

function readState(database: AppDatabase, memberId: number) {
  return (
    database.select().from(concurrencyEscalationState).where(eq(concurrencyEscalationState.memberId, memberId)).get() ??
    null
  );
}

/**
 * 会员的自助解冻状态（门户用）。
 *
 * 冻结与否看**状态表**，不看"有没有登记并发上限"：未登记上限的会员按默认路数同样会被冻结
 * （见 membership.memberConcurrencyStatus 的「冻结先判」说明）。
 */
export function memberUnfreezeView(
  database: AppDatabase,
  member: typeof submissionUsers.$inferSelect,
  now = new Date(),
  policy: ConcurrencyPolicy = getConcurrencyPolicy(database),
): MemberUnfreezeView {
  const state = readState(database, member.id);
  const status = memberConcurrencyStatus(member, state ?? undefined, now);
  const month = unfreezeMonthKey(now);
  const usedThisMonth = countMonthlyUnfreezes(database, member.id, month);
  const waitSeconds = policy.unfreezeWaitSeconds;
  const requestedAt = status.disabled ? (state?.unfreezeRequestedAt ?? null) : null;
  const readyAt =
    requestedAt && !Number.isNaN(Date.parse(requestedAt))
      ? new Date(Date.parse(requestedAt) + waitSeconds * 1_000).toISOString()
      : null;

  const reason: UnfreezeBlockReason | null = !member.enabled
    ? "member_disabled"
    : memberStatus(member, now) === "expired"
      ? "membership_expired"
      : !status.disabled
        ? "not_frozen"
        : !policy.unfreezeEnabled || policy.unfreezeMonthlyLimit <= 0
          ? "unfreeze_disabled"
          : policy.unfreezeMonthlyLimit - usedThisMonth <= 0
            ? "limit_reached"
            : null;

  const limit = member.embyMaxStreams && member.embyMaxStreams > 0 ? member.embyMaxStreams : policy.defaultStreamLimit;
  const context: Record<string, string | number> = {
    email: member.email,
    unfreezeAt: formatUnfreezeAt(status.disabledUntil),
    remaining: formatRemaining(status.remainingMs),
    maxStreams: limit > 0 ? limit : "不限",
    monthlyLimit: policy.unfreezeMonthlyLimit,
    usedThisMonth,
    remainingChances: Math.max(0, policy.unfreezeMonthlyLimit - usedThisMonth),
    remainingAfterThis: Math.max(0, policy.unfreezeMonthlyLimit - usedThisMonth - 1),
    platformUrl: policy.portalUrl || "（未配置平台地址）",
  };

  return {
    enabled: reason === null,
    frozen: status.disabled,
    reason,
    disabledUntil: status.disabledUntil,
    waitSeconds,
    monthlyLimit: policy.unfreezeMonthlyLimit,
    usedThisMonth,
    remainingChances: Math.max(0, policy.unfreezeMonthlyLimit - usedThisMonth),
    remainingAfterThis: Math.max(0, policy.unfreezeMonthlyLimit - usedThisMonth - 1),
    requestedAt,
    readyAt,
    title: renderUnfreezeText(policy.unfreezeTitle, context),
    notice: renderUnfreezeText(policy.unfreezeNotice, context),
  };
}

/**
 * 点开弹窗：记下「申请时刻」，倒计时才开始走。
 *
 * 同一轮冻结里重复点开**不会重置**时刻（保留第一次）：否则点一下关掉再点开就能把等待赖掉。
 */
export function requestUnfreeze(
  database: AppDatabase,
  email: string,
  now = new Date(),
): { ok: true; view: MemberUnfreezeView } | { ok: false; error: UnfreezeBlockReason } {
  const member = getSubmissionUserByEmail(database, email);
  if (!member) return { ok: false, error: "not_member" };
  const view = memberUnfreezeView(database, member, now);
  if (view.reason) return { ok: false, error: view.reason };
  const state = readState(database, member.id);
  if (state && !state.unfreezeRequestedAt) {
    database
      .update(concurrencyEscalationState)
      .set({ unfreezeRequestedAt: now.toISOString(), updatedAt: now.toISOString() })
      .where(eq(concurrencyEscalationState.memberId, member.id))
      .run();
  }
  return { ok: true, view: memberUnfreezeView(database, member, now) };
}

/**
 * 正式解冻：校验「确实是本人 + 确实冻结中 + 本月还有次数 + 已等满等待秒数」，
 * 确认 Emby 账号恢复启用后，才记次数、发信、写审计。
 */
export async function confirmUnfreeze(
  database: AppDatabase,
  emby: EmbyClient | undefined,
  notifier: EmailNotifier | undefined,
  memberEmail: string,
  now = new Date(),
): Promise<UnfreezeResult> {
  const member = getSubmissionUserByEmail(database, memberEmail);
  if (!member) return { ok: false, error: "not_member" };

  const policy = getConcurrencyPolicy(database);
  const view = memberUnfreezeView(database, member, now, policy);
  if (view.reason) return { ok: false, error: view.reason };

  const requestedAt = view.requestedAt ? Date.parse(view.requestedAt) : Number.NaN;
  if (!Number.isFinite(requestedAt)) return { ok: false, error: "not_requested" };
  const waitMs = view.waitSeconds * 1_000;
  const elapsed = now.getTime() - requestedAt;
  if (elapsed < waitMs) return { ok: false, error: "wait_not_elapsed", retryAfterMs: waitMs - elapsed };

  // 先确认 Emby 真的恢复了，再落"已解冻"的痕迹：没恢复就按失败返回，不记次数、不发信。
  if (!(await releaseFrozenMember(database, emby, member))) return { ok: false, error: "release_failed" };

  const month = unfreezeMonthKey(now);
  database
    .insert(memberUnfreezeEvents)
    .values({ memberId: member.id, email: member.email, month, createdAt: now.toISOString() })
    .run();
  const usedThisMonth = countMonthlyUnfreezes(database, member.id, month);
  const remainingChances = Math.max(0, policy.unfreezeMonthlyLimit - usedThisMonth);

  // 留痕：会员自助解冻属于"绕过了系统处置"，必须查得到（后台审计日志 → member.self_unfreeze）。
  audit(database, member.email, "member.self_unfreeze", "submission_user", member.id, null, {
    month,
    usedThisMonth,
    remainingChances,
    disabledUntil: view.disabledUntil,
    waitedSeconds: Math.floor(elapsed / 1_000),
  });

  await sendUnfrozenEmail(notifier, member, policy, {
    unfreezeAt: formatUnfreezeAt(view.disabledUntil),
    limit: member.embyMaxStreams && member.embyMaxStreams > 0 ? member.embyMaxStreams : policy.defaultStreamLimit,
    usedThisMonth,
    remainingChances,
  });

  return { ok: true, usedThisMonth, remainingChances };
}

/** 「已解冻」通知：只发给会员本人（自助解冻是会员自己的操作，不抄送管理员）。 */
async function sendUnfrozenEmail(
  notifier: EmailNotifier | undefined,
  member: typeof submissionUsers.$inferSelect,
  policy: ConcurrencyPolicy,
  data: { unfreezeAt: string; limit: number; usedThisMonth: number; remainingChances: number },
): Promise<void> {
  if (!notifier?.configured) return;
  try {
    const text = [
      "尊敬的会员您好：",
      "",
      "你的账号已按你的申请提前解冻，现在可以重新登录播放了（如果客户端还提示停用，重新登录一次即可）。",
      "",
      `・原定解冻时间：${data.unfreezeAt}`,
      `・本次解冻已记入本月自助解冻次数：已用 ${data.usedThisMonth} / ${policy.unfreezeMonthlyLimit} 次，本月还剩 ${data.remainingChances} 次`,
      "",
      data.limit > 0
        ? `请注意：同一账号同时只允许 ${data.limit} 路播放，再次多设备同时播放会被再次冻结。`
        : "请注意：请勿多设备同时播放，再次超限会被再次冻结。",
      "",
      "感谢您的理解与配合！",
    ].join("\n");
    const subject = "账号已解冻";
    await notifier.sendNotification(member.email, subject, text, buildHtml(subject, text));
  } catch {
    /* 邮件失败不阻断 —— 账号确实已经解冻了，不能因为发信失败回退 */
  }
}
