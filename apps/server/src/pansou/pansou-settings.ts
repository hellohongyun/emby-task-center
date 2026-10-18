/**
 * PanSou 网盘/磁力启用开关。
 *
 * 真源是后台系统配置页的设置项 `pansou.enabledPlatforms`（app_settings 表）；
 * 历史实现存在 `pansou_platform_settings` 表里，已在启动时一次性导入（见 settings/legacy-migration.ts），
 * 之后运行时只读设置项——避免"后台页显示一套、实际过滤用另一套"的不一致。
 */

import type { AppDatabase } from "@emby-task-center/database/client";
import { readSettings, writeSettings } from "../settings/store";
import { ALL_PLATFORMS, DEFAULT_ENABLED_PLATFORMS, PLATFORM_META, type PansouPlatformKey } from "./pansou-filter";

export interface PansouPlatformSettingRow {
  platform: PansouPlatformKey;
  name: string;
  displayType: "网盘" | "磁力";
  enabled: boolean;
  sort: number;
}

/** 读取所有平台的启用状态（顺序固定为 ALL_PLATFORMS，便于前端稳定渲染）。 */
export function listPansouPlatformSettings(database: AppDatabase): PansouPlatformSettingRow[] {
  const enabled = new Set(readEnabledPansouPlatforms(database));
  return ALL_PLATFORMS.map((key, index) => {
    const meta = PLATFORM_META[key];
    return {
      platform: key,
      name: meta.name,
      displayType: meta.displayType,
      enabled: enabled.has(key),
      sort: index,
    };
  });
}

/** 读取当前启用的平台集合（设置项里只保留仍然存在的平台 key）。 */
export function readEnabledPansouPlatforms(database: AppDatabase): PansouPlatformKey[] {
  const configured = readSettings(database).values["pansou.enabledPlatforms"];
  const enabled = new Set(
    configured.filter((key): key is PansouPlatformKey => ALL_PLATFORMS.includes(key as PansouPlatformKey)),
  );
  // 全部被清空或配置为空时回落到默认，避免"一个平台都不启用"导致搜索永远空结果。
  return enabled.size > 0 ? ALL_PLATFORMS.filter((key) => enabled.has(key)) : [...DEFAULT_ENABLED_PLATFORMS];
}

/**
 * 保存启用集合（配置页走 PATCH /api/settings；这里给"按单平台开关"调用的老代码用）。
 * 未知平台 key 会被丢掉，避免脏数据进设置项。
 */
export function saveEnabledPansouPlatforms(database: AppDatabase, platforms: string[]): PansouPlatformKey[] {
  const next = ALL_PLATFORMS.filter((key) => platforms.includes(key));
  writeSettings(database, { "pansou.enabledPlatforms": next.length > 0 ? next : [...DEFAULT_ENABLED_PLATFORMS] });
  return readEnabledPansouPlatforms(database);
}

/** 兼容旧调用：改单个平台的启用状态。 */
export function savePansouPlatformEnabled(database: AppDatabase, platform: PansouPlatformKey, enabled: boolean): void {
  const current = new Set(readEnabledPansouPlatforms(database));
  if (enabled) current.add(platform);
  else current.delete(platform);
  saveEnabledPansouPlatforms(database, [...current]);
}
