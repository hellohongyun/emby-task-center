/**
 * 并发超限处置策略（P1.4：已收编到统一设置存储 app_settings）。
 *
 * 历史：原先读写 concurrency_policy_settings 单行表；现由 settings/legacy-migration.ts
 * 一次性导入，之后一律读写注册表键 concurrencyPolicy.*。旧表保留不删。
 */
import type { AppDatabase } from "@emby-task-center/database/client";
import { DEFAULT_UNFREEZE_NOTICE, DEFAULT_UNFREEZE_TITLE } from "../settings/registry";
import { readSettings, writeSettings } from "../settings/store";

export interface ConcurrencyPolicy {
  enabled: boolean;
  /** 超限多少分钟后发提醒邮件。 */
  remindAfterMinutes: number;
  /** 超限多少分钟后停用账号。 */
  disableAfterMinutes: number;
  /** 停用时长（小时），到期自动恢复。 */
  disableForHours: number;
  /** 管理员抄送邮箱（可选）。 */
  adminEmail: string | null;
  /** 超限时是否**直接中断**多出来的播放（先到先得），而不只是提醒/停用账号。 */
  interruptStreams: boolean;
  /** 未登记会员的 Emby 账号默认允许的同时播放路数（0 = 不限）。 */
  defaultStreamLimit: number;
  /** 允许会员在门户「我的」自助解冻（冻结邮件里会给出入口）。 */
  unfreezeEnabled: boolean;
  /** 每月自助解冻次数上限（0 = 不允许自助解冻），按自然月统计。 */
  unfreezeMonthlyLimit: number;
  /** 自助解冻强制等待秒数：服务端同样按它校验，改接口绕不过去。 */
  unfreezeWaitSeconds: number;
  /** 自助解冻弹窗标题（后台可改）。 */
  unfreezeTitle: string;
  /** 自助解冻弹窗正文（后台可改，支持占位符）。 */
  unfreezeNotice: string;
  /** 平台地址：冻结邮件里"登录平台自助解冻"的链接。 */
  portalUrl: string;
}

export function getConcurrencyPolicy(database: AppDatabase): ConcurrencyPolicy {
  const { values } = readSettings(database);
  return {
    enabled: values["concurrencyPolicy.enabled"],
    remindAfterMinutes: values["concurrencyPolicy.remindAfterMinutes"],
    disableAfterMinutes: values["concurrencyPolicy.disableAfterMinutes"],
    disableForHours: values["concurrencyPolicy.disableForHours"],
    adminEmail: values["concurrencyPolicy.adminEmail"] || null,
    interruptStreams: values["concurrencyPolicy.interruptStreams"],
    defaultStreamLimit: values["concurrencyPolicy.defaultStreamLimit"],
    unfreezeEnabled: values["concurrencyPolicy.unfreezeEnabled"],
    unfreezeMonthlyLimit: values["concurrencyPolicy.unfreezeMonthlyLimit"],
    unfreezeWaitSeconds: values["concurrencyPolicy.unfreezeWaitSeconds"],
    unfreezeTitle: values["concurrencyPolicy.unfreezeTitle"],
    unfreezeNotice: values["concurrencyPolicy.unfreezeNotice"],
    portalUrl: values["concurrencyPolicy.portalUrl"] || "",
  };
}

/**
 * 允许只写其中几项：面板/测试改一两项时，其余沿用当前值
 * （不必每次都要把 13 项全写全，也就不会因为漏写把别的配置冲成默认）。
 */
export type ConcurrencyPolicyInput = Partial<ConcurrencyPolicy> &
  Pick<ConcurrencyPolicy, "enabled" | "remindAfterMinutes" | "disableAfterMinutes" | "disableForHours">;

export function saveConcurrencyPolicy(database: AppDatabase, input: ConcurrencyPolicyInput): ConcurrencyPolicy {
  const current = getConcurrencyPolicy(database);
  const merged: ConcurrencyPolicy = {
    ...current,
    ...input,
    adminEmail: input.adminEmail === undefined ? current.adminEmail : input.adminEmail,
  };
  // 文案留空就回落默认（后台面板清空一个输入框不该让弹窗变成空白）。
  const saved: ConcurrencyPolicy = {
    ...merged,
    unfreezeTitle: merged.unfreezeTitle.trim() || DEFAULT_UNFREEZE_TITLE,
    unfreezeNotice: merged.unfreezeNotice.trim() || DEFAULT_UNFREEZE_NOTICE,
    portalUrl: merged.portalUrl.trim().replace(/\/+$/, ""),
  };
  writeSettings(database, {
    "concurrencyPolicy.enabled": saved.enabled,
    "concurrencyPolicy.remindAfterMinutes": saved.remindAfterMinutes,
    "concurrencyPolicy.disableAfterMinutes": saved.disableAfterMinutes,
    "concurrencyPolicy.disableForHours": saved.disableForHours,
    "concurrencyPolicy.adminEmail": saved.adminEmail ?? "",
    "concurrencyPolicy.interruptStreams": saved.interruptStreams,
    "concurrencyPolicy.defaultStreamLimit": saved.defaultStreamLimit,
    "concurrencyPolicy.unfreezeEnabled": saved.unfreezeEnabled,
    "concurrencyPolicy.unfreezeMonthlyLimit": saved.unfreezeMonthlyLimit,
    "concurrencyPolicy.unfreezeWaitSeconds": saved.unfreezeWaitSeconds,
    "concurrencyPolicy.unfreezeTitle": saved.unfreezeTitle,
    "concurrencyPolicy.unfreezeNotice": saved.unfreezeNotice,
    "concurrencyPolicy.portalUrl": saved.portalUrl,
  });
  return saved;
}
