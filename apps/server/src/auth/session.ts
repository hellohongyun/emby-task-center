import { randomBytes } from "node:crypto";
import type { RequestHandler } from "express";
import { issueSessionToken, readSessionToken } from "./session-token";

const cookieName = "emby_task_session";
const defaultLifetimeSeconds = 7 * 24 * 60 * 60;

/** 登录成功后的身份信息（P1：管理员账号存在数据库设置里）。 */
export interface SessionCredentials {
  username: string;
  /** 仍在使用初始化默认口令时为 true，前端据此提示（不强制修改）。 */
  mustChangePassword: boolean;
}

export interface SessionOptions {
  sessionSecret: string;
  lifetimeSeconds?: number;
  /** 校验管理员凭据；用户名可留空以兼容只提交口令的存量前端；失败返回 null。 */
  verifyCredentials: (username: string | undefined, password: string) => SessionCredentials | null;
}

export interface SessionManager {
  authenticate(username: string | undefined, password: string): SessionCredentials | null;
  issueCookie(now?: Date): string;
  clearCookie(): string;
  requireSession: RequestHandler;
}

export function createSessionManager(options: SessionOptions): SessionManager {
  const lifetimeSeconds = options.lifetimeSeconds ?? defaultLifetimeSeconds;

  function authenticate(username: string | undefined, password: string): SessionCredentials | null {
    return options.verifyCredentials(username, password);
  }

  function issueCookie(now = new Date()): string {
    const expiresAt = Math.floor(now.getTime() / 1_000) + lifetimeSeconds;
    const token = issueSessionToken({
      secret: options.sessionSecret,
      purpose: "admin",
      expiresAt,
      payload: randomBytes(18).toString("base64url"),
    });
    return `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${lifetimeSeconds}`;
  }

  function clearCookie(): string {
    return `${cookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
  }

  const requireSession: RequestHandler = (request, response, next) => {
    const token = readCookie(request.headers.cookie, cookieName);
    if (!token || !readSessionToken(token, { secret: options.sessionSecret, purpose: "admin" })) {
      response.status(401).json({ error: "unauthorized" });
      return;
    }
    next();
  };

  return { authenticate, issueCookie, clearCookie, requireSession };
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
