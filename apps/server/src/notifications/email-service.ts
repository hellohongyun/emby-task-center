import nodemailer, { type Transporter } from "nodemailer";

import type { AppDatabase } from "@emby-task-center/database/client";
import { SITE_BRAND_NAME } from "@emby-task-center/contracts/site-brand";
import { retryRenewalReceipts } from "../subscriptions/renewal-outbox";
import { buildSmtpTestEmail, renderEmail, type RenderedEmail } from "./email-template";

export interface EmailOptions {
  host?: string;
  port?: number;
  secure?: boolean;
  user?: string;
  password?: string;
  fromName?: string;
  fromAddress?: string;
}

/**
 * 「能不能发信」还缺哪个设置项。
 *
 * 只要求 主机 / 端口 / 发件人地址 三项：
 *  - 用户名 + 口令不是必需项——内网中继、本机 sendmail 往往不需要认证。
 *    以前把二者也当必需项，于是**能正常发信**的 SMTP 在后台一直显示"未配置"，测试按钮也是灰的。
 *  - 发件人地址是要的：没有它 `sender()` 会拼出 `"名字" <>` 这种非法 From。
 * 返回设置项键名（不是文案），由接口层映射成注册表里的中文标签，标签只维护一份。
 */
export type EmailRequirementKey = "email.host" | "email.port" | "email.fromAddress";

export function missingEmailFields(options: EmailOptions): EmailRequirementKey[] {
  const missing: EmailRequirementKey[] = [];
  if (!options.host) missing.push("email.host");
  if (!options.port) missing.push("email.port");
  if (!options.fromAddress) missing.push("email.fromAddress");
  return missing;
}

export function isEmailConfigured(options: EmailOptions): boolean {
  return missingEmailFields(options).length === 0;
}

export interface EmailNotifier {
  /** 现取：后台刚保存的 SMTP 参数当场算数，不需要重启。 */
  configured: boolean;
  /** 仍缺哪些设置项（已配置时为空数组）；用于后台状态卡片给出可执行的提示。 */
  missingFields?(): EmailRequirementKey[];
  sendTest(email: string, sample?: RenderedEmail): Promise<void>;
  retryPending(database: AppDatabase): Promise<void>;
  /** 发送一封任意通知（投稿/会员等）；文本必填，HTML 可选，cc 为抄送地址。 */
  sendNotification(email: string, subject: string, text: string, html?: string, cc?: string): Promise<void>;
}

/**
 * 邮件通知器。凭据有两种给法（与 `createEmbyClient` 一致）：
 *  - 直接给 `host` / `port` / …（测试与一次性用途）；
 *  - 给 `resolve()`，每次发信现取（生产用：后台改完 SMTP 立刻生效，不必重启）。
 *
 * 以前的写法是构造时读一次快照：保存 SMTP 后进程里还是空参数，
 * 界面因此一直显示"未配置"、测试邮件按钮点不动，直到重启才"突然好了"。
 */
export function createEmailNotifier(
  options: EmailOptions & { resolve?: (() => EmailOptions) | undefined },
): EmailNotifier {
  function current(): EmailOptions {
    return options.resolve ? options.resolve() : options;
  }

  // transporter 按参数指纹缓存：参数没变就复用（不会每封信新建连接池），
  // 参数一变立刻重建，所以"保存即生效"和"不浪费连接"两者都成立。
  let cachedSignature: string | null = null;
  let cachedTransporter: Transporter | null = null;
  function transporter(): Transporter | null {
    const live = current();
    const signature = JSON.stringify([
      live.host ?? "",
      live.port ?? 0,
      live.secure === true,
      live.user ?? "",
      live.password ?? "",
      live.fromAddress ?? "",
    ]);
    if (signature === cachedSignature) return cachedTransporter;
    cachedSignature = signature;
    cachedTransporter = isEmailConfigured(live)
      ? nodemailer.createTransport({
          host: live.host,
          port: live.port,
          secure: live.secure,
          connectionTimeout: 15_000,
          greetingTimeout: 15_000,
          socketTimeout: 30_000,
          // 只有用户名与口令都在时才加 auth：中继服务器不需要认证。
          ...(live.user && live.password ? { auth: { user: live.user, pass: live.password } } : {}),
        })
      : null;
    return cachedTransporter;
  }

  const notifier: EmailNotifier = {
    get configured() {
      return isEmailConfigured(current());
    },
    missingFields: () => missingEmailFields(current()),
    sendTest: async (email, sample) => {
      const transport = transporter();
      if (!transport) throw new Error("email_not_configured");
      await transport.sendMail({
        from: sender(current()),
        to: email,
        ...(sample ?? buildSmtpTestEmail()),
      });
    },
    retryPending: async (database) => retryRenewalReceipts(database, notifier),
    sendNotification: async (email, subject, text, html, cc) => {
      const transport = transporter();
      if (!transport) throw new Error("email_not_configured");
      await transport.sendMail({
        from: sender(current()),
        to: email,
        ...(cc ? { cc } : {}),
        subject,
        text,
        html: html ?? renderEmail({ subject, text }).html,
      });
    },
  };
  return notifier;
}

function sender(options: EmailOptions) {
  return { name: options.fromName?.trim() || SITE_BRAND_NAME, address: options.fromAddress ?? "" };
}
