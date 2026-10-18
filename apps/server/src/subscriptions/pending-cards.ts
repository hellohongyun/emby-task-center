import { VERIFICATION_CODE_TTL_MS } from "./verification";

/**
 * 「发验证码时校验过的那张卡密」与邮箱的临时绑定。
 *
 * 为什么需要它：卡密闸门前移到发信之前后，出现了「验证卡密」与「开通核销」两个时刻。
 * 没有绑定的话，可以用 A 卡通过闸门拿到验证码、再拿 B 卡去开通——闸门校验的卡和真正
 * 被核销的卡不是同一张，闸门就形同虚设。
 *
 * 与 `verification.ts` 里的失败计数同风格：内存态、重启清零。验证码本身也只有 10 分钟
 * 寿命，绑定的存活时间与之对齐即可；过期即视为没有绑定（不阻断正常流程）。
 */
const pending = new Map<string, { cardCode: string; at: number }>();

function key(email: string): string {
  return email.toLowerCase().trim();
}

/** 记录「这个邮箱的验证码是用这张卡换来的」。 */
export function bindPendingCard(email: string, cardCode: string, now = new Date()): void {
  pending.set(key(email), { cardCode: cardCode.trim().toUpperCase(), at: now.getTime() });
}

/** 清除绑定（发码失败、或开通成功后调用）。 */
export function clearPendingCard(email: string): void {
  pending.delete(key(email));
}

/**
 * 读取绑定（不删除）：没有绑定、或已超过验证码寿命 → 返回 null。
 *
 * 返回 null 时调用方必须**放行**：绕过 `/code` 直接种验证码的路径（管理端补发、测试、
 * 以及本功能上线前就已发出的验证码）本来就没有绑定，不能因此把人挡在门外。
 */
export function readPendingCard(email: string, now = new Date()): string | null {
  const entry = pending.get(key(email));
  if (!entry) return null;
  if (now.getTime() - entry.at > VERIFICATION_CODE_TTL_MS) {
    pending.delete(key(email));
    return null;
  }
  return entry.cardCode;
}
