import { createPublicRouteContext } from "./public-context";
import { registerPublicContentRoutes } from "./public-content";
import type { Express, Request, Response } from "express";

import type { AppDatabase } from "@emby-task-center/database/client";
import type { TmdbClient } from "../tmdb/client";
import type { PublicSession } from "../subscriptions/public-session";

/**
 * 公开（登录门之前）路由。
 *
 * 投稿相关的 8 个公开端点（login/logout/mine/settings/duplicate/reorder/单条/批量）已随投稿功能
 * 整体删除：门户会话改由 public-subscriptions.ts 的验证码/卡密登录下发，会员信息走
 * GET /api/public/subscriptions/member。这里只剩 TMDB 检索与内容接口的挂载
 *（追更接口 public-follow.ts 已随追更功能整体下线，2026-09）。
 */
export interface PublicOptions {
  database: AppDatabase;
  publicSession: PublicSession;
  tmdb?: TmdbClient;
  now?: () => Date;
}

export function registerPublicRoutes(app: Express, options: PublicOptions): void {
  // 路由级共享上下文（限流器 / 客户端 IP / Cookie）在 public-context.ts
  const ctx = createPublicRouteContext(options);

  app.get("/api/public/tmdb/search", async (request: Request, response: Response) => {
    if (!options.tmdb) return void response.status(409).json({ error: "tmdb_unavailable" });
    const q = String(request.query.q ?? "").trim();
    if (!q) return void response.status(400).json({ error: "query_required" });
    if (!ctx.searchLimiter.check(`ip:${ctx.clientIp(request) ?? "unknown"}`))
      return void response.status(429).json({ error: "rate_limited" });
    try {
      const results = await options.tmdb.search(q);
      response.json({
        results: results.map((item) => ({
          tmdbId: item.id,
          mediaType: item.mediaType,
          title: item.title,
          releaseYear: item.releaseYear,
          posterUrl: item.posterUrl,
          originalTitle: item.originalTitle ?? null,
          releaseDate: item.releaseDate ?? null,
          overview: item.overview ?? "",
        })),
      });
    } catch {
      response.status(502).json({ error: "tmdb_search_failed" });
    }
  });

  app.get("/api/public/tmdb/details", async (request: Request, response: Response) => {
    if (!options.tmdb) return void response.status(409).json({ error: "tmdb_unavailable" });
    const type = String(request.query.type ?? "");
    const id = Number(request.query.id);
    if ((type !== "movie" && type !== "tv") || !Number.isInteger(id) || id <= 0) {
      return void response.status(400).json({ error: "invalid_request" });
    }
    if (!ctx.searchLimiter.check(`ip:${ctx.clientIp(request) ?? "unknown"}`))
      return void response.status(429).json({ error: "rate_limited" });
    try {
      const detail = await options.tmdb.details(type, id);
      response.json({
        result: {
          tmdbId: detail.id,
          mediaType: detail.mediaType,
          title: detail.title,
          originalTitle: detail.originalTitle,
          releaseYear: detail.releaseYear,
          releaseDate: detail.releaseDate ?? null,
          overview: detail.overview,
          posterUrl: detail.posterUrl,
          backdropUrl: detail.backdropUrl,
          runtime: detail.runtime ?? null,
          genres: detail.genres ?? [],
          status: detail.status ?? null,
          voteAverage: detail.voteAverage ?? null,
          directors: detail.directors ?? [],
          cast: detail.cast ?? [],
          castAvatars: detail.castAvatars ?? [],
          trailerKey: detail.trailerKey ?? null,
          budget: detail.budget ?? null,
          revenue: detail.revenue ?? null,
          totalEpisodes: detail.totalEpisodes ?? null,
          airedEpisodes: detail.airedEpisodes ?? null,
          seasons: (detail.seasons ?? []).map((season) => ({
            seasonNumber: season.seasonNumber,
            name: season.name,
            episodeCount: season.episodeCount,
            airDate: season.airDate,
          })),
        },
      });
    } catch {
      response.status(502).json({ error: "tmdb_details_failed" });
    }
  });

  // 门户内容/偏好接口（P4：已拆到 public-content.ts，这里只负责挂载）。
  registerPublicContentRoutes(app, { database: options.database, publicSession: options.publicSession });
}
