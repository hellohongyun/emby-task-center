import { issueSessionToken, readSessionTokenClaims } from "../auth/session-token";

const cookieName = "emby_public_session";
const lifetimeSeconds = 30 * 24 * 60 * 60; // 投稿人会话 30 天

export interface PublicSession {
  issueCookie(email: string): string;
  clearCookie(): string;
  read(cookieHeader: string | undefined): { email: string | null; memberMissing?: true };
}

type MemberIdentity = { id: number; createdAt: string };

export function createPublicSessionManager(
  secret: string,
  findMember?: (email: string) => MemberIdentity | null,
): PublicSession {
  function issueCookie(email: string): string {
    const expiresAt = Math.floor(Date.now() / 1_000) + lifetimeSeconds;
    const normalizedEmail = email.toLowerCase().trim();
    const member = findMember?.(normalizedEmail);
    const identity = member ? `${member.id}\0${normalizedEmail}` : normalizedEmail;
    const payload = Buffer.from(identity, "utf8").toString("base64url");
    const token = issueSessionToken({ secret, purpose: "member", expiresAt, payload });
    return `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${lifetimeSeconds}`;
  }

  function clearCookie(): string {
    return `${cookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
  }

  function read(cookieHeader: string | undefined): ReturnType<PublicSession["read"]> {
    const token = readCookie(cookieHeader, cookieName);
    if (!token) return { email: null };
    const claims = readSessionTokenClaims(token, { secret, purpose: "member" });
    if (!claims) return { email: null };
    const identity = Buffer.from(claims.payload, "base64url").toString("utf8");
    if (Buffer.from(identity, "utf8").toString("base64url") !== claims.payload) return { email: null };
    const boundary = identity.indexOf("\0");
    const email = identity.slice(boundary + 1);
    const member = findMember?.(email);
    if (findMember && !member) return { email: null, memberMissing: true };
    if (member) {
      if (boundary >= 0 && identity.slice(0, boundary) !== String(member.id)) return { email: null };
      if (boundary < 0) {
        // Legacy cookies identify only the email. Accept them only when the current
        // record demonstrably predates the signed issue second.
        const issuedAt = (claims.expiresAt - lifetimeSeconds) * 1_000;
        if (!(Date.parse(member.createdAt) < issuedAt)) return { email: null };
      }
    }
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
