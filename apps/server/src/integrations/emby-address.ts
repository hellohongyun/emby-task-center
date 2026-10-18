/**
 * 会员应连接的 Emby 服务器地址。
 *
 * 地址以「系统设置 → Emby 地址」（emby.baseUrl）为准：后台填了什么，会员就填什么。
 * 文章正文里不要硬编码地址——「平台须知」正文用 {{embyServerAddress}} 占位符，
 * 对外返回时替换成当前配置的地址。
 */
import type { AppDatabase } from "@emby-task-center/database/client";
import { readSettings } from "../settings/store";

/**
 * 会员应连接（填进 Emby 客户端）的服务器地址。
 *
 * 取后台配置的 Emby 地址；没配就提示联系管理员——给会员看的文案里不出现内部端口/主机名。
 */
export function embyServerAddress(database: AppDatabase): string {
  const { values } = readSettings(database);
  const baseUrl = values["emby.baseUrl"];
  if (baseUrl) return baseUrl;
  return "请联系管理员获取 Emby 服务器地址";
}

/** 平台须知/公告文章里的服务器地址占位符。 */
export const EMBY_SERVER_ADDRESS_TOKEN = "{{embyServerAddress}}";

/** 把文章正文里的占位符替换成当前服务器地址（管理端读原文，公开端读渲染后的）。 */
export function renderArticleContent(content: string, address = ""): string {
  if (!content.includes(EMBY_SERVER_ADDRESS_TOKEN)) return content;
  return content.replaceAll(EMBY_SERVER_ADDRESS_TOKEN, address);
}
