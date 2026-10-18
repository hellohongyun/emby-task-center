import type { EmailNotifier } from "../notifications/email-service";
import { memberStatus, type MemberStatus } from "./membership";

// follow_accepted（追更申请通过）已随追更功能整体下线（2026-09）。
export type SubmissionNotifType = "receipt" | "converted" | "duplicate" | "rejected" | "inlibrary";

export interface SubmissionEmailData {
  email: string;
  title: string;
  submissionId: number;
  reason?: string;
  duplicateHint?: boolean;
  watchUrl?: string | null;
  posterUrl?: string | null;
}

const subjectMap: Record<SubmissionNotifType, (t: SubmissionEmailData) => string> = {
  receipt: (d) => `[投稿受理] ${d.title} 已收到，编号 #${d.submissionId}`,
  converted: (d) => `[投稿处理] ${d.title} 已转为入库任务`,
  duplicate: (d) => `[投稿确认] ${d.title} 可能已在媒体库`,
  rejected: (d) => `[投稿状态] ${d.title} 本次未受理`,
  inlibrary: (d) => `[已入库] ${d.title} 已入库，可以观看啦！`,
};

export async function sendSubmissionEmail(
  email: EmailNotifier | undefined,
  type: SubmissionNotifType,
  data: SubmissionEmailData,
): Promise<boolean> {
  if (!email || !email.configured) return false;
  try {
    const subject = subjectMap[type](data);
    const text = buildSubmissionText(type, data);
    await email.sendNotification(data.email, subject, text, buildHtml(subject, text, data.posterUrl));
    return true;
  } catch {
    return false;
  }
}

function buildSubmissionText(type: SubmissionNotifType, data: SubmissionEmailData): string {
  const lines: string[] = [];
  lines.push(`影片投稿：${data.title}`);
  lines.push(`投稿编号：#${data.submissionId}`);
  if (type === "receipt") {
    lines.push("我们已收到你的投稿，管理员会尽快审核并转为入库任务。");
    if (data.duplicateHint) lines.push("提示：该片名可能与媒体库已有内容重复，我们会由管理员核实。");
  } else if (type === "converted") {
    lines.push("你的投稿已通过审核，正在转为入库任务，处理完成后会再次通知你。");
  } else if (type === "duplicate") {
    lines.push("经核实，该内容可能已在媒体库中，未重复入库。如确实需要，请重新提交并注明原因。");
  } else if (type === "rejected") {
    lines.push(`本次投稿未被受理${data.reason ? `，原因：${data.reason}` : ""}。`);
  } else if (type === "inlibrary") {
    lines.push("你的求片已完成入库，现在可以直接去 Emby 观看啦！");
    if (data.watchUrl) lines.push(`打开观看 → ${data.watchUrl}`);
    lines.push("如果找不到影片，请在 Emby 中刷新媒体库或联系管理员。");
  }
  lines.push("—— 天鸿影院");
  return lines.join("\n");
}

/** 简单 HTML 包裹文本（复用邮件服务风格）；可选带海报图。 */
export function buildHtml(subject: string, text: string, posterUrl?: string | null): string {
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" style="color:#68bd68;font-weight:700;text-decoration:none;">$1</a>')
    .replace(/\n/g, "<br/>");
  const poster = posterUrl
    ? `<div style="margin:16px 0 6px;text-align:center;"><img src="${escapeHtml(posterUrl)}" alt="" style="max-width:140px;border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.5);"/></div>`
    : "";
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>${escapeHtml(subject)}</title></head><body style="margin:0;padding:0;background-color:#0b0e14;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" style="padding:32px 16px;"><table role="presentation" width="600" cellpadding="26" cellspacing="0" border="0" style="width:600px;max-width:100%;background-color:#12161f;border:1px solid #232a38;border-radius:14px;color:#eef2f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'PingFang SC','Microsoft YaHei',sans-serif;"><tr><td style="font-size:18px;font-weight:800;">天鸿影院</td></tr><tr><td style="font-size:13px;color:#9aa5b4;line-height:1.7;">${poster}${escaped}</td></tr><tr><td style="font-size:11px;color:#5f6875;">本邮件由 天鸿影院 自动发送</td></tr></table></td></tr></table></body></html>`;
}

export function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * 会员临期/到期提醒：返回是否已发送。
 *
 * 到期时间与用户侧页面走**同一口径**：带「到期时间名称」的自定义卡密开通的会员，
 * 邮件里也写"2027 年春节结束到期"，而不是甩一个日期——否则用户会在站内看到名称、
 * 在邮件里看到日期，以为自己的会员被改过（见 docs/card-keys.md）。
 */
export async function sendMembershipEmail(
  email: EmailNotifier | undefined,
  user: { email: string; subscriptionExpiresAt: string | null; membershipExpiryLabel?: string | null },
  now = new Date(),
): Promise<boolean> {
  if (!email || !email.configured) return false;
  const status: MemberStatus = memberStatus(user, now);
  if (status !== "expiring" && status !== "expired") return false;
  try {
    const subject = status === "expired" ? "[会员到期] 你的会员已到期" : "[会员临期] 你的会员即将到期";
    const named = user.membershipExpiryLabel?.trim();
    const expiryText = named
      ? named
      : user.subscriptionExpiresAt
        ? new Date(user.subscriptionExpiresAt).toLocaleString()
        : "";
    // 有自定义名称时把真实日期附在小字里：用户问"到底哪天"时不必再来问管理员
    const expiryNote =
      named && user.subscriptionExpiresAt ? `（${new Date(user.subscriptionExpiresAt).toLocaleDateString()}）` : "";
    const when = `${expiryText}${expiryNote}`;
    const text =
      status === "expired"
        ? `你的会员已于 ${when} 到期。如需继续使用会员服务，请联系管理员续费。\n\n—— 天鸿影院`
        : `你的会员将于 ${when} 到期。为继续使用会员服务，请及时联系管理员续费。\n\n—— 天鸿影院`;
    await email.sendNotification(user.email, subject, text, buildHtml(subject, text));
    return true;
  } catch {
    return false;
  }
}
