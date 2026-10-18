import { issueSessionToken, readSessionToken } from "../auth/session-token";

const cookieName = "emby_public_session";
const lifetimeSeconds = 30 * 24 * 60 * 60; // 投稿人会话 30 天

export interface PublicSession {
  issueCookie(email: string): string;
  clearCookie(): string;
  read(cookieHeader: string | undefined): { email: string | null };
}

export function createPublicSessionManager(secret: string): PublicSession {
  function issueCookie(email: string): string {
    const expiresAt = Math.floor(Date.now() / 1_000) + lifetimeSeconds;
    // 邮箱 base64url 编码：避免其中的 "." 破坏 token 的分段。
    const emailEnc = Buffer.from(email.toLowerCase().trim(), "utf8").toString("base64url");
    const token = issueSessionToken({ secret, purpose: "member", expiresAt, payload: emailEnc });
    return `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${lifetimeSeconds}`;
  }

  function clearCookie(): string {
    return `${cookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
  }

  function read(cookieHeader: string | undefined): { email: string | null } {
    const token = readCookie(cookieHeader, cookieName);
    if (!token) return { email: null };
    const emailEnc = readSessionToken(token, { secret, purpose: "member" });
    if (!emailEnc) return { email: null };
    const email = Buffer.from(emailEnc, "base64url").toString("utf8");
    if (Buffer.from(email, "utf8").toString("base64url") !== emailEnc) return { email: null };
    return { email };
  }

  return { issueCookie, clearCookie, read };
}

function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const pair of header.split(";")) {
    const separator = pair.indexOf("=");
    if (separator < 0 || pair.slice(0, separator).trim() !== name) continue;
    return pair.slice(separator + 1).trim();
  }
  return null;
}
