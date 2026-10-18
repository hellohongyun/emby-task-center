import type { Express, Request, Response } from "express";

import type { AppDatabase } from "@emby-task-center/database/client";
import { listPansouPlatformSettings } from "../pansou/pansou-settings";

/**
 * PanSou 平台开关的**只读**视图。
 *
 * 写入口已统一到后台配置页（`PATCH /api/settings` 的 `pansou.enabledPlatforms`）：
 * 原来的 `PUT /api/pansou/platforms` 会绕开设置存储与来源标记，已移除。
 * 保留 GET 便于排查"后台显示"与"实际过滤"是否一致。
 */
export function registerPansouAdminRoutes(app: Express, database: AppDatabase): void {
  app.get("/api/pansou/platforms", (_request: Request, response: Response) => {
    response.json({ platforms: listPansouPlatformSettings(database) });
  });
}
