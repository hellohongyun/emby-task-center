/**
 * TgtoDrive 面板源公开资源搜索（替代 PanSou 作为资源来源）。
 *  - 后端代理 /api/media/resources/search，返回真实磁力/分享链接（token 化，前端不拿链接）。
 *  - 按管理后台「网盘/磁力开关」过滤：关闭的平台不返回；前端资源类型筛选由 enabledTypes 驱动。
 *  - 确认入库仍走机器人（/api/public/pansou/ingest，forwardLink 发链接 + 等回执）。
 */

import type { Express, Request, Response } from "express";
import { z } from "zod";

import type { AppDatabase } from "@emby-task-center/database/client";
import type { PublicSession } from "../subscriptions/public-session";
import type { ResourceTokenStore } from "../pansou/resource-tokens";
import type { TgtoDriveClient, TgtoDriveResourceHit } from "../integrations/tgtodrive-client";
import { readEnabledPansouPlatforms } from "../pansou/pansou-settings";
import {
  ALL_PLATFORMS,
  extractQualityTags,
  extractSize,
  type PansouPlatformKey,
  type PansouResource,
} from "../pansou/pansou-filter";
import { createRateLimiter } from "../subscriptions/rate-limit";

const searchSchema = z.strictObject({
  title: z.string().trim().min(1).max(200),
  mediaType: z.enum(["movie", "tv"]),
  year: z.number().int().min(1800).max(2200).nullable().optional(),
  tmdbId: z.number().int().positive().nullable().optional(),
  aliases: z.array(z.string().trim().max(200)).max(4).optional(),
});

function providerToPlatformKey(provider: string, linkType: string): PansouPlatformKey {
  if (linkType === "magnet" || provider === "offline" || provider === "magnet") return "magnet";
  if (provider === "115") return "115";
  if (provider === "123") return "123";
  if (provider === "guangya") return "other";
  return "magnet";
}

function resourceDisplayType(platformKey: PansouPlatformKey): PansouResource["displayType"] {
  return platformKey === "magnet" ? "磁力" : "网盘";
}

function hitToResource(hit: TgtoDriveResourceHit, enabled: ReadonlySet<PansouPlatformKey>): PansouResource | null {
  const platformKey = providerToPlatformKey(hit.provider, hit.linkType);
  // 管理后台开关是唯一依据：不再叠加硬编码白名单，否则后台启用其它网盘也无法生效。
  if (!enabled.has(platformKey)) return null;
  const link = hit.shareUrl ?? hit.resourceUrl ?? "";
  if (!link) return null;
  const displayType = resourceDisplayType(platformKey);
  // 支持的离线目标只保留已启用平台。
  const supportedTargets = (hit.supportedTargets ?? [])
    .filter((target) => target === "115" || target === "123" || target === "guangya")
    .filter((target) => enabled.has(providerToPlatformKey(target, "share")));
  const qualityTags = extractQualityTags(hit.title);
  const size = hit.size || extractSize(hit.title) || undefined;
  return {
    resourceId: "",
    platformKey,
    displayType,
    url: link,
    password: "",
    note: hit.title,
    maskedNote: hit.title,
    source: hit.itemKey ?? "",
    datetime: "",
    images: [],
    score: 0,
    qualityTags,
    size,
    supportedTargets: supportedTargets.length
      ? supportedTargets
      : displayType === "磁力"
        ? undefined
        : [platformKey === "other" ? "guangya" : platformKey],
    isGying: false,
    raw: { url: link, note: hit.title, source: hit.itemKey ?? "", password: "" },
  };
}

export interface TgtoResourcesOptions {
  database: AppDatabase;
  publicSession: PublicSession;
  tgto?: TgtoDriveClient;
  tokens?: ResourceTokenStore;
  now?: () => Date;
}

export function registerTgtoResourcesRoutes(app: Express, options: TgtoResourcesOptions): void {
  if (!options.tgto || !options.tokens) return;
  const limiter = createRateLimiter(20, 60_000);

  function gate(request: Request, response: Response): string | null {
    const { email } = options.publicSession.read(request.headers.cookie);
    if (!email) {
      response.status(401).json({ error: "member_session_required" });
      return null;
    }
    return email;
  }

  /** 关联资源搜索（面板源，按网盘/磁力开关过滤）。 */
  app.post("/api/public/tgto/resources/search", async (request: Request, response: Response) => {
    const email = gate(request, response);
    if (!email) return;
    const ip = request.ip;
    if (ip && !limiter.check(`ip:${ip}`)) return void response.status(429).json({ error: "rate_limited" });
    const parsed = searchSchema.safeParse(request.body);
    if (!parsed.success) return void response.status(400).json({ error: "invalid_request" });

    const enabled = new Set(readEnabledPansouPlatforms(options.database));
    const enabledTypes = ALL_PLATFORMS.filter((key) => enabled.has(key));
    try {
      const hits = await options.tgto!.searchResources({
        title: parsed.data.title,
        tmdbId: parsed.data.tmdbId ?? null,
        mediaType: parsed.data.mediaType,
        year: parsed.data.year ?? null,
        aliases: parsed.data.aliases ?? [],
      });
      const items: PansouResource[] = [];
      for (const hit of hits) {
        const resource = hitToResource(hit, enabled);
        if (resource) items.push(resource);
      }
      const publicItems = items.map((resource) => {
        const id = options.tokens!.issue(resource);
        return {
          ...options.tokens!.toPublicView(options.tokens!.resolve(id)!),
          supportedTargets: resource.supportedTargets,
        };
      });
      response.json({ email, total: publicItems.length, enabledTypes, items: publicItems });
    } catch (error) {
      response.status(502).json({
        error: "tgto_search_failed",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  });
}
