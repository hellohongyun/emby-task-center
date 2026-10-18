/**
 * 会员使用记录接口（管理端）。
 *
 * 数据是应用自己攒的（采样器 + Emby 活动日志回填），只读为主；两个 POST 是"立刻去 Emby
 * 采一次/同步一次"，给"刚装好想马上看到记录"用，不依赖后台定时任务的下一次触发。
 */
import type { Express, Request, Response } from "express";

import type { AppDatabase } from "@emby-task-center/database/client";
import type { EmbyClient } from "../integrations/emby-client";
import { syncEmbyActivityLog } from "../usage/activity-log";
import { DEFAULT_SAMPLE_INTERVAL_MS, sampleMemberSessions } from "../usage/session-sampler";
import { getUsageMemberDetail, listUsageOverview } from "../usage/usage-report";

export interface MemberUsageRouteOptions {
  database: AppDatabase;
  emby?: EmbyClient | undefined;
  /** 采样周期（毫秒）：决定"多久算结束"的容忍度，与后台定时任务保持一致。 */
  sampleIntervalMs?: number;
}

function readDays(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(1, Math.min(365, Math.floor(parsed)));
}

export function registerMemberUsageRoutes(app: Express, options: MemberUsageRouteOptions): void {
  const { database, emby } = options;
  const intervalMs = options.sampleIntervalMs ?? DEFAULT_SAMPLE_INTERVAL_MS;

  app.get("/api/member-usage/overview", (request: Request, response: Response) => {
    const days = readDays(request.query.days, 7);
    response.json(listUsageOverview(database, { days }));
  });

  app.get("/api/member-usage/member", (request: Request, response: Response) => {
    const key = typeof request.query.key === "string" ? request.query.key : "";
    if (!key) return void response.status(400).json({ error: "invalid_key" });
    const days = readDays(request.query.days, 30);
    const detail = getUsageMemberDetail(database, { key, days });
    if (!detail) return void response.status(404).json({ error: "member_not_found" });
    response.json(detail);
  });

  /**
   * 立刻刷新：采样一次当前会话 + 回填一次 Emby 活动日志。
   * Emby 未配置时只回 0，不报错（页面第一次打开不该因为没配 Emby 而弹红）。
   */
  app.post("/api/member-usage/refresh", async (_request: Request, response: Response) => {
    let sampled = { observed: 0, opened: 0, extended: 0, closed: 0, events: 0 };
    let activity = { fetched: 0, inserted: 0, unknown: 0, unsupported: true };
    if (emby?.configured && emby.listSessions) {
      try {
        const sessions = await emby.listSessions();
        sampled = sampleMemberSessions(database, sessions, new Date(), { intervalMs });
      } catch {
        // 采样失败不影响下面的活动日志同步
      }
    }
    try {
      activity = await syncEmbyActivityLog(database, emby, { limit: 100 });
    } catch {
      // 活动日志接口在部分 Emby 版本/权限下不可用：保持 unsupported 的默认值。
    }
    response.json({ sampled, activity });
  });
}
