/**
 * 管理端"内容与偏好"接口（P4：从 routes/submissions.ts 抽出）。
 *
 * 覆盖：用户邮件偏好、审计日志、平台说明文章、内容提供商开关。
 * 投稿审核设置（submission.releaseBlockDays）与投稿邮件开关已随投稿功能删除；
 * 站内通知保留期随通知中心删除；
 * 日报指标（/api/metrics/daily）随追更指标下线（2026-09）删除——它的唯一写入方是被删的
 * follow-admin 路由，两个派生指标（追更新增/追更完成率）也已不存在。
 */
import { eq } from "drizzle-orm";
import type { Express, Request, Response } from "express";
import { z } from "zod";

import type { AppDatabase } from "@emby-task-center/database/client";
import { auditLogs, contentArticles, contentProviders } from "@emby-task-center/database/schema";
import {
  audit,
  clearUserMailPref,
  type MailType,
  MAIL_TYPES,
  readMailDefaults,
  readUserMailPrefs,
  saveMailDefaults,
  setUserMailPref,
} from "../subscriptions/domain-utils";

export interface AdminContentRouteOptions {
  database: AppDatabase;
}

export function registerAdminContentRoutes(app: Express, options: AdminContentRouteOptions): void {
  const { database } = options;

  app.get("/api/admin/mail-preferences/user", (request: Request, response: Response) => {
    const email = String(request.query.email ?? "")
      .toLowerCase()
      .trim();
    if (!email) return void response.status(400).json({ error: "invalid_request" });
    const defaults = readMailDefaults(database);
    const userPrefs = readUserMailPrefs(database, email);
    const effective = Object.fromEntries(
      MAIL_TYPES.map((item) => [item.key, userPrefs[item.key] ?? defaults[item.key]]),
    ) as Record<MailType, boolean>;
    response.json({ mailTypes: MAIL_TYPES, defaults, userPrefs, effective });
  });

  app.put("/api/admin/mail-preferences/user", (request: Request, response: Response) => {
    const parsed = z
      .strictObject({
        email: z.string().trim().email().max(254),
        mailType: z.string().min(1).max(60),
        enabled: z.boolean().nullable(),
      })
      .safeParse(request.body);
    if (!parsed.success) return void response.status(400).json({ error: "invalid_request" });
    if (!MAIL_TYPES.some((item) => item.key === parsed.data.mailType))
      return void response.status(400).json({ error: "invalid_request" });
    if (parsed.data.enabled == null) clearUserMailPref(database, parsed.data.email, parsed.data.mailType as MailType);
    else setUserMailPref(database, parsed.data.email, parsed.data.mailType as MailType, parsed.data.enabled);
    audit(
      database,
      "admin",
      "member.mail_pref",
      "submission_user",
      undefined,
      { email: parsed.data.email },
      { mailType: parsed.data.mailType, enabled: parsed.data.enabled },
    );
    response.json({ ok: true });
  });

  // 全站业务日报（/api/metrics/daily）已随追更指标下线（2026-09）整体删除：
  // 这张表的唯一写入方是 follow-admin 路由，两个派生指标也都是追更口径。
  // 投稿相关的入库转化率 / 平均审核耗时更早随投稿功能删除（submission_timeline 无写入方）。

  // 审计日志列表（按时间倒序，可选动作前缀筛选）。
  app.get("/api/audit-logs", (request: Request, response: Response) => {
    const limit = Math.min(500, Math.max(1, Number(request.query.limit) || 200));
    const prefix = typeof request.query.action === "string" && request.query.action ? request.query.action : null;
    const rows = database
      .select()
      .from(auditLogs)
      .orderBy(auditLogs.id)
      .all()
      .reverse()
      .filter((row) => (prefix ? row.action.startsWith(prefix) : true))
      .slice(0, limit);
    response.json({ logs: rows });
  });

  // 站内通知保留期设置已随通知中心删除（表结构保留，不再有读写方）。

  // 平台说明/规范文章管理（列表 + 单篇更新）。
  app.get("/api/articles", (_request: Request, response: Response) => {
    const rows = database.select().from(contentArticles).orderBy(contentArticles.sort).all();
    response.json({ articles: rows });
  });

  app.put("/api/articles/:code", (request: Request, response: Response) => {
    const parsed = z
      .strictObject({
        title: z.string().trim().min(1).max(120).optional(),
        content: z.string().trim().max(20000).optional(),
        enabled: z.boolean().optional(),
        sort: z.number().int().min(0).max(999).optional(),
        forceSeconds: z.number().int().min(0).max(120).optional(),
      })
      .safeParse(request.body);
    if (!parsed.success) return void response.status(400).json({ error: "invalid_request" });
    const code = Array.isArray(request.params.code) ? request.params.code[0] : request.params.code;
    const updated = database
      .update(contentArticles)
      .set({ ...parsed.data, updatedAt: new Date().toISOString() })
      .where(eq(contentArticles.code, code ?? ""))
      .run();
    if (!updated.changes) return void response.status(404).json({ error: "article_not_found" });
    audit(database, "admin", "article.updated", "article", undefined, { code: request.params.code }, parsed.data);
    response.json({ ok: true });
  });

  // 邮件默认发送设置（管理员全局默认）。
  app.get("/api/settings/mail-defaults", (_request: Request, response: Response) => {
    response.json({ defaults: readMailDefaults(database) });
  });

  app.put("/api/settings/mail-defaults", (request: Request, response: Response) => {
    const parsed = z
      .object({
        membership_reminder: z.boolean().optional(),
      })
      .safeParse(request.body);
    if (!parsed.success) return void response.status(400).json({ error: "invalid_request" });
    saveMailDefaults(database, { ...readMailDefaults(database), ...parsed.data });
    audit(database, "admin", "settings.mail_defaults", "settings", undefined, undefined, parsed.data);
    response.json({ ok: true, defaults: readMailDefaults(database) });
  });

  // P2：内容源列表/更新（TMDB/豆瓣/猫眼/B站/腾讯…）。
  app.get("/api/content-providers", (_request: Request, response: Response) => {
    response.json({ providers: database.select().from(contentProviders).all() });
  });

  app.put("/api/content-providers/:code", (request: Request, response: Response) => {
    const parsed = z
      .strictObject({
        enabled: z.boolean().optional(),
        priority: z.number().int().min(0).max(1000).optional(),
        config: z.record(z.string(), z.unknown()).optional(),
      })
      .safeParse(request.body);
    const code = String(request.params.code ?? "");
    if (!parsed.success || !code) return void response.status(400).json({ error: "invalid_request" });
    const updatedAt = new Date().toISOString();
    const updated = database
      .update(contentProviders)
      .set({
        ...(parsed.data.enabled !== undefined ? { enabled: parsed.data.enabled } : {}),
        ...(parsed.data.priority !== undefined ? { priority: parsed.data.priority } : {}),
        ...(parsed.data.config !== undefined ? { config: parsed.data.config } : {}),
        updatedAt,
      })
      .where(eq(contentProviders.code, code))
      .run();
    if (!updated.changes) return void response.status(404).json({ error: "provider_not_found" });
    audit(database, "admin", "provider.updated", "content_provider", undefined, undefined, { code, ...parsed.data });
    response.json({ ok: true });
  });
}
