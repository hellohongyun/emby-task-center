/**
 * 运行时设置快照（"保存后直接生效"的基础设施）。
 *
 * 有些配置在启动时被读进内存（Emby 客户端地址/密钥、SMTP 发送参数）。以前它们只在启动时读一次，
 * 后台改完必须重启才生效——界面上又看不出来，用户就会以为"改坏了"：最典型的就是
 * SMTP 明明填好了，后台「系统设置」一直显示"未配置"，测试邮件按钮也一直是灰的。
 * 现在：
 *   - index.ts 启动时 {@link initRuntimeSettings} 写入快照；
 *   - 设置保存成功后由路由调用 {@link refreshRuntimeSettings} 重新读取；
 *   - 需要这些值的模块（Emby 客户端、邮件通知）每次用时 {@link getRuntimeSettings} 现取。
 * 内存读取，不会给每个请求加一次数据库查询。
 */
import type { AppDatabase } from "@emby-task-center/database/client";
import { readSettings } from "./store";

/**
 * SMTP 发送参数（注册表 email.* 的运行时形态）。
 *
 * 字段名与 `EmailOptions` 保持一致（`user` 对应设置项 `email.username`），
 * 这样邮件通知器可以直接 `resolve: () => getRuntimeSettings().email`，不必再转换一层。
 */
export interface RuntimeEmailSettings {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
  fromName: string;
  fromAddress: string;
}

export interface RuntimeSettings {
  /** Emby 相关后台任务总开关。 */
  embyEnabled: boolean;
  embyBaseUrl: string;
  embyApiKey: string;
  /** 浏览器访问 Emby 的网页地址（缺集总览「在 Emby 查看」跳转用；空则回落 embyBaseUrl）。 */
  embyWebUrl: string;
  /** 邮件通知（SMTP）：后台保存后立刻用于发信与「连接与自检」状态卡片。 */
  email: RuntimeEmailSettings;
}

let snapshot: RuntimeSettings = {
  embyEnabled: false,
  embyBaseUrl: "",
  embyApiKey: "",
  embyWebUrl: "",
  email: {
    host: "",
    port: 587,
    secure: false,
    user: "",
    password: "",
    fromName: "",
    fromAddress: "",
  },
};

function readRuntimeSettings(database: AppDatabase): RuntimeSettings {
  const { values } = readSettings(database);
  return {
    embyEnabled: values["emby.enabled"],
    embyBaseUrl: values["emby.baseUrl"] || "",
    embyApiKey: values["emby.apiKey"] || "",
    embyWebUrl: values["emby.webUrl"] || "",
    email: {
      host: values["email.host"] || "",
      port: values["email.port"],
      secure: values["email.secure"],
      user: values["email.username"] || "",
      password: values["email.password"] || "",
      fromName: values["email.fromName"] || "",
      fromAddress: values["email.fromAddress"] || "",
    },
  };
}

export function initRuntimeSettings(database: AppDatabase): RuntimeSettings {
  snapshot = readRuntimeSettings(database);
  return snapshot;
}

export function refreshRuntimeSettings(database: AppDatabase): RuntimeSettings {
  return initRuntimeSettings(database);
}

export function getRuntimeSettings(): RuntimeSettings {
  return snapshot;
}

/** 这些键改了**必须**重启：会话密钥要重新签发、Redis 连接是启动时建立的，无法热切换。 */
export const RESTART_ONLY_KEYS: ReadonlySet<string> = new Set(["session.secret", "cache.redisUrl"]);
