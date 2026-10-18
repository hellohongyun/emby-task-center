import type { Express, Request, Response } from "express";

import type { AppDatabase } from "@emby-task-center/database/client";
import type { PublicSession } from "../subscriptions/public-session";
import { submissionAccess } from "../subscriptions/membership";
import { createRateLimiter } from "../subscriptions/rate-limit";
import type { PansouClient } from "../pansou/pansou-client";
import {
  ALL_PLATFORMS,
  DEFAULT_ENABLED_PLATFORMS,
  DEFAULT_TIERS,
  PLATFORM_META,
  filterAndRankResources,
  type PansouPlatformKey,
  type PansouResource,
} from "../pansou/pansou-filter";
import type { ResourceTokenStore } from "../pansou/resource-tokens";
import type { EmbyClient } from "../integrations/emby-client";
import { checkDuplicate } from "../pansou/dedup";
import { readEnabledPansouPlatforms } from "../pansou/pansou-settings";
import { resolveMagnetSize } from "../pansou/magnet-size";

/**
 * 门户 PanSou 资源检索（后端代理 + 过滤 + 阶梯回退 + 脱敏 + 评分）。
 *
 * 「确认资源 → 入库」链路（POST /api/public/pansou/ingest 与它的状态轮询）已随投稿功能
 * 整体删除：本应用不再受理投稿，也不再有 createSubmission 这一步。平台开关与去重校验保留。
 */
export interface PansouRouteOptions {
  database: AppDatabase;
  publicSession: PublicSession;
  pansou: PansouClient;
  tokens: ResourceTokenStore;
  emby?: EmbyClient;
  /** 后台网盘启用开关（Phase 1 先由 env/默认值传入，后续接管理后台）。 */
  enabledPlatforms?: readonly PansouPlatformKey[];
  now?: () => Date;
}

/** 每 IP 每分钟 PanSou 搜索上限（防刷爆公网队列/慢源）。 */
const PANSOU_SEARCH_PER_MINUTE_IP = 20;

