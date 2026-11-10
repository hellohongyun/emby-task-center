import { SITE_BRAND_NAME } from "@emby-task-center/contracts/site-brand";
import type { EmailNotifier } from "../notifications/email-service";
import { renderEmail } from "../notifications/email-template";
import { memberStatus } from "./membership";

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
    const { html } = renderEmail({
      subject,
      text,
      category: "求片通知",
      heading: data.title,
      posterUrl: data.posterUrl,
    });
    await email.sendNotification(data.email, subject, text, html);
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
  lines.push(`—— ${SITE_BRAND_NAME}`);
  return lines.join("\n");
}

export function buildHtml(subject: string, text: string): string {
  return renderEmail({ subject, text }).html;
}

/**
 * 会员临期/到期提醒：返回是否已发送。
 *
 * 到期时间与用户侧页面走**同一口径**：带「到期时间名称」的自定义卡密开通的会员，
 * 邮件里也写"2027 年春节结束到期"，而不是甩一个日期——否则用户会在站内看到名称、
 * 在邮件里看到日期，以为自己的会员被改过（见 docs/card-keys.md）。
 */
interface MembershipExpiryNotice {
  subscriptionExpiresAt: string | null;
  membershipExpiryLabel?: string | null;
  deferredMembershipMs?: number;
  followsDriveExpiry?: boolean;
}

export function buildMembershipEmail(
  user: MembershipExpiryNotice,
  status: "expiring" | "expired",
  portalUrl?: string,
  sample = false,
) {
  const expired = status === "expired";
  const heading = expired ? "你的会员已到期" : "你的会员即将到期";
  const subject = expired ? `[会员到期] ${heading}` : `[会员临期] ${heading}`;
  const named = user.deferredMembershipMs || user.followsDriveExpiry ? null : user.membershipExpiryLabel?.trim();
  const expiryDate = user.subscriptionExpiresAt ? new Date(user.subscriptionExpiresAt) : null;
  const expiryText = named || expiryDate?.toLocaleString() || "";
  const expiryNote = named && expiryDate ? `（${expiryDate.toLocaleDateString()}）` : "";
  const when = `${expiryText}${expiryNote}`;
  const text = expired
    ? `你的会员已于 ${when} 到期。如需继续使用会员服务，请联系管理员续费。`
    : `你的会员将于 ${when} 到期。为继续使用会员服务，请及时联系管理员续费。`;
  return renderEmail(
    {
      subject,
      text,
      heading,
      category: "会员服务",
      action: portalUrl ? { label: "打开会员门户", url: portalUrl } : undefined,
    },
    sample,
  );
}

export async function sendMembershipEmail(
  email: EmailNotifier | undefined,
  user: MembershipExpiryNotice & { email: string },
  now = new Date(),
  portalUrl?: string,
): Promise<boolean> {
  if (!email || !email.configured) return false;
  const status = memberStatus(user, now);
  if (status !== "expiring" && status !== "expired") return false;
  try {
    const { subject, text, html } = buildMembershipEmail(user, status, portalUrl);
    await email.sendNotification(user.email, subject, text, html);
    return true;
  } catch {
    return false;
  }
}
