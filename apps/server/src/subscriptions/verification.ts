import { and, desc, eq } from "drizzle-orm";
import { randomInt } from "node:crypto";

import type { AppDatabase } from "@emby-task-center/database/client";
import { verificationCodes } from "@emby-task-center/database/schema";

export const VERIFICATION_CODE_TTL_MS = 10 * 60_000; // 10 分钟
export const VERIFICATION_MAX_ATTEMPTS = 5; // 每个验证码最多校验次数（防止暴力）

function normalizeEmail(email: string): string {
  return email.toLowerCase().trim();
}

// 内存态失败计数（与登录锁定一致，重启清零）：一次验证码签发后，同一邮箱连续猜错达到上限即作废该码。
const failedAttempts = new Map<string, number>();

export type VerifyResult = { ok: true } | { ok: false; reason: "invalid_code" | "too_many_attempts" };

/** 生成并落库一个一次性验证码；同一邮箱旧验证码作废。返回明文验证码。 */
export function issueVerificationCode(database: AppDatabase, email: string, now = new Date()): string {
  const normalized = normalizeEmail(email);
  const timestamp = now.toISOString();
  // 作废旧码并重置失败计数
  database
    .update(verificationCodes)
    .set({ consumed: true })
    .where(and(eq(verificationCodes.email, normalized), eq(verificationCodes.consumed, false)))
    .run();
  failedAttempts.delete(normalized);
  const code = String(randomInt(100000, 1000000)); // 6 位
  database
    .insert(verificationCodes)
    .values({
      email: normalized,
      code,
      expiresAt: new Date(now.getTime() + VERIFICATION_CODE_TTL_MS).toISOString(),
      consumed: false,
      createdAt: timestamp,
    })
    .run();
  return code;
}

/** 校验验证码：匹配未消费且未过期的码则消费并返回 ok；否则按失败次数递增，达到上限后作废该码并返回 too_many_attempts。 */
export function verifyVerificationCode(
  database: AppDatabase,
  email: string,
  code: string,
  now = new Date(),
): VerifyResult {
  const normalized = normalizeEmail(email);
  const attempts = failedAttempts.get(normalized) ?? 0;
  if (attempts >= VERIFICATION_MAX_ATTEMPTS) return { ok: false, reason: "too_many_attempts" };
  const row = database
    .select()
    .from(verificationCodes)
    .where(and(eq(verificationCodes.email, normalized), eq(verificationCodes.consumed, false)))
    .orderBy(desc(verificationCodes.createdAt))
    .all()[0];

  function recordFailure(failRow?: typeof row): { ok: false; reason: "invalid_code" } {
    const next = attempts + 1;
    // 达到上限时直接作废当前验证码，即使后续猜中正确码也不再放行。
    if (next >= VERIFICATION_MAX_ATTEMPTS && failRow) {
      database.update(verificationCodes).set({ consumed: true }).where(eq(verificationCodes.id, failRow.id)).run();
    }
    failedAttempts.set(normalized, next);
    return { ok: false, reason: "invalid_code" };
  }

  if (!row) return { ok: false, reason: "invalid_code" };
  if (Date.parse(row.expiresAt) <= now.getTime()) {
    database.update(verificationCodes).set({ consumed: true }).where(eq(verificationCodes.id, row.id)).run();
    return recordFailure(row);
  }
  if (row.code !== code.trim()) return recordFailure(row);
  failedAttempts.delete(normalized);
  database.update(verificationCodes).set({ consumed: true }).where(eq(verificationCodes.id, row.id)).run();
  return { ok: true };
}
