import { and, eq } from "drizzle-orm";

import type { AppDatabase } from "@emby-task-center/database/client";
import { auditLogs, mediaAliases, userMailPreferences } from "@emby-task-center/database/schema";
import { readSettings, writeSettings } from "../settings/store";

// 站内通知中心（notifyUser / 列表 / 未读数 / 已读 / 保留期清理）已整体删除：
// 投稿链路移除后没有任何写入方，user_notifications 永远是空的，通知保留期设置也一并不需要了。
// 表结构保留（不重建库），只是不再读写。

/** 管理审计：记录关键操作。 */
export function audit(
  database: AppDatabase,
  operator: string,
  action: string,
  targetType: string,
  targetId?: number,
  before?: unknown,
  after?: unknown,
  note?: string,
): void {
  database
    .insert(auditLogs)
    .values({
      operator,
      action,
      targetType,
      targetId: targetId ?? null,
      before: before == null ? null : JSON.stringify(before),
      after: after == null ? null : JSON.stringify(after),
      note: note ?? null,
      createdAt: new Date().toISOString(),
    })
    .run();
}

// 业务日报整条链（metric_daily 表 / bumpMetric 写入 / dailyMetrics 读取 / /api/metrics/daily）
// 已随追更指标下线（2026-09）删除：它的唯一写入方是被删的 follow-admin 路由，
// 两个派生指标（追更新增、追更完成率）也都是追更口径。表本身由对账丢掉。

/**
 * 邮件通知类型清单（用户可逐类开关；管理员可设全局默认）。
 *
 * 投稿相关的 5 类（受理/转任务/未受理/疑似重复/已入库）随投稿功能删除，
 * 对应的 mail.submission* 设置项也不再注册。
 *
 * 「任务更新通知」（task_update）整条链在 2026-09 一并删除：它的发送方
 * email-service 的 sendTaskUpdate 原本由追更轮询触发，追更下线后**全仓再无调用方**
 * （接口、实现、单测之外没有任何生产调用），会员侧"订阅某个任务"的公开订阅表也没了。
 * 留着它只会让会员在「我的 → 邮件通知偏好」里点一个不改变任何行为的开关。
 */
export const MAIL_TYPES = [
  { key: "membership_reminder", label: "会员临期/到期提醒", desc: "会员到期前/到期时的提醒" },
] as const;
export type MailType = (typeof MAIL_TYPES)[number]["key"];

// P1.4：邮件默认开关已收编到统一设置存储（mail.*），旧表仅作迁移来源。
export function readMailDefaults(database: AppDatabase): Record<MailType, boolean> {
  const { values } = readSettings(database);
  return {
    membership_reminder: values["mail.membershipReminder"],
  };
}

export function saveMailDefaults(database: AppDatabase, input: Record<MailType, boolean>): void {
  writeSettings(database, {
    "mail.membershipReminder": input.membership_reminder,
  });
}

export function readUserMailPrefs(database: AppDatabase, email: string): Record<MailType, boolean | null> {
  const normalized = email.toLowerCase().trim();
  const rows = database.select().from(userMailPreferences).where(eq(userMailPreferences.email, normalized)).all();
  const map = new Map(rows.map((row) => [row.mailType as MailType, row.enabled]));
  return Object.fromEntries(MAIL_TYPES.map((item) => [item.key, map.get(item.key) ?? null])) as Record<
    MailType,
    boolean | null
  >;
}

export function setUserMailPref(database: AppDatabase, email: string, type: MailType, enabled: boolean): void {
  const normalized = email.toLowerCase().trim();
  const timestamp = new Date().toISOString();
  database
    .insert(userMailPreferences)
    .values({ email: normalized, mailType: type, enabled, updatedAt: timestamp })
    .onConflictDoUpdate({
      target: [userMailPreferences.email, userMailPreferences.mailType],
      set: { enabled, updatedAt: timestamp },
    })
    .run();
}

/** 恢复默认：删除用户该类型的显式覆盖。 */
export function clearUserMailPref(database: AppDatabase, email: string, type: MailType): void {
  database
    .delete(userMailPreferences)
    .where(and(eq(userMailPreferences.email, email.toLowerCase().trim()), eq(userMailPreferences.mailType, type)))
    .run();
}

/** 该邮箱是否应发送该类邮件：用户显式设置优先，否则用管理员全局默认。 */
export function canSendMail(database: AppDatabase, email: string, type: MailType): boolean {
  const normalized = email.toLowerCase().trim();
  const row = database
    .select({ enabled: userMailPreferences.enabled })
    .from(userMailPreferences)
    .where(and(eq(userMailPreferences.email, normalized), eq(userMailPreferences.mailType, type)))
    .get();
  if (row) return row.enabled;
  return readMailDefaults(database)[type];
}

/** 内容别名：为媒体条目登记（标题/原题），提升任务→库匹配。 */
export function appendMediaAliases(
  database: AppDatabase,
  itemId: number,
  names: Array<{ name: string; lang?: string; source?: string }>,
): void {
  const timestamp = new Date().toISOString();
  for (const entry of names) {
    const name = entry.name.trim();
    if (!name) continue;
    database
      .insert(mediaAliases)
      .values({
        itemId,
        name,
        lang: entry.lang ?? "zh",
        source: entry.source ?? "auto",
        createdAt: timestamp,
      })
      .onConflictDoNothing({ target: [mediaAliases.itemId, mediaAliases.name] })
      .run();
  }
}
