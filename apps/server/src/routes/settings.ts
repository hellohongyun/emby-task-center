/**
 * 管理端配置接口（P1.3）。
 *
 * 挂在登录门之后（与其它 /api 管理端接口一致）。契约：
 *  - 读：按注册表分组返回，密钥只回掩码 + hasValue，绝不回明文；
 *  - 写：局部更新，未知键 / 非法值整条拒绝并回报；
 *  - 改口令：需旧口令，成功后清除「仍在使用默认口令」标记。
 */
import type { Express } from "express";
import { z } from "zod";

import type { AppDatabase } from "@emby-task-center/database/client";
import { changeAdminPassword, readAdminAccount } from "../settings/admin-account";
import { SETTING_GROUP_LABELS, SETTING_GROUP_ORDER } from "../settings/registry";
import { RESTART_ONLY_KEYS } from "../settings/runtime";
import { readSettings, toPublicSettings, writeSettings } from "../settings/store";

const PatchSchema = z
  .object({
    values: z.record(z.string(), z.unknown()),
  })
  .strict();

const PasswordSchema = z
  .object({
    currentPassword: z.string().max(1024),
    newPassword: z.string().max(1024),
  })
  .strict();

/**
 * 保存后**必须重启**才能生效的键（会话密钥要重新签发、Redis 连接启动时建立）。
 * Emby 地址/密钥已经改成保存即生效（见 settings/runtime.ts），不在这里列。
 */
const RESTART_REQUIRED_KEYS = RESTART_ONLY_KEYS;

function settingsPayload(database: AppDatabase) {
  const read = readSettings(database);
  const entries = toPublicSettings(read);
  return {
    groups: SETTING_GROUP_ORDER.map((group) => ({
      group,
      label: SETTING_GROUP_LABELS[group],
      settings: entries.filter((entry) => entry.group === group),
    })).filter((section) => section.settings.length > 0),
    admin: readAdminAccount(database),
    warnings: read.warnings,
  };
}

export interface SettingsRouteHooks {
  /** 写入成功后调用：把改动应用到运行时（刷新快照等），实现"保存即生效"。 */
  onApplied?: (updated: string[]) => Promise<void> | void;
}

export function registerSettingsRoutes(app: Express, database: AppDatabase, hooks: SettingsRouteHooks = {}): void {
  app.get("/api/settings", (_request, response) => {
    response.json(settingsPayload(database));
  });

  app.patch("/api/settings", async (request, response) => {
    const parsed = PatchSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: "invalid_request" });
      return;
    }
    const result = writeSettings(database, parsed.data.values);
    if (result.updated.length === 0 && result.rejected.length > 0) {
      response.status(400).json({ error: "invalid_settings", rejected: result.rejected });
      return;
    }
    // 保存即生效：Emby 地址/密钥等由运行时快照现取，这里刷新快照。
    await hooks.onApplied?.(result.updated);
    // 回传最新快照，前端一次往返即可刷新（含被拒项的说明）。
    response.json({
      ...settingsPayload(database),
      updated: result.updated,
      rejected: result.rejected,
      // 需要重启的键：前端据此提示，别让管理员以为"改完没生效 = 坏了"。
      restartRequired: result.updated.filter((key) => RESTART_REQUIRED_KEYS.has(key)),
    });
  });

  app.post("/api/settings/admin-password", (request, response) => {
    const parsed = PasswordSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: "invalid_request" });
      return;
    }
    const result = changeAdminPassword(database, parsed.data.currentPassword, parsed.data.newPassword);
    if (result.status === "invalid_current") {
      response.status(403).json({ error: "invalid_current_password" });
      return;
    }
    if (result.status === "too_short") {
      response.status(400).json({ error: "password_too_short" });
      return;
    }
    response.json({ status: "ok", admin: readAdminAccount(database) });
  });
}
