/**
 * 公开门户的"内容与偏好"接口（P4：从 routes/public.ts 抽出，行为不变）。
 *
 * 覆盖：平台列表、说明文章、邮件偏好。
 * TMDB 检索在 public.ts；追更接口（public-follow.ts）已随追更功能整体下线（2026-09）。
 *
 * 额度流水与站内通知中心已删除：投稿链路没了以后没有任何写入方，两项永远是空的。
 */
import { eq } from "drizzle-orm";
import type { Express, Request, Response } from "express";
import { z } from "zod";

import type { AppDatabase } from "@emby-task-center/database/client";
import { contentArticles, platforms } from "@emby-task-center/database/schema";
import { embyServerAddress, renderArticleContent } from "../integrations/emby-address";
import type { PublicSession } from "../subscriptions/public-session";
import {
  clearUserMailPref,
  readMailDefaults,
  readUserMailPrefs,
  setUserMailPref,
  MAIL_TYPES,
  type MailType,
} from "../subscriptions/domain-utils";

export interface PublicContentRouteOptions {
  database: AppDatabase;
  /** 公开门户的会话管理器（与 public.ts 共用同一实例）。 */
  publicSession: PublicSession;
}

export function registerPublicContentRoutes(app: Express, options: PublicContentRouteOptions): void {
  /** 平台字典（门户「平台须知」与内容源展示用；单一事实源，前端 chips 动态渲染）。 */
  app.get("/api/public/platforms", (_request: Request, response: Response) => {
    const rows = options.database
      .select({ code: platforms.code, name: platforms.name })
      .from(platforms)
      .where(eq(platforms.enabled, true))
      .orderBy(platforms.sort)
      .all();
    response.json({ platforms: rows });
  });

  /** 平台说明/规范文章（公开、按序号）。 */
  app.get("/api/public/articles", (_request: Request, response: Response) => {
    const rows = options.database
      .select({
        code: contentArticles.code,
        title: contentArticles.title,
        content: contentArticles.content,
        updatedAt: contentArticles.updatedAt,
        forceSeconds: contentArticles.forceSeconds,
      })
      .from(contentArticles)
      .where(eq(contentArticles.enabled, true))
      .orderBy(contentArticles.sort)
      .all();
    // 正文里的 {{embyServerAddress}} 在这里替换成当前配置的服务器地址（见 emby-address）。
    const address = embyServerAddress(options.database);
    response.json({ articles: rows.map((row) => ({ ...row, content: renderArticleContent(row.content, address) })) });
  });

  /** 我的邮件通知偏好：返回类型清单 + 默认值 + 用户覆盖 + 生效值。 */
  app.get("/api/public/mail-preferences", (request: Request, response: Response) => {
    const { email } = options.publicSession.read(request.headers.cookie);
    if (!email) return void response.status(401).json({ error: "unauthorized" });
    const defaults = readMailDefaults(options.database);
    const userPrefs = readUserMailPrefs(options.database, email);
    const effective = Object.fromEntries(
      MAIL_TYPES.map((item) => [item.key, userPrefs[item.key] ?? defaults[item.key]]),
    ) as Record<MailType, boolean>;
    response.json({ mailTypes: MAIL_TYPES, defaults, userPrefs, effective });
  });

  /** 更新我的邮件偏好：enabled=true/false；null=恢复默认。 */
  app.put("/api/public/mail-preferences", (request: Request, response: Response) => {
    const { email } = options.publicSession.read(request.headers.cookie);
    if (!email) return void response.status(401).json({ error: "unauthorized" });
    const parsed = z
      .strictObject({ mailType: z.string().min(1).max(60), enabled: z.boolean().nullable() })
      .safeParse(request.body);
    if (!parsed.success) return void response.status(400).json({ error: "invalid_request" });
    if (!MAIL_TYPES.some((item) => item.key === parsed.data.mailType))
      return void response.status(400).json({ error: "invalid_request" });
    if (parsed.data.enabled == null) clearUserMailPref(options.database, email, parsed.data.mailType as MailType);
    else setUserMailPref(options.database, email, parsed.data.mailType as MailType, parsed.data.enabled);
    response.json({ ok: true });
  });
}
