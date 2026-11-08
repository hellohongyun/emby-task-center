import { buildHtml } from "./send-notifications";

export interface RenewalReceipt {
  email: string;
  method: string;
  previousExpiresAt: string | null;
  subscriptionExpiresAt: string | null;
  expiryLabel?: string | null;
}

function expiryText(value: string | null): string {
  return value ? new Date(value).toLocaleString() : "长期有效";
}

/** A transaction receipt describes membership time; it does not assert Emby access. */
export function buildRenewalReceipt(receipt: RenewalReceipt) {
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
    "—— 天鸿影院",
  );
  const text = lines.join("\n");
  return { subject, text, html: buildHtml(subject, text) };
}
