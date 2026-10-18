import nodemailer, { type Transporter } from "nodemailer";

import type { AppDatabase } from "@emby-task-center/database/client";

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
  sendTest(email: string): Promise<void>;
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
          // 只有用户名与口令都在时才加 auth：中继服务器不需要认证。
          ...(live.user && live.password ? { auth: { user: live.user, pass: live.password } } : {}),
        })
      : null;
    return cachedTransporter;
  }

  return {
    get configured() {
      return isEmailConfigured(current());
    },
    missingFields: () => missingEmailFields(current()),
    sendTest: async (email) => {
      const transport = transporter();
      if (!transport) throw new Error("email_not_configured");
      await transport.sendMail({
        from: sender(current()),
        to: email,
        subject: "[媒体任务中心] 邮件服务测试",
        text: "邮件服务配置正常。这是一封测试邮件，不代表有新的媒体入库。",
        html: buildTestHtml(),
      });
    },
    retryPending: async () => {
      // 旧自动化投递重发表已移除；直接发送即投递，无需重发队列。
    },
    sendNotification: async (email, subject, text, html, cc) => {
      const transport = transporter();
      if (!transport) throw new Error("email_not_configured");
      await transport.sendMail({
        from: sender(current()),
        to: email,
        ...(cc ? { cc } : {}),
        subject,
        text,
        ...(html ? { html } : {}),
      });
    },
  };
}

function sender(options: EmailOptions): string {
  // 发件人名称留空（而不是没配）时也要给出品牌名，避免拼出 `"" <addr>` 这种 From。
  const name = options.fromName?.trim() || "天鸿影院";
  return `"${name}" <${options.fromAddress}>`;
}

const EMAIL_FONT =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, 'PingFang SC', 'Microsoft YaHei', sans-serif";

const BRAND_LOGO_PNG =
  "data:image/png;base64,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";

function buildTestHtml(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<title>邮件服务测试</title>
</head>
<body style="margin:0;padding:0;background-color:#0b0e14;-webkit-text-size-adjust:100%;word-spacing:normal;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#0b0e14;">
<tr>
<td align="center" style="padding:32px 16px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:100%;background-color:#12161f;border:1px solid #232a38;border-radius:14px;overflow:hidden;box-shadow:0 18px 50px rgba(0,0,0,0.35);">
  <tr>
    <td style="background-color:#0f141d;padding:20px 28px;border-bottom:1px solid #232a38;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr>
          <td style="vertical-align:middle;">
            <img src="${BRAND_LOGO_PNG}" alt="天鸿影院" style="display:block;width:40px;height:auto;border:0;outline:none;text-decoration:none;" />
          </td>
          <td style="padding-left:12px;vertical-align:middle;">
            <div style="color:#e8edf5;font-family:${EMAIL_FONT};font-size:16px;font-weight:700;line-height:1.2;">天鸿影院</div>
            <div style="color:#7d8794;font-family:${EMAIL_FONT};font-size:11px;letter-spacing:2px;margin-top:2px;">媒体任务中心</div>
          </td>
        </tr>
      </table>
    </td>
  </tr>
  <tr>
    <td style="padding:34px 28px 8px;">
      <span style="display:inline-block;padding:4px 14px;border-radius:999px;background-color:#14301c;color:#7fd08a;font-family:${EMAIL_FONT};font-size:12px;font-weight:700;letter-spacing:2px;">配置检查</span>
      <div style="margin-top:16px;color:#f2f5fa;font-family:${EMAIL_FONT};font-size:24px;font-weight:800;line-height:1.35;">邮件服务配置正常</div>
      <div style="margin-top:8px;color:#9aa5b4;font-family:${EMAIL_FONT};font-size:14px;line-height:1.7;">这是一封测试邮件，不代表有新的媒体入库。收到即表示 SMTP 发送链路可用。</div>
    </td>
  </tr>
  <tr>
    <td style="padding:24px 28px 30px;color:#5f6875;font-family:${EMAIL_FONT};font-size:11px;line-height:1.7;text-align:center;">
      天鸿影院 · 媒体任务中心
    </td>
  </tr>
</table>
</td>
</tr>
</table>
</body>
</html>`;
}
