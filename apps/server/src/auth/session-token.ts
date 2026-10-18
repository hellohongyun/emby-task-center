import { createHmac, timingSafeEqual } from "node:crypto";

type SessionPurpose = "admin" | "member";

interface SessionTokenOptions {
  secret: string;
  purpose: SessionPurpose;
}

const version = "v2";
const encodedPayload = /^[A-Za-z0-9_-]{1,1024}$/;

function sign(payload: string, options: SessionTokenOptions): string {
  // 隔离签名用途：即使两类会话共用配置密钥，也不能相互冒充。
  const key = createHmac("sha256", options.secret)
    .update(`emby-task-center:session:${version}:${options.purpose}`)
    .digest();
  return createHmac("sha256", key).update(payload).digest("base64url");
}

export function issueSessionToken(options: SessionTokenOptions & { expiresAt: number; payload: string }): string {
  if (!Number.isSafeInteger(options.expiresAt) || options.expiresAt <= 0 || !encodedPayload.test(options.payload)) {
    throw new Error("invalid_session_payload");
  }
  const payload = `${version}.${options.purpose}.${options.expiresAt}.${options.payload}`;
  return `${payload}.${sign(payload, options)}`;
}

/** 只接受带版本、用途的新格式；旧 token 必须重新登录，不能保留原来的跨用途漏洞。 */
export function readSessionToken(token: string, options: SessionTokenOptions, now = new Date()): string | null {
  if (token.length > 1200) return null;
  const parts = token.split(".");
  if (parts.length !== 5) return null;
  const [tokenVersion, purpose, expiresText, payload, signature] = parts;
  if (tokenVersion !== version || purpose !== options.purpose) return null;
  if (!expiresText || !/^[1-9]\d*$/.test(expiresText)) return null;
  const expiresAt = Number(expiresText);
  const nowSeconds = Math.floor(now.getTime() / 1_000);
  if (!Number.isSafeInteger(expiresAt) || !Number.isFinite(nowSeconds) || expiresAt <= nowSeconds) return null;
  if (!payload || !encodedPayload.test(payload) || !signature || !/^[A-Za-z0-9_-]{43}$/.test(signature)) return null;
  const expected = sign(`${tokenVersion}.${purpose}.${expiresText}.${payload}`, options);
  if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  return payload;
}
