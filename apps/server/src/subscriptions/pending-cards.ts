import { randomBytes } from "node:crypto";
import { VERIFICATION_CODE_TTL_MS } from "./verification";

interface PendingRegistration {
  cardCode: string;
  invitation: string;
  runId: string;
  expiresAt: number;
  token?: string;
}

/** 注册凭证绑定已验证的邮箱、卡密和群邀请配置，进程重启或过期后须重新发码。 */
export function createPendingCardRegistrations() {
  const entries = new Map<string, PendingRegistration>();
  let nextPruneAt = 0;

  function bind(email: string, cardCode: string, invitation: string, runId: string): PendingRegistration {
    const now = Date.now();
    if (now >= nextPruneAt) {
      for (const [address, entry] of entries) if (entry.expiresAt <= now) entries.delete(address);
      nextPruneAt = now + 60_000;
    }
    const entry = { cardCode: cardCode.toUpperCase(), invitation, runId, expiresAt: now + VERIFICATION_CODE_TTL_MS };
    entries.set(email, entry);
    return entry;
  }

  function read(email: string): PendingRegistration | undefined {
    const entry = entries.get(email);
    if (entry && entry.expiresAt <= Date.now()) {
      entries.delete(email);
      return undefined;
    }
    return entry;
  }

  function verify(entry: PendingRegistration): string {
    entry.token = randomBytes(32).toString("base64url");
    entry.expiresAt = Date.now() + VERIFICATION_CODE_TTL_MS;
    return entry.token;
  }

  function clear(email: string, expected?: PendingRegistration): void {
    if (!expected || entries.get(email) === expected) entries.delete(email);
  }

  return { bind, read, verify, clear };
}
