import { embyAccessAllowed, syncMemberEmbyAccess } from "../subscriptions/emby-access";
/**
 * 会员（submission_users）管理接口。
 *
 * 历史：本文件原为 routes/submissions.ts，里面混住了「投稿审核」与「会员管理」两组路由，
 * 还顺带挂载 follow-admin / admin-content 两个无关模块。投稿功能删除后只留下会员部分，
 * 因此改名 members.ts；被顺带挂载的两个模块回到 app.ts 各自注册。
 *
 * 数据表仍叫 submission_users（不改表结构），接口路径仍是 /api/submission-users。
 */
import { readId } from "./route-utils";
import type { Express, Request, Response } from "express";
import { z } from "zod";

import type { AppDatabase } from "@emby-task-center/database/client";
import type { EmailNotifier } from "../notifications/email-service";
import type { EmbyClient } from "../integrations/emby-client";
import { audit, canSendMail } from "../subscriptions/domain-utils";
import { sendMembershipEmail } from "../subscriptions/send-notifications";
import { provisionEmbyAccount, syncEmbyStreamLimit } from "../subscriptions/emby-account";
import { linkOrphanEmbyUsers } from "../subscriptions/emby-member-sync";
import { restoreConcurrencyUser } from "../subscriptions/concurrency-escalation";
import {
  addSubmissionUser,
  deleteSubmissionUser,
  getSubmissionUser,
  getSubmissionUserByEmail,
  listSubmissionUsers,
  updateSubmissionUser,
} from "../subscriptions/membership";

const userSchema = z.strictObject({
  email: z.string().trim().email().max(254),
  subscriptionExpiresAt: z.string().datetime().nullable().optional(),
  embyUsername: z.string().trim().max(100).nullable().optional(),
  embyMaxStreams: z.number().int().min(1).max(20).nullable().optional(),
  note: z.string().trim().max(200).nullable().optional(),
  /** 每日投稿入库额度（后台按人设置）。 */
  processPerDay: z.number().int().min(0).max(1000).optional(),
  /** 首批投稿入库额度（后台按人设置）。 */
  processFirstBatch: z.number().int().min(0).max(1000).optional(),
  /** 初始 Emby 密码（可选；留空则自动生成）。 */
  password: z.string().min(6).max(200).optional(),
});
const updateUserSchema = z.strictObject({
  subscriptionExpiresAt: z.string().datetime().nullable().optional(),
  embyUsername: z.string().trim().max(100).nullable().optional(),
  embyMaxStreams: z.number().int().min(1).max(20).nullable().optional(),
  note: z.string().trim().max(200).nullable().optional(),
  enabled: z.boolean().optional(),
  processPerDay: z.number().int().min(0).max(1000).optional(),
  processFirstBatch: z.number().int().min(0).max(1000).optional(),
});

export interface MemberRouteOptions {
  database: AppDatabase;
  email?: EmailNotifier | undefined;
  emby?: EmbyClient | undefined;
}

