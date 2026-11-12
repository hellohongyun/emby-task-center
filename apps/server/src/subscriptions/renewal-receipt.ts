import { renderEmail } from "../notifications/email-template";

export interface RenewalReceipt {
  email: string;
  method: string;
  previousExpiresAt: string | null;
  subscriptionExpiresAt: string | null;
  expiryLabel?: string | null;
  reduction?: {
    days: number;
    previousDeferredMembershipMs: number;
    deferredMembershipMs: number;
    reason: string;
  };
}

function expiryText(value: string | null): string {
  return value ? new Date(value).toLocaleString() : "长期有效";
}

/** A transaction receipt describes membership time; it does not assert Emby access. */
export function buildRenewalReceipt(receipt: RenewalReceipt, portalUrl?: string, sample = false) {
  if (receipt.reduction) return buildReductionReceipt(receipt, portalUrl, sample);
  const subject = "[会员续期] 你的会员有效期已更新";
  const label = receipt.expiryLabel?.trim();
  const lines = [
    "你的会员续期已完成。",
    `会员邮箱：${receipt.email}`,
    `续期方式：${receipt.method}`,
    `续期前有效期：${expiryText(receipt.previousExpiresAt)}`,
    `本次续期后有效期：${label || expiryText(receipt.subscriptionExpiresAt)}`,
  ];
  if (label) lines.push(`实际到期时间：${expiryText(receipt.subscriptionExpiresAt)}`);
  lines.push(
    "",
    "本通知记录这次续期的结果；若已再次续期，请以门户显示为准。",
    "账号停用、并发冻结等状态仍按当前规则处理。",
  );
  return renderEmail(
    {
      subject,
      heading: "你的会员有效期已更新",
      category: "会员续期",
      text: lines.join("\n"),
      action: portalUrl ? { label: "打开会员门户", url: portalUrl } : undefined,
    },
    sample,
  );
}

function buildReductionReceipt(receipt: RenewalReceipt, portalUrl?: string, sample = false) {
  const reduction = receipt.reduction!;
  const duration = (ms: number) => `${Number((ms / 86_400_000).toFixed(6))} 天`;
  const subject = "[会员时长扣减] 你的会员时长已调整";
  const lines = [
    "管理员已减少你的会员时长。",
    `会员邮箱：${receipt.email}`,
    `本次扣减：${reduction.days} 天（每天按 24 小时计算）`,
    "扣减顺序：先扣待激活时长，再缩短实际有效期。",
    `扣减前有效期：${expiryText(receipt.previousExpiresAt)}`,
    `扣减后有效期：${expiryText(receipt.subscriptionExpiresAt)}`,
    `扣减前待激活时长：${duration(reduction.previousDeferredMembershipMs)}`,
    `扣减后待激活时长：${duration(reduction.deferredMembershipMs)}`,
    ...(reduction.reason ? [`调整原因：${reduction.reason}`] : []),
    "",
    "本通知记录这次扣减的结果；最新有效期与账号状态请以会员门户为准。",
    "如扣减后已过期，将按现有规则限制访问，并适用已启用的过期账号清理规则。",
    "管理员停用、并发冻结等限制仍按当前规则处理。",
  ];
  return renderEmail(
    {
      subject,
      heading: "你的会员时长已调整",
      category: "会员时长扣减",
      text: lines.join("\n"),
      action: portalUrl ? { label: "打开会员门户", url: portalUrl } : undefined,
    },
    sample,
  );
}
