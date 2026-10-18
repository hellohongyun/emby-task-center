/**
 * 注册/开通成功后，会员看到的两处文案：**开通邮件**与门户「我的」页上的**开通提示**。
 *
 * 为什么单独一个模块：这两处以前是写死在代码里的（邮件正文在 send-notifications.ts、
 * 「我的」页的提示在 PublicProfileView.vue），管理员想改地址口径、加上自己的客服话术都动不了。
 * 现在标题、主题与正文都来自注册表设置（系统设置 →「会员」），这里只负责
 * 把**当前配置**渲染成最终文本（占位符见 registry 里的默认值注释）。
 *
 * 两处共用同一套占位符与同一个渲染路径 —— 邮件里写的口径与页面上显示的永远一致。
 */
import type { AppDatabase } from "@emby-task-center/database/client";
import { embyServerAddress } from "../integrations/emby-address";
import { getConcurrencyPolicy } from "../integrations/concurrency-policy-config";
import {
  DEFAULT_EMBY_ONBOARD_NOTICE,
  DEFAULT_EMBY_ONBOARD_TITLE,
  DEFAULT_WELCOME_EMAIL_BODY,
  DEFAULT_WELCOME_EMAIL_SUBJECT,
  type SettingsSnapshot,
} from "../settings/registry";
import { readSettings } from "../settings/store";
import { renderTemplate } from "../util/template";

/** 渲染开通文案需要的会员信息（地址与并发上限缺省时由当前配置补齐）。 */
export interface EmbyNoticeInputs {
  email: string;
  /** Emby 用户名（= 邮箱）。 */
  username: string;
  /** 初始密码；**空字符串 = 沿用原密码**（续费/已有关联账号时服务端不知道旧密码）。 */
  password: string;
  /** 该会员的并发上限；null/0 表示没登记（跟随全局默认路数）。 */
  maxStreams: number | null;
  /** Emby 服务器地址；缺省取「系统设置 → Emby 地址」，与后台配置保持一致。 */
  serverAddress?: string;
}

function streamLimitNote(limit: number): string {
  return limit > 0 ? `同时最多允许 ${limit} 路播放。` : "同时播放数由管理员设置。";
}

/** 占位符取值：邮件与页面提示共用（两处口径必须一致，所以只在这里算一次）。 */
function noticeContext(
  database: AppDatabase,
  values: SettingsSnapshot,
  inputs: EmbyNoticeInputs,
): Record<string, string | number> {
  const registered = inputs.maxStreams != null && inputs.maxStreams > 0 ? inputs.maxStreams : null;
  const limit = registered ?? values["concurrencyPolicy.defaultStreamLimit"];
  const policy = getConcurrencyPolicy(database);
  return {
    email: inputs.email,
    serverAddress: inputs.serverAddress || embyServerAddress(database),
    username: inputs.username,
    // 续费/已有关联账号时服务端拿不到旧密码：如实说明"沿用原密码"，不留一行空白让人以为账号有问题。
    password: inputs.password.trim() || "（沿用原密码）",
    maxStreams: limit > 0 ? limit : "不限",
    streamLimitNote: streamLimitNote(limit),
    platformUrl: policy.portalUrl || "（未配置平台地址）",
  };
}

/** 开通邮件：主题与正文都后台可改；留空回落默认文案。 */
export function buildEmbyWelcomeEmail(
  database: AppDatabase,
  inputs: EmbyNoticeInputs,
): { subject: string; text: string } {
  const { values } = readSettings(database);
  const context = noticeContext(database, values, inputs);
  return {
    subject: values["member.welcomeEmailSubject"].trim() || DEFAULT_WELCOME_EMAIL_SUBJECT,
    text: renderTemplate(values["member.welcomeEmailBody"].trim() || DEFAULT_WELCOME_EMAIL_BODY, context),
  };
}

/** 门户「我的」页的开通提示：整块（标题 + 正文）后台可改，前后端都不再写死文案。 */
export function buildEmbyOnboardNotice(
  database: AppDatabase,
  inputs: EmbyNoticeInputs,
): { title: string; notice: string } {
  const { values } = readSettings(database);
  const context = noticeContext(database, values, inputs);
  return {
    title: values["member.embyOnboardTitle"].trim() || DEFAULT_EMBY_ONBOARD_TITLE,
    notice: renderTemplate(values["member.embyOnboardNotice"].trim() || DEFAULT_EMBY_ONBOARD_NOTICE, context),
  };
}
