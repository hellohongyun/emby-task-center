/**
 * 门户路由的共享上下文（P4）。
 *
 * `registerPublicRoutes` 里的限流器、客户端 IP 解析等是"每个请求都要用、且各段落共享"的东西。
 * 之前它们定义在注册函数开头，导致段落无法拆出去（拆出去就丢闭包）。抽到这里之后，
 * 各段落模块只依赖一个显式上下文对象。
 *
 * 投稿链路删除后，投稿专用限流器 / 投稿缓冲天数 / Cookie 下发都随之移除；
 * 追更链路也整体下线（2026-09），追更专用限流器一并移除，现在只剩 TMDB 检索限流。
 */
import type { Request } from "express";

import type { AppDatabase } from "@emby-task-center/database/client";
import type { PublicSession } from "../subscriptions/public-session";
import { createRateLimiter } from "../subscriptions/rate-limit";
import type { TmdbClient } from "../tmdb/client";

/** 每 IP 每分钟 TMDB 搜索上限（防刷爆 TMDB）。 */
const SEARCH_PER_MINUTE_IP = 30;

export interface PublicRouteContext {
  database: AppDatabase;
  publicSession: PublicSession;
  tmdb?: TmdbClient | undefined;
  now: () => Date;
  searchLimiter: ReturnType<typeof createRateLimiter>;
  clientIp(request: Request): string | null;
}

export interface PublicOptionsLike {
  database: AppDatabase;
  publicSession: PublicSession;
  tmdb?: TmdbClient;
  now?: () => Date;
}

export function createPublicRouteContext(options: PublicOptionsLike): PublicRouteContext {
  return {
    database: options.database,
    publicSession: options.publicSession,
    tmdb: options.tmdb,
    now: options.now ?? (() => new Date()),
    searchLimiter: createRateLimiter(SEARCH_PER_MINUTE_IP, 60_000),
    clientIp(request: Request): string | null {
      // 使用直接连接的客户端 IP，不读取可伪造的 X-Forwarded-For。
      return request.ip ?? null;
    },
  };
}
