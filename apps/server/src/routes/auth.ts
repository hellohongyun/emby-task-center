import type { Express } from "express";
import { z } from "zod";

import type { SessionManager } from "../auth/session";

const LoginSchema = z
  .object({
    /** 用户名可选：留空时按旧行为只校验口令（兼容存量前端）。 */
    username: z.string().max(64).optional(),
    password: z.string().max(1024),
  })
  .strict();

export interface AuthLimitOptions {
  maxFailedAttempts?: number;
  /** 固定锁定时长（分钟）。设置后每次锁定都锁定该时长，不再指数递增。 */
  lockoutMinutes?: number;
  /** 指数锁定基数（秒）：第 n 次锁定时长为基数^n 秒。未设置 lockoutMinutes 时生效。 */
  lockoutBaseSeconds?: number;
  now?: () => number;
}

interface LoginAttempt {
  failures: number;
  lockCount: number;
  lockedUntil: number;
  updatedAt: number;
}

// 第 n 次锁定时长为 lockoutBaseSeconds^n 秒（默认 60^n：1 分钟、1 小时、60 小时……无上限）。
// 指数过大会超出 Date/Number 安全范围，因此封顶到 60^7 秒（约 8.8 万年，实际等同永久）。
const maxLockExponent = 7;

export function registerAuthRoutes(
  app: Express,
  sessions: SessionManager,
  options: AuthLimitOptions = {},
  clearPublicCookie?: () => string,
): void {
  const maxFailedAttempts = Math.max(1, options.maxFailedAttempts ?? 1);
  const lockoutBaseSeconds = Math.max(1, options.lockoutBaseSeconds ?? 60);
  const fixedLockoutMs = options.lockoutMinutes == null ? null : Math.max(1, options.lockoutMinutes) * 60_000;
  const now = options.now ?? Date.now;
  const attempts = new Map<string, LoginAttempt>();

  app.post("/api/auth/login", (request, response) => {
    const current = now();
    pruneAttempts(attempts, current);
    const key = request.ip ?? "unknown";
    const existing = attempts.get(key);
    if (existing && existing.lockedUntil > current) {
      response.setHeader("retry-after", secondsUntil(existing.lockedUntil, current));
      response.status(429).json({ error: "too_many_attempts" });
      return;
    }
    const parsed = LoginSchema.safeParse(request.body);
    const credentials = parsed.success ? sessions.authenticate(parsed.data.username, parsed.data.password) : null;
    if (!credentials) {
      const attempt = existing ?? { failures: 0, lockCount: 0, lockedUntil: 0, updatedAt: current };
      attempt.failures += 1;
      attempt.updatedAt = current;
      attempts.set(key, attempt);
      if (attempt.failures >= maxFailedAttempts) {
        applyLock(attempt, current, lockoutBaseSeconds, fixedLockoutMs);
        response.setHeader("retry-after", secondsUntil(attempt.lockedUntil, current));
        response.status(429).json({ error: "too_many_attempts" });
        return;
      }
      response.status(401).json({ error: "invalid_credentials" });
      return;
    }
    attempts.delete(key);
    response.setHeader("set-cookie", sessions.issueCookie());
    // 200 + 身份信息（前端只判断 response.ok，故对存量客户端向后兼容）。
    response.status(200).json({
      username: credentials.username,
      mustChangePassword: credentials.mustChangePassword,
    });
  });

  app.post("/api/auth/logout", (_request, response) => {
    // 同时清除管理端会话与公开门户会话，避免退出后公开门户仍残留上一账号的登录态。
    const cookies = [sessions.clearCookie()];
    if (clearPublicCookie) cookies.push(clearPublicCookie());
    response.setHeader("set-cookie", cookies);
    response.status(204).end();
  });

  app.get("/api/auth/lock-status", (request, response) => {
    const current = now();
    pruneAttempts(attempts, current);
    const attempt = attempts.get(request.ip ?? "unknown");
    const remaining = attempt && attempt.lockedUntil > current ? secondsUntil(attempt.lockedUntil, current) : 0;
    response.json({ locked: remaining > 0, retryAfterSeconds: remaining });
  });
}

function applyLock(attempt: LoginAttempt, current: number, baseSeconds: number, fixedLockoutMs: number | null): void {
  if (fixedLockoutMs != null) {
    attempt.lockedUntil = current + fixedLockoutMs;
    return;
  }
  attempt.lockCount += 1;
  const exponent = Math.min(attempt.lockCount, maxLockExponent);
  attempt.lockedUntil = current + Math.pow(baseSeconds, exponent) * 1_000;
}

function secondsUntil(lockedUntil: number, current: number): number {
  return Math.max(1, Math.ceil((lockedUntil - current) / 1_000));
}

function pruneAttempts(attempts: Map<string, LoginAttempt>, current: number): void {
  // 保留失败/锁定状态至少 24 小时无操作，以便递增锁定跨锁定期生效；成功登录即清除。
  const retentionMs = 24 * 60 * 60_000;
  for (const [address, candidate] of attempts) {
    if (candidate.lockedUntil > current) continue;
    if (current - candidate.updatedAt >= retentionMs) attempts.delete(address);
  }
}
