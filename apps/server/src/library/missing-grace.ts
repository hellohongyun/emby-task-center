/**
 * 「今日更新」宽限期（小时）的运行时读取。
 *
 * 口径：某集在 TMDB 的播出日当天 00:00 起、宽限期内**不算缺集**（页面标「今日更新」）。
 * 默认 24 小时 = 次日 0 点起算，专治"当天 18 点更新、20 点才入库，白天被误报成缺集"。
 *
 * 为什么每次现读而不是启动时读一次：这是管理员在「系统设置」里改完就想立刻生效的口径，
 * 不想再要求重启进程；readSettings 命中 SQLite 单表，扫描/刷新都是分钟级调用，开销可忽略。
 */
import type { AppDatabase } from "@emby-task-center/database/client";

import { readSettings } from "../settings/store";

/** 注册表默认值（registry 的 library.missingGraceHours 默认 24）；读到非法值时用它兜底。 */
const DEFAULT_MISSING_GRACE_HOURS = 24;

export function readMissingGraceHours(database: AppDatabase): number {
  const value = readSettings(database).values["library.missingGraceHours"];
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : DEFAULT_MISSING_GRACE_HOURS;
}
