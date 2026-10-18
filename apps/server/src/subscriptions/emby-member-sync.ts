/**
 * Emby 账号 → 会员 的自动绑定（"强制默认绑定"）。
 *
 * 背景：会员与 Emby 账号原本只有"先在应用里建会员、再由应用去 Emby 建号"这一条路。
 * Emby 侧自己存在的账号（管理员在 Emby 后台建的、或会员被删后残留的号）永远只能显示成
 * 「仅 Emby 账号」，既没有会员到期时间，也没法用邮箱验证码登录门户。这里按 2026-09-13
 * 用户确认的规则把它们收编：
 *
 *  - **跳过 Emby 管理员账号**（自己人的号要多设备/给自动化用）；
 *  - **跳过用户名不是合法邮箱的账号**：Emby 的 /Users 不返回邮箱字段，能当会员账号的只有用户名，
 *    而门户是"邮箱 + 验证码"登录，非邮箱用户名绑了也没法登录；
 *  - **跳过 Emby 侧已停用的账号**：停用通常是有意为之（或被上一轮到期停用），
 *    自动绑成一个"有效会员"会让状态自相矛盾；
 *  - 已经绑定的跳过（幂等，可反复跑）；
 *  - 邮箱已有会员行、只是 Emby 号没绑上 → 只补绑定，**不动原有到期时间**；
 *  - 其余按"新会员"建档：邮箱 = 用户名，到期 = 绑定那一刻 + `member.autoLinkDays`（默认 15 天），
 *    并发上限留空（跟随全局默认路数），备注写明来源。
 *
 * 触发点：服务启动时 + 每 10 分钟一次（见 scheduling/runtime.ts），
 * 以及后台会员页的「同步 Emby 账号」按钮（POST /api/submission-users/sync-emby）。
 */
import { eq } from "drizzle-orm";

import type { AppDatabase } from "@emby-task-center/database/client";
import { submissionUsers } from "@emby-task-center/database/schema";
import type { EmbyClient, EmbyUser } from "../integrations/emby-client";
import { readSetting } from "../settings/store";
import { audit } from "./domain-utils";
import { syncEmbyStreamLimit } from "./emby-account";
import { createDatabaseSingleFlight } from "../util/database-single-flight";

export type AutoLinkSkipReason = "administrator" | "not_email" | "disabled" | "already_linked" | "conflict";

export interface AutoLinkResult {
  /** 本轮新建的会员（邮箱 = Emby 用户名）。 */
  linked: Array<{ email: string; embyUserId: string; expiresAt: string }>;
  /** 已有会员行、本轮补上 Emby 绑定（到期时间不变）。 */
  adopted: Array<{ email: string; embyUserId: string }>;
  /** 按规则跳过的账号及原因。 */
  skipped: Array<{ name: string; reason: AutoLinkSkipReason }>;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** 会员账号必须像邮箱：门户登录、验证码、通知都按邮箱走。 */
export function isMemberEmail(value: string): boolean {
  return EMAIL_PATTERN.test(value.trim());
}

function skipReasonFor(user: EmbyUser): AutoLinkSkipReason | null {
  if (user.Policy?.IsAdministrator) return "administrator";
  if (!isMemberEmail(user.Name ?? "")) return "not_email";
  if (user.Policy?.IsDisabled) return "disabled";
  return null;
}

export const linkOrphanEmbyUsers = createDatabaseSingleFlight(linkOrphanRound);

async function linkOrphanRound(
  database: AppDatabase,
  emby: EmbyClient | undefined,
  now = new Date(),
): Promise<AutoLinkResult> {
  const result: AutoLinkResult = { linked: [], adopted: [], skipped: [] };
  if (!emby?.configured || !emby.listUsers) return result;

  let users: EmbyUser[];
  try {
    users = await emby.listUsers();
  } catch {
    // Emby 不可达时静默跳过：下一轮（10 分钟后）会再试。
    return result;
  }

  // 现有会员索引：一轮里可能连续新建多条，所以每次写库后要同步更新这三张表。
  const members = database.select().from(submissionUsers).all();
  const byEmbyId = new Map(members.filter((m) => m.embyUserId).map((m) => [m.embyUserId as string, m]));
  const byEmail = new Map(members.map((m) => [m.email.toLowerCase(), m]));
  const byName = new Map(
    members.filter((m) => m.embyUsername).map((m) => [(m.embyUsername as string).toLowerCase(), m]),
  );

  const days = readSetting(database, "member.autoLinkDays");
  const expiresAt = new Date(now.getTime() + days * 86_400_000).toISOString();

  for (const user of users) {
    const name = (user.Name ?? "").trim();
    const email = name.toLowerCase();
    const skipped = skipReasonFor(user);
    if (skipped) {
      result.skipped.push({ name: name || user.Id, reason: skipped });
      continue;
    }
    if (byEmbyId.has(user.Id)) {
      result.skipped.push({ name, reason: "already_linked" });
      continue;
    }
    const timestamp = now.toISOString();
    const existing = byEmail.get(email) ?? byName.get(email) ?? null;
    if (existing) {
      if (existing.embyUserId && existing.embyUserId !== user.Id) {
        result.skipped.push({ name, reason: "conflict" });
        continue;
      }
      database
        .update(submissionUsers)
        .set({ embyUserId: user.Id, embyUsername: email, updatedAt: timestamp })
        .where(eq(submissionUsers.id, existing.id))
        .run();
      byEmbyId.set(user.Id, { ...existing, embyUserId: user.Id, embyUsername: email });
      await syncEmbyStreamLimit(database, emby, user.Id, existing.embyMaxStreams);
      audit(database, "system", "member.auto_linked", "submission_user", existing.id, undefined, {
        email,
        embyUserId: user.Id,
        adopted: true,
      });
      result.adopted.push({ email, embyUserId: user.Id });
      continue;
    }
    const created = database
      .insert(submissionUsers)
      .values({
        email,
        enabled: true,
        subscriptionExpiresAt: expiresAt,
        embyUserId: user.Id,
        embyUsername: email,
        note: "Emby 账号自动绑定",
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .returning()
      .get();
    byEmbyId.set(user.Id, created);
    byEmail.set(email, created);
    byName.set(email, created);
    await syncEmbyStreamLimit(database, emby, user.Id, created.embyMaxStreams);
    audit(database, "system", "member.auto_linked", "submission_user", created.id, undefined, {
      email,
      embyUserId: user.Id,
      expiresAt,
    });
    result.linked.push({ email, embyUserId: user.Id, expiresAt });
  }

  return result;
}
