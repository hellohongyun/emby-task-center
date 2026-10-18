import { syncMemberEmbyAccess } from "./emby-access";
import { and, eq, isNotNull } from "drizzle-orm";
import { randomBytes } from "node:crypto";

import type { AppDatabase } from "@emby-task-center/database/client";
import { submissionUsers } from "@emby-task-center/database/schema";
import type { EmbyClient } from "../integrations/emby-client";
import { createEmbyUserService } from "../integrations/emby-user-service";
import { getConcurrencyPolicy } from "../integrations/concurrency-policy-config";
import { memberStatus } from "./membership";

function makePassword(): string {
  return randomBytes(12).toString("base64url");
}

function normalizeEmail(email: string): string {
  return email.toLowerCase().trim();
}

/**
 * 把会员的并发上限同步到 Emby 用户策略的 SimultaneousStreamLimit（0=不限）。
 * 这是 Emby 原生机制：设了上限后 Emby 会在"超出的第 N+1 路"播放开始时直接拒绝（而不是靠事后踢）。
 *
 * 会员**没登记**上限（null/0）时写的是全局默认路数（concurrencyPolicy.defaultStreamLimit），
 * 而不是 0=不限：自助开卡、Emby 账号自动绑定的会员都属于这一类，
 * 以前它们在 Emby 侧是"完全不设防"的（只靠应用看门狗掐断）。只有全局默认本身设成 0 才写不限。
 */
export async function syncEmbyStreamLimit(
  database: AppDatabase,
  emby: EmbyClient | undefined,
  userId: string,
  maxStreams: number | null,
): Promise<boolean> {
  if (!emby?.configured || !userId) return false;
  const service = createEmbyUserService(emby);
  const registered = maxStreams != null && maxStreams > 0 ? maxStreams : null;
  const limit = registered ?? getConcurrencyPolicy(database).defaultStreamLimit;
  try {
    await service.applyPolicy(userId, { SimultaneousStreamLimit: limit > 0 ? limit : 0 });
    return true;
  } catch {
    return false;
  }
}

/** 启动/上线时把每个有关联 Emby 账号的会员的并发上限补同步一遍（自愈：让旧数据也生效）。 */
export async function syncAllStreamLimits(database: AppDatabase, emby: EmbyClient | undefined): Promise<number> {
  if (!emby?.configured) return 0;
  const members = database
    .select()
    .from(submissionUsers)
    .all()
    .filter((m) => m.embyUserId);
  let synced = 0;
  for (const member of members) {
    if (!member.embyUserId) continue;
    if (await syncEmbyStreamLimit(database, emby, member.embyUserId, member.embyMaxStreams)) synced++;
  }
  return synced;
}

/** 保证某会员已有一条可用的 Emby 账号：无则自动创建（用户名=邮箱，密码=传入或随机）。 */
export async function provisionEmbyAccount(
  database: AppDatabase,
  emby: EmbyClient | undefined,
  email: string,
  password?: string,
): Promise<{ embyUserId: string; embyUsername: string; password: string }> {
  const normalized = normalizeEmail(email);
  const member = database.select().from(submissionUsers).where(eq(submissionUsers.email, normalized)).get();
  if (!member) throw new Error("member_not_found");
  if (!member.enabled || memberStatus(member, new Date()) === "expired") throw new Error("member_access_blocked");
  const service = createEmbyUserService(emby);
  if (member.embyUserId) {
    // 已有 Emby 账号：同步并发上限后返回（密码未知，改密码走自服务/管理员）
    await syncEmbyStreamLimit(database, emby, member.embyUserId, member.embyMaxStreams);
    return { embyUserId: member.embyUserId, embyUsername: member.embyUsername ?? normalized, password: "" };
  }
  const passwordToUse = password && password.length >= 6 ? password : makePassword();
  // 用户名取邮箱；若 Emby 已有同名用户则视为已存在（错误交给用户处理）
  const user = await service.createUser({ name: normalized, password: passwordToUse });
  await syncEmbyStreamLimit(database, emby, user.id, member.embyMaxStreams);
  const timestamp = new Date().toISOString();
  database
    .update(submissionUsers)
    .set({ embyUserId: user.id, embyUsername: normalized, updatedAt: timestamp })
    .where(eq(submissionUsers.id, member.id))
    .run();
  await syncMemberEmbyAccess(database, emby, member.id);
  return { embyUserId: user.id, embyUsername: normalized, password: passwordToUse };
}

/** 到期自动停用对应 Emby 用户：只有到期且尚未停用的会员做处理。 */
export async function disableExpiredEmbyUsers(
  database: AppDatabase,
  emby: EmbyClient | undefined,
  now = new Date(),
): Promise<number> {
  if (!emby?.configured) return 0;
  const members = database
    .select()
    .from(submissionUsers)
    .where(and(eq(submissionUsers.enabled, true), isNotNull(submissionUsers.embyUserId)))
    .all()
    .filter((member) => member.embyUserId && memberStatus(member, now) === "expired");
  const service = createEmbyUserService(emby);
  let count = 0;
  for (const member of members) {
    if (!member.embyUserId) continue;
    try {
      await service.setDisabled(member.embyUserId, true);
      count++;
    } catch {
      /* 单用户失败不阻断 */
    }
  }
  return count;
}