export function registerPansouRoutes(app: Express, options: PansouRouteOptions): void {
  const searchLimiter = createRateLimiter(PANSOU_SEARCH_PER_MINUTE_IP, 60_000);
  const now = options.now ?? (() => new Date());
  // 网盘/磁力启用开关：优先取管理后台 DB 设置（管理员可调），env 仅作兜底/测试注入。
  const dbEnabled = readEnabledPansouPlatforms(options.database);
  const enabledPlatforms = dbEnabled.length
    ? dbEnabled
    : options.enabledPlatforms?.length
      ? options.enabledPlatforms
      : DEFAULT_ENABLED_PLATFORMS;

  function clientIp(request: Request): string | null {
    return request.ip ?? null;
  }

  function gate(request: Request, response: Response): string | null {
    const { email } = options.publicSession.read(request.headers.cookie);
    if (!email) {
      response.status(401).json({ error: "unauthorized" });
      return null;
    }
    const access = submissionAccess(options.database, email, now());
    if (!access.allowed) {
      response
        .status(403)
        .json({ error: access.reason === "membership_expired" ? "membership_expired" : "not_authorized" });
      return null;
    }
    return email;
  }

  function issueAndView(resource: PansouResource) {
    const id = options.tokens.issue(resource);
    const token = options.tokens.resolve(id);
    if (!token) throw new Error("resource_token_missing");
    return options.tokens.toPublicView(token);
  }

  /** 公开只读：PanSou 聚合搜索（后端代理 + 过滤 + 阶梯回退 + 脱敏 + 评分）。 */
  app.get("/api/public/pansou/search", async (request: Request, response: Response) => {
    const email = gate(request, response);
    if (!email) return;
    const ip = clientIp(request);
    if (ip && !searchLimiter.check(`ip:${ip}`)) return void response.status(429).json({ error: "rate_limited" });

    const kw = String(request.query.kw ?? "").trim();
    const mediaType = String(request.query.mediaType ?? "").trim();
    if (!kw) return void response.status(400).json({ error: "query_required" });

    try {
      // 观影(guanying)源：带年份会搜不到，只能用片名；但片名会带回大量相关作品，
      // 所以对观影结果按影片已知年份做“二次解析/过滤”以区分正确的一版。
      const yearMatch = kw.match(/\s(\d{4})\s*$/);
      const baseTitle = yearMatch ? kw.slice(0, yearMatch.index).trim() : kw;
      const releaseYear = yearMatch ? Number(yearMatch[1]) : null;

      // 1) 带年份搜索：用于磁力/网盘（更精准）。
      const rawYear = await options.pansou.search(kw);
      const resourcesYear = filterAndRankResources(rawYear.data.merged_by_type, { enabledPlatforms });

      // 2) 只搜片名：用于补齐观影（年份会杀掉观影源）。
      let resourcesTitle = resourcesYear;
      if (baseTitle && baseTitle !== kw) {
        try {
          const rawTitle = await options.pansou.search(baseTitle);
          resourcesTitle = filterAndRankResources(rawTitle.data.merged_by_type, { enabledPlatforms });
        } catch {
          /* 片名搜索失败则维持带年份结果 */
        }
      }

      const hasYear = (note: string, year: number) => new RegExp(`(?:^|\\D)${year}(?:\\D|$)`).test(note);
      const gying = resourcesTitle
        .filter((resource) => resource.isGying)
        .filter((resource) => {
          if (!releaseYear) return true;
          const note = `${resource.maskedNote ?? ""} ${resource.note ?? ""}`;
          return hasYear(note, releaseYear);
        });
      // 若年份过滤后观影为 0，回退到片名结果里的全部观影，避免空。
      const gyingFinal = gying.length ? gying : resourcesTitle.filter((resource) => resource.isGying);

      // 3) 非观影（磁力/网盘）取带年份搜索结果；若带年份无网盘，则从片名结果补齐。
      const nonGying = resourcesYear.filter((resource) => !resource.isGying);
      const netdiskYear = resourcesYear.filter((resource) => resource.displayType === "网盘");
      const netdiskFallback = !netdiskYear.length
        ? resourcesTitle.filter((resource) => resource.displayType === "网盘").filter((resource) => !resource.isGying)
        : [];

      // 去重（按 url），观影置顶，随后网盘/磁力。
      const seen = new Set<string>();
      const resources: PansouResource[] = [];
      for (const resource of [...gyingFinal, ...nonGying, ...netdiskFallback]) {
        const key = resource.url ?? `${resource.maskedNote ?? ""}`;
        if (seen.has(key)) continue;
        seen.add(key);
        resources.push(resource);
      }

      const items = resources.map(issueAndView);
      response.json({
        email,
        kw,
        mediaType,
        total: items.length,
        tier: describeChosenTier(resources),
        items,
      });
    } catch (error) {
      response.status(502).json({
        error: "pansou_search_failed",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  });

  /** 磁力解析真实文件大小（尽力而为；失败返回 size=null，回退到标题/备注）。 */
  app.post("/api/public/pansou/resolve-size", async (request: Request, response: Response) => {
    const email = gate(request, response);
    if (!email) return;
    const resourceId = String(request.body?.resourceId ?? "").trim();
    if (!resourceId) return void response.status(400).json({ error: "resource_required" });
    const token = options.tokens.resolve(resourceId);
    if (!token) return void response.status(400).json({ error: "resource_expired" });
    try {
      const size =
        token.platformKey === "magnet" && /^magnet:/i.test(token.url) ? await resolveMagnetSize(token.url) : null;
      response.json({ size });
    } catch {
      response.json({ size: null });
    }
  });

  /** 公开只读：详情弹窗去重（媒体库 + Emby，命中提示“已在影库”）。 */
  app.get("/api/public/pansou/duplicate", async (request: Request, response: Response) => {
    const email = gate(request, response);
    if (!email) return;

    const tmdbIdRaw = String(request.query.tmdbId ?? "").trim();
    const title = String(request.query.title ?? "").trim();
    const yearRaw = String(request.query.year ?? "").trim();
    const mediaTypeRaw = String(request.query.mediaType ?? "").trim();
    if (!title && !tmdbIdRaw) return void response.status(400).json({ error: "query_required" });

    const tmdbId = tmdbIdRaw ? Number(tmdbIdRaw) : null;
    const year = yearRaw ? Number(yearRaw) : null;
    const mediaType = mediaTypeRaw === "tv" ? "tv" : "movie";
    if (tmdbId != null && !Number.isInteger(tmdbId))
      return void response.status(400).json({ error: "invalid_request" });

    try {
      const result = await checkDuplicate({
        database: options.database,
        emby: options.emby,
        tmdbId,
        title,
        year: Number.isFinite(year) ? year : null,
        mediaType,
      });
      response.json({ email, ...result });
    } catch (error) {
      response.status(502).json({
        error: "duplicate_check_failed",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  });

  /** 只返回“当前展示档位”给前端（用于文案，不含具体网盘）。 */
  function describeChosenTier(resources: PansouResource[]): string {
    const hasNetdisk = resources.some((resource) => resource.displayType === "网盘");
    const hasMagnet = resources.some((resource) => resource.displayType === "磁力");
    if (hasNetdisk && hasMagnet) return "网盘+磁力";
    if (hasNetdisk) return "网盘";
    if (hasMagnet) return "磁力";
    return "暂无资源";
  }
}

export { ALL_PLATFORMS, DEFAULT_ENABLED_PLATFORMS, DEFAULT_TIERS, PLATFORM_META };