// P3：位置参数改为选项对象，调用点不再依赖参数顺序。
export function registerMemberRoutes(app: Express, options: MemberRouteOptions): void {
  const { database, email, emby } = options;
  app.get("/api/submission-users", (_request: Request, response: Response) => {
    response.json({ users: listSubmissionUsers(database) });
  });

  /**
   * 手动同步：把 Emby 里还没绑定的账号收编成会员（规则见 subscriptions/emby-member-sync.ts）。
   * 定时任务每 10 分钟也会跑一次；这个入口用于"刚在 Emby 建完号，想立刻在后台看到"。
   */
  app.post("/api/submission-users/sync-emby", async (_request: Request, response: Response) => {
    response.json(await linkOrphanEmbyUsers(database, emby));
  });

  app.post("/api/submission-users", async (request: Request, response: Response) => {
    const parsed = userSchema.safeParse(request.body);
    if (!parsed.success) return void response.status(400).json({ error: "invalid_request" });
    if (getSubmissionUserByEmail(database, parsed.data.email))
      return void response.status(409).json({ error: "email_exists" });
    const created = addSubmissionUser(database, {
      email: parsed.data.email,
      subscriptionExpiresAt: parsed.data.subscriptionExpiresAt ?? null,
      embyUsername: parsed.data.embyUsername ?? null,
      embyMaxStreams: parsed.data.embyMaxStreams ?? null,
      note: parsed.data.note ?? null,
      processPerDay: parsed.data.processPerDay,
      processFirstBatch: parsed.data.processFirstBatch,
    });
    // 自动开通 Emby 账号（若已配置 Emby 且该会员尚未关联）：建号、设随机密码、回写 embyUserId。
    let provisioned = false;
    if (emby?.configured && !created.embyUserId) {
      try {
        await provisionEmbyAccount(database, emby, created.email, parsed.data.password);
        provisioned = true;
      } catch {
        /* 会员已建，Emby 开通失败不阻断（可稍后重设/单独建号） */
      }
    }
    audit(database, "admin", "member.added", "submission_user", created.id, undefined, { email: created.email });
    response.status(201).json({ user: getSubmissionUser(database, created.id), provisioned });
  });

  app.put("/api/submission-users/:id", async (request: Request, response: Response) => {
    const id = readId(request.params.id);
    const parsed = updateUserSchema.safeParse(request.body);
    if (!id || !parsed.success) return void response.status(400).json({ error: "invalid_request" });
    const user = updateSubmissionUser(database, id, parsed.data);
    if (!user) return void response.status(404).json({ error: "user_not_found" });
    audit(database, "admin", "member.updated", "submission_user", id, undefined, { ...parsed.data });
    // 若改了并发上限且已关联 Emby 账号，同步到 Emby 用户策略的 SimultaneousStreamLimit（Emby 原生拒绝超出的并发流）。
    if (user.embyUserId) {
      try {
        await syncEmbyStreamLimit(database, emby, user.embyUserId, user.embyMaxStreams);
      } catch {
        /* best-effort */
      }
    }
    if (
      parsed.data.enabled !== undefined ||
      (parsed.data.subscriptionExpiresAt !== undefined && !embyAccessAllowed(database, user.id))
    )
      await syncMemberEmbyAccess(database, emby, user.id);
    response.json({ user });
  });

  /**
   * 移除会员 = 会员记录 + 它的 Emby 账号，同一个动作删干净。
   *
   * 原先前端是两个按钮（「移除会员」删会员行、「删除」删 Emby 号）：只点前者会留下一个
   * 还能正常观看的 Emby 账号，等于没断服；只点后者会留下一个指向空号的会员行。
   * 现在合并成一个接口调用：先删 Emby 号（best-effort，Emby 不可达不阻断会员删除），
   * 再删会员行；Emby 侧没删掉时会在会员表里以孤儿行出现（member 为空那半行），可单独删。
   */
  app.delete("/api/submission-users/:id", async (request: Request, response: Response) => {
    const id = readId(request.params.id);
    if (!id) return void response.status(400).json({ error: "invalid_id" });
    const user = getSubmissionUser(database, id);
    if (!user) return void response.status(404).json({ error: "user_not_found" });
    let embyDeleted = false;
    if (user.embyUserId && emby?.deleteUser) {
      try {
        await emby.deleteUser(user.embyUserId);
        embyDeleted = true;
      } catch {
        /* best-effort：Emby 不可达时仍要能移除会员 */
      }
    }
    if (!deleteSubmissionUser(database, id)) return void response.status(404).json({ error: "user_not_found" });
    audit(database, "admin", "member.deleted", "submission_user", id, undefined, {
      email: user.email,
      embyUserId: user.embyUserId ?? null,
      embyDeleted,
    });
    response.status(204).end();
  });

  // 管理员一键恢复：清除某会员的并发超限升级状态并重新启用其 Emby 账号。
  app.post("/api/submission-users/:id/restore", async (request: Request, response: Response) => {
    const id = readId(request.params.id);
    if (!id) return void response.status(400).json({ error: "invalid_id" });
    const user = getSubmissionUser(database, id);
    if (!user) return void response.status(404).json({ error: "user_not_found" });
    try {
      await restoreConcurrencyUser(database, emby, user);
    } catch (caught) {
      const error = caught instanceof Error ? caught.message : "member_restore_failed";
      return void response.status(error === "member_restore_blocked" ? 403 : 502).json({ error });
    }
    const fresh = getSubmissionUser(database, id);
    const { concurrency } = listSubmissionUsers(database).find((u) => u.id === id)!;
    response.json({ user: fresh, concurrency });
  });

  // 手动触发临期/到期提醒（管理员调试用，或由定时任务驱动）
  app.post("/api/submission-users/:id/remind", async (request: Request, response: Response) => {
    const id = readId(request.params.id);
    if (!id) return void response.status(400).json({ error: "invalid_id" });
    const user = getSubmissionUser(database, id);
    if (!user) return void response.status(404).json({ error: "user_not_found" });
    const sent = canSendMail(database, user.email, "membership_reminder")
      ? await sendMembershipEmail(email, user).catch(() => false)
      : false;
    response.json({ sent: !!sent });
  });
}
