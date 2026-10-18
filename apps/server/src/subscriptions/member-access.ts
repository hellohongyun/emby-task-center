import type { RequestHandler } from "express";
import type { AppDatabase } from "@emby-task-center/database/client";
import { concurrencyEscalationState } from "@emby-task-center/database/schema";
import { eq } from "drizzle-orm";
import type { PublicSession } from "./public-session";
import { getSubmissionUserByEmail, memberStatus } from "./membership";

export function memberAccessError(
  database: AppDatabase,
  email: string,
  content = false,
  now = new Date(),
): string | null {
  const member = getSubmissionUserByEmail(database, email);
  if (!member) return "not_member";
  if (!member.enabled) return "member_disabled";
  if (!content) return null;
  if (memberStatus(member, now) === "expired") return "membership_expired";
  const state = database
    .select()
    .from(concurrencyEscalationState)
    .where(eq(concurrencyEscalationState.memberId, member.id))
    .get();
  if (state?.disabledUntil) return "member_frozen";
  return null;
}

export function requirePublicMember(database: AppDatabase, session: PublicSession): RequestHandler {
  return (request, response, next) => {
    const path = request.path;
    if (!path.startsWith("/api/public/")) return next();
    const anonymous =
      /^\/api\/public\/subscriptions\/(entry|card\/check|code|login|activate|logout)$/.test(path) ||
      path === "/api/public/platforms" ||
      path === "/api/public/articles";
    if (anonymous) return next();
    const { email } = session.read(request.headers.cookie);
    if (!email) return void response.status(401).json({ error: "unauthorized" });
    const profile =
      path === "/api/public/subscriptions/member" ||
      path === "/api/public/subscriptions/member/emby" ||
      path === "/api/public/mail-preferences";
    const unfreeze = path.startsWith("/api/public/subscriptions/member/unfreeze");
    const member = getSubmissionUserByEmail(database, email);
    const error =
      memberAccessError(database, email, !profile && !unfreeze) ??
      (unfreeze && member && memberStatus(member, new Date()) === "expired" ? "membership_expired" : null);
    if (!error) return next();
    if (error === "member_disabled" || error === "not_member") response.setHeader("set-cookie", session.clearCookie());
    response.status(403).json({ error });
  };
}
