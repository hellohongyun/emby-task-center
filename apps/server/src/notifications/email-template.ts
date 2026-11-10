import { SITE_BRAND_NAME } from "@emby-task-center/contracts/site-brand";

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

interface EmailContent {
  subject: string;
  text: string;
  heading?: string;
  category?: string;
  code?: string;
  posterUrl?: string | null;
  action?: { label: string; url: string };
}

// 邮件客户端对 CSS 变量的支持不一致，内联使用网站 styles.css 的设计色值。
const colors = {
  background: "#030b11",
  header: "#0b151d",
  surface: "#0f1822",
  raised: "#13212d",
  border: "#2c3e4b",
  text: "#edf2f4",
  secondary: "#aeb9c1",
  accent: "#7fd08a",
  accentInk: "#08130d",
  warning: "#e6c06a",
};
const font = "-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',Arial,sans-serif";

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!,
  );
}

function httpUrl(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const url = URL.parse(value);
  if (url && ["https:", "http:"].includes(url.protocol) && !url.username && !url.password) return url.href;
}

function formatBody(text: string, allowLinks: boolean): string {
  const pieces = text.split(/(https?:\/\/[^\s<>"'，。！？；、）】]+)/gi);
  return pieces
    .map((piece, index) => {
      const escaped = escapeHtml(piece).replace(/\r?\n/g, "<br>");
      const link = allowLinks && index % 2 === 1 ? httpUrl(piece) : undefined;
      return link
        ? `<a href="${escapeHtml(link)}" style="color:${colors.accent};text-decoration:underline;">${escaped}</a>`
        : escaped;
    })
    .join("");
}

export function renderEmail(content: EmailContent, sample = false): RenderedEmail {
  const { heading = content.subject, category = "影院通知", code } = content;
  const subject = sample ? `[测试] ${content.subject}` : content.subject;
  const sampleNotice = "这是一封模板测试邮件，所有账号、验证码和会员信息均为示例。";
  const actionUrl = httpUrl(content.action?.url);
  const posterUrl = sample ? undefined : httpUrl(content.posterUrl);
  const text = [
    ...(sample ? [sampleNotice] : []),
    ...(code ? [`邮箱验证码：${code}`] : []),
    content.text,
    ...(!sample && actionUrl && content.action ? [`${content.action.label}：${actionUrl}`] : []),
  ].join("\n\n");
  const sampleHtml = sample ? `<p style="margin:0 0 16px;color:${colors.warning};">${sampleNotice}</p>` : "";
  const codeHtml = code
    ? `<p style="margin:0 0 20px;padding:12px 16px;border:1px solid ${colors.border};border-radius:10px;background-color:${colors.raised};color:${colors.accent};font-size:28px;font-weight:bold;letter-spacing:0.15em;text-align:center;">${escapeHtml(code)}</p>`
    : "";
  const posterHtml = posterUrl
    ? `<p style="margin:0 0 20px;text-align:center;"><img src="${escapeHtml(posterUrl)}" alt="" width="140" style="display:inline-block;max-width:100%;height:auto;border-radius:10px;"></p>`
    : "";
  const actionStyle = `display:inline-block;padding:10px 16px;border-radius:10px;background-color:${colors.accent};color:${colors.accentInk};font-weight:bold;text-decoration:none;`;
  const actionLabel = content.action ? escapeHtml(content.action.label) : "";
  const actionHtml =
    actionUrl && actionLabel
      ? `<p style="margin:20px 0 0;">${
          sample
            ? `<span style="${actionStyle}">${actionLabel}</span>`
            : `<a href="${escapeHtml(actionUrl)}" style="${actionStyle}">${actionLabel}</a>`
        }</p>`
      : "";
  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;background-color:${colors.background};">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color:${colors.background};">
<tr><td align="center" style="padding:20px 12px;">
<!--[if mso]><table role="presentation" width="600" align="center"><tr><td><![endif]-->
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="width:100%;max-width:600px;background-color:${colors.surface};border:1px solid ${colors.border};border-radius:14px;color:${colors.text};font-family:${font};">
<tr><td style="padding:18px 24px;border-top:3px solid ${colors.accent};border-bottom:1px solid ${colors.border};background-color:${colors.header};font-size:17px;font-weight:bold;">${SITE_BRAND_NAME}</td></tr>
<tr><td style="padding:24px;line-height:1.65;overflow-wrap:anywhere;">
<div style="font-size:12px;font-weight:bold;color:${colors.accent};">${escapeHtml(category)}</div>
<h1 style="margin:4px 0 16px;font-size:23px;line-height:1.3;color:${colors.text};">${escapeHtml(heading)}</h1>
${sampleHtml}${codeHtml}${posterHtml}
<div style="font-size:15px;color:${colors.text};">${formatBody(content.text, !sample)}</div>
${actionHtml}
</td></tr>
<tr><td style="padding:16px 24px;border-top:1px solid ${colors.border};color:${colors.secondary};font-size:12px;">本邮件由 ${SITE_BRAND_NAME} 自动发送</td></tr>
</table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr></table>
</body></html>`;
  return { subject, text, html };
}

export function buildVerificationEmail(code: string, login: boolean, sample = false): RenderedEmail {
  return renderEmail(
    {
      subject: `[${SITE_BRAND_NAME}] 邮箱验证码`,
      category: "账号验证",
      heading: login ? "登录验证码" : "注册验证码",
      code,
      text: login
        ? "验证码 10 分钟内有效。如非本人操作，请忽略此邮件。"
        : "验证码 10 分钟内有效。验证后可填写会员资料。如非本人操作，请忽略此邮件。",
    },
    sample,
  );
}

export function buildSmtpTestEmail(): RenderedEmail {
  return renderEmail({
    subject: `[${SITE_BRAND_NAME}] 邮件服务测试`,
    category: "邮件服务",
    heading: "邮件服务测试",
    text: "收到这封测试邮件表示邮件服务配置正常，SMTP 发送链路可用。",
  });
}
