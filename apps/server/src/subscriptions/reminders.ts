import { eq } from "drizzle-orm";

import type { AppDatabase } from "@emby-task-center/database/client";
import { submissionUsers } from "@emby-task-center/database/schema";
import type { EmailNotifier } from "../notifications/email-service";
import type { EmbyClient } from "../integrations/emby-client";
import { getSubmissionUser, listSubmissionUsers, memberStatus } from "./membership";
import { sendMembershipEmail } from "./send-notifications";
import { canSendMail } from "./domain-utils";
import { disableExpiredEmbyUsers } from "./emby-account";

/**
 * 会员临期/到期提醒（已提交的状态跨重启保留，SMTP 与写库间退出仍可能重复）：
 * - 进入「expiring」窗口且尚未发过 → 发送成功后记录 membership_reminder_state='expiring'。
 * - 到达「expired」且尚未发过 → 发送成功后记录 membership_reminder_state='expired'。
 * - 续费回到 active → 清空提醒状态，便于下次到期重新提醒。
 * - 用户关闭提醒仍记录已处理；投递失败或邮件未配置则留待下一轮重试。
 */
const sweeps = new WeakMap<AppDatabase, Promise<number>>();

export function runMembershipReminders(
  database: AppDatabase,
  email?: EmailNotifier,
  now = new Date(),
  emby?: EmbyClient,
): Promise<number> {
  const pending = sweeps.get(database);
  if (pending) return pending;
  const running = sweep(database, email, now, emby).finally(() => sweeps.delete(database));
  sweeps.set(database, running);
  return running;
}

async function sweep(
  database: AppDatabase,
  email: EmailNotifier | undefined,
  now: Date,
  emby?: EmbyClient,
): Promise<number> {
  let count = 0;
  for (const candidate of listSubmissionUsers(database)) {
    // 上一个会员的 SMTP 请求可能耗时；处理这一位前重新读取，避免使用整轮开始时的旧状态。
    const user = getSubmissionUser(database, candidate.id);
    if (!user?.enabled) continue;
    const status = memberStatus(user, now);
    if (status === "active") {
      // 续费/有效：清空已提醒标记
      if (user.membershipReminderState != null) {
        database
          .update(submissionUsers)
          .set({ membershipReminderState: null, membershipRemindedAt: null, updatedAt: now.toISOString() })
          .where(eq(submissionUsers.id, user.id))
          .run();
      }
      continue;
    }
    if (status !== "expiring" && status !== "expired") continue;
    if (user.membershipReminderState === status) continue; // 该状态已提醒过
    if (canSendMail(database, user.email, "membership_reminder")) {
      if (!(await sendMembershipEmail(email, user, now))) continue;
    }
    // SMTP 等待期间可能续费、停用或修改邮箱；旧通知不能覆盖新会员状态。
    const current = getSubmissionUser(database, user.id);
    if (
      !current?.enabled ||
      current.email !== user.email ||
      current.subscriptionExpiresAt !== user.subscriptionExpiresAt ||
      current.membershipReminderState !== user.membershipReminderState ||
      memberStatus(current, now) !== status
    )
      continue;
    database
      .update(submissionUsers)
      .set({ membershipReminderState: status, membershipRemindedAt: now.toISOString(), updatedAt: now.toISOString() })
      .where(eq(submissionUsers.id, user.id))
      .run();
    count += 1;
  }
  // 到期自动停用对应 Emby 用户（异步，仅配置了 Emby 时执行）
  if (emby?.configured) void disableExpiredEmbyUsers(database, emby, now).catch(() => undefined);
  return count;
}
