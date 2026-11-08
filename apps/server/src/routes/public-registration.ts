import { createHash, timingSafeEqual } from "node:crypto";
import type { Express, Request, Response } from "express";
import { z } from "zod";

import type { AppDatabase } from "@emby-task-center/database/client";
import type { EmailNotifier } from "../notifications/email-service";
import { workflowLog, type WorkflowLog, type WorkflowLogger } from "../logging/workflow-log";
import { readGroupRegistrationSettings } from "../settings/group-registration";
import type { CardActivationMode } from "../subscriptions/card-activation";
import { inspectCard } from "../subscriptions/cards";
import { isMemberExpiryCleanupPending } from "../subscriptions/member-expiry-cleanup-guard";
import { joinSourceSchema, qqNumberSchema } from "../subscriptions/member-profile";
import { isUnlimitedMembership } from "../subscriptions/membership-expiry-grant";
import { getSubmissionUserByEmail, memberStatus } from "../subscriptions/membership";
import { createPendingCardRegistrations } from "../subscriptions/pending-cards";
import { createRateLimiter } from "../subscriptions/rate-limit";
import { buildHtml } from "../subscriptions/send-notifications";
import { issueVerificationCode, verifyVerificationCode } from "../subscriptions/verification";
import { publicCardPreview } from "./public-card-preview";

const entrySchema = z.strictObject({ email: z.string().trim().email().max(254) });
const cardCodeSchema = z.string().trim().min(4).max(64);
const inviteCodeSchema = z.string().trim().max(120).optional();
const cardCheckSchema = entrySchema.extend({ cardCode: cardCodeSchema.optional() });
const codeSchema = cardCheckSchema.extend({ inviteCode: inviteCodeSchema });
export const emailVerificationSchema = entrySchema.extend({ code: z.string().trim().length(6) });
const registrationVerifySchema = emailVerificationSchema.extend({
  cardCode: cardCodeSchema,
  inviteCode: inviteCodeSchema,
});
const activateSchema = z.union([
  emailVerificationSchema.extend({ cardCode: cardCodeSchema }),
  entrySchema.extend({
    cardCode: cardCodeSchema,
    registrationToken: z.string().min(1).max(128),
    joinSource: joinSourceSchema.optional(),
  }),
]);
type Invitation = ReturnType<typeof readGroupRegistrationSettings>;

function qqNumberFromEmail(email: string): string | null {
  const match = /^(\d+)@qq\.com$/.exec(email);
  const result = qqNumberSchema.safeParse(match?.[1]);
  return result.success ? result.data : null;
}

function invitationConfigured(invitation: Invitation): boolean {
  return !invitation.enabled || Boolean(invitation.groupNumber && invitation.inviteCode);
}

function invitationVersion(invitation: Invitation): string {
  if (!invitation.enabled) return "";
  return createHash("sha256")
    .update(JSON.stringify([invitation.groupNumber, invitation.inviteCode]))
    .digest("hex");
}

function checkInvitation(response: Response, invitation: Invitation, candidate?: string, log?: WorkflowLog): boolean {
  if (!invitationConfigured(invitation)) {
    log?.write("warn", "invite_unavailable", "注册群邀请码配置不完整");
    response.status(503).json({ error: "registration_unavailable" });
    return false;
  }
  if (!invitation.enabled) return true;
  if (!candidate) {
    log?.write("warn", "invite_missing", "注册未填写群邀请码");
    response.status(400).json({ error: "group_invite_required" });
    return false;
  }
  const supplied = createHash("sha256").update(candidate).digest();
  const expected = createHash("sha256").update(invitation.inviteCode).digest();
  if (timingSafeEqual(supplied, expected)) return true;
  log?.write("warn", "invite_rejected", "群邀请码校验失败");
  response.status(400).json({ error: "invalid_group_invite" });
  return false;
}

function verifyCode(database: AppDatabase, response: Response, email: string, code: string): boolean {
  const verification = verifyVerificationCode(database, email, code);
  if (verification.ok) return true;
  response.status(verification.reason === "too_many_attempts" ? 429 : 401).json({ error: verification.reason });
  return false;
}

export function registerPublicRegistrationRoutes(
  app: Express,
  options: { database: AppDatabase; email?: EmailNotifier; logger?: WorkflowLogger },
) {
  const { database } = options;
  const pending = createPendingCardRegistrations();
  const codePerMinute = createRateLimiter(5, 60_000);
  const codePerHourEmail = createRateLimiter(10, 3_600_000);
  const entryPerMinute = createRateLimiter(10, 60_000);
  const cardCheckPerMinute = createRateLimiter(10, 60_000);

  // 已过期的会员仍走登录流程，续费在门户「我的」处理。
  function membershipGate(email: string, now = new Date()) {
    const user = getSubmissionUserByEmail(database, email);
    const status = user ? memberStatus(user, now) : "none";
    return {
      user,
      registered: Boolean(user),
      expired: status === "expired",
    };
  }

  // 仅分流登录与注册，限流防止批量探测会员邮箱。
  app.post("/api/public/subscriptions/entry", (request: Request, response: Response) => {
    const parsed = entrySchema.safeParse(request.body);
    if (!parsed.success) return void response.status(400).json({ error: "invalid_request" });
    const email = parsed.data.email.toLowerCase().trim();
    if (!entryPerMinute.check(`ip:${request.ip ?? "unknown"}`))
      return void response.status(429).json({ error: "rate_limited" });
    const gate = membershipGate(email);
    if (gate.user && !gate.user.enabled) return void response.status(403).json({ error: "member_disabled" });
    const result = { registered: gate.registered, needsCard: !gate.registered, expired: gate.expired };
    if (gate.registered) return void response.json(result);
    const qqNumber = qqNumberFromEmail(email);
    if (!qqNumber) return void response.status(400).json({ error: "qq_email_required" });
    const invitation = readGroupRegistrationSettings(database);
    if (!invitationConfigured(invitation)) return void response.status(503).json({ error: "registration_unavailable" });
    response.json({
      ...result,
      qqNumber,
      groupInvite: invitation.enabled ? { groupNumber: invitation.groupNumber } : null,
    });
  });

  // 预检只返回卡密信息。发码和开通时再次校验。
  app.post("/api/public/subscriptions/card/check", (request: Request, response: Response) => {
    const parsed = cardCheckSchema.safeParse(request.body);
    if (!parsed.success) return void response.status(400).json({ error: "invalid_request" });
    const email = parsed.data.email.toLowerCase().trim();
    if (!cardCheckPerMinute.check(`ip:${request.ip ?? "unknown"}`))
      return void response.status(429).json({ error: "rate_limited" });
    const gate = membershipGate(email);
    if (gate.user && !gate.user.enabled) return void response.status(403).json({ error: "member_disabled" });
    if (!gate.registered && !qqNumberFromEmail(email))
      return void response.status(400).json({ error: "qq_email_required" });
    const cardCode = parsed.data.cardCode;
    if (!cardCode) {
      if (gate.registered) {
        return void response.json({
          ok: true,
          registered: true,
          needsCard: false,
          expired: gate.expired,
          card: null,
        });
      }
      return void response.status(400).json({ error: "card_required" });
    }
    const now = new Date();
    const inspection = inspectCard(database, cardCode, email, now);
    if (!inspection.ok) return void response.status(400).json({ error: inspection.reason });
    if (!inspection.idempotent && gate.user && isMemberExpiryCleanupPending(database, gate.user.id))
      return void response.status(409).json({ error: "member_cleanup_pending" });
    if (isUnlimitedMembership(gate.user) && !inspection.idempotent)
      return void response.status(409).json({ error: "member_renewal_not_needed" });
    response.json({
      ok: true,
      registered: gate.registered,
      needsCard: !gate.registered,
      expired: gate.expired,
      card: publicCardPreview(database, inspection, gate.user, now),
    });
  });

  app.post("/api/public/subscriptions/code", async (request: Request, response: Response) => {
    const parsed = codeSchema.safeParse(request.body);
    if (!parsed.success) return void response.status(400).json({ error: "invalid_request" });
    const email = parsed.data.email.toLowerCase();
    if (!codePerMinute.check(`ip:${request.ip ?? "unknown"}`))
      return void response.status(429).json({ error: "rate_limited" });
    if (!codePerHourEmail.check(`email:${email}`))
      return void response.status(429).json({ error: "rate_limited_email" });
    const gate = membershipGate(email);
    if (gate.user && !gate.user.enabled) return void response.status(403).json({ error: "member_disabled" });
    const needsCard = !gate.registered;
    const log = needsCard ? workflowLog(options.logger, "member-registration") : undefined;
    const { cardCode } = parsed.data;
    let invitation = "";
    if (needsCard) {
      if (!qqNumberFromEmail(email)) return void response.status(400).json({ error: "qq_email_required" });
      if (!cardCode) return void response.status(400).json({ error: "card_required" });
      const inspection = inspectCard(database, cardCode, email);
      if (!inspection.ok) {
        log?.write("warn", "registration_card_rejected", "注册卡密校验失败", { reason: inspection.reason });
        return void response.status(400).json({ error: inspection.reason });
      }
      if (inspection.idempotent) return void response.status(403).json({ error: "not_member" });
      log?.write("info", "registration_card_checked", "注册卡密校验通过，等待邮箱验证后核销");
      const settings = readGroupRegistrationSettings(database);
      if (!checkInvitation(response, settings, parsed.data.inviteCode, log)) return;
      if (settings.enabled) log?.write("info", "registration_invite_checked", "群邀请码校验通过");
      invitation = invitationVersion(settings);
    }

    if (needsCard && !options.email?.configured) {
      log?.write("warn", "registration_smtp_unavailable", "邮箱验证码发送失败，SMTP 尚未配置");
      return void response.status(502).json({ error: "email_send_failed" });
    }
    let binding: ReturnType<typeof pending.bind> | undefined;
    const started = Date.now();
    try {
      const code = issueVerificationCode(database, email);
      binding = log && cardCode ? pending.bind(email, cardCode, invitation, log.runId) : undefined;
      if (!binding) pending.clear(email);
      const text = gate.registered
        ? `你的「天鸿影院」登录验证码：${code}（10 分钟内有效）。如非本人操作请忽略。`
        : `你的「天鸿影院」邮箱验证码：${code}（10 分钟内有效）。验证后可填写会员资料。`;
      const subject = "[天鸿影院] 邮箱验证码";
      log?.write("info", "registration_email_sending", "正在发送注册邮箱验证码");
      await options.email?.sendNotification(email, subject, text, buildHtml(subject, text));
      log?.write("info", "registration_email_sent", "注册邮箱验证码已提交给 SMTP", undefined, Date.now() - started);
      response.json({ sent: true, registered: gate.registered, needsCard, expired: gate.expired });
    } catch {
      if (binding) pending.clear(email, binding);
      log?.write(
        "warn",
        "registration_email_failed",
        "注册邮箱验证码发送失败，卡密仍可使用",
        undefined,
        Date.now() - started,
      );
      response.status(502).json({ error: "email_send_failed" });
    }
  });

  app.post("/api/public/subscriptions/register/verify", (request: Request, response: Response) => {
    const parsed = registrationVerifySchema.safeParse(request.body);
    if (!parsed.success) return void response.status(400).json({ error: "invalid_request" });
    const { cardCode, code, inviteCode } = parsed.data;
    const email = parsed.data.email.toLowerCase();
    const qqNumber = qqNumberFromEmail(email);
    if (!qqNumber) return void response.status(400).json({ error: "qq_email_required" });
    const user = getSubmissionUserByEmail(database, email);
    if (user?.enabled === false) return void response.status(403).json({ error: "member_disabled" });
    if (user) return void response.status(409).json({ error: "already_registered" });

    const entry = pending.read(email);
    const log = entry && workflowLog(options.logger, "member-registration", entry.runId);
    const settings = readGroupRegistrationSettings(database);
    if (!entry || entry.invitation !== invitationVersion(settings))
      return void response.status(400).json({ error: "registration_verification_required" });
    if (entry.cardCode !== cardCode.toUpperCase()) return void response.status(400).json({ error: "card_mismatch" });
    if (!checkInvitation(response, settings, inviteCode, log)) return;
    const inspection = inspectCard(database, cardCode, email);
    if (!inspection.ok) return void response.status(400).json({ error: inspection.reason });
    if (inspection.idempotent) return void response.status(403).json({ error: "not_member" });
    if (!verifyCode(database, response, email, code)) {
      log?.write("warn", "registration_verification_rejected", "邮箱验证码校验失败");
      return;
    }
    log?.write("info", "registration_verified", "邮箱验证通过，等待会员确认资料");
    response.json({ registrationToken: pending.verify(entry), qqNumber });
  });

  function authorizeActivation(
    request: Request,
    response: Response,
  ): { email: string; cardCode: string; mode: CardActivationMode; log?: WorkflowLog } | undefined {
    const parsed = activateSchema.safeParse(request.body);
    if (!parsed.success) return void response.status(400).json({ error: "invalid_request" });
    const { cardCode } = parsed.data;
    const email = parsed.data.email.toLowerCase();
    const user = getSubmissionUserByEmail(database, email);
    if (user?.enabled === false) return void response.status(403).json({ error: "member_disabled" });
    if ("code" in parsed.data) {
      if (!user) {
        const card = inspectCard(database, cardCode, email);
        if (card.ok && card.idempotent) return void response.status(403).json({ error: "not_member" });
        const error = qqNumberFromEmail(email) ? "registration_verification_required" : "qq_email_required";
        return void response.status(400).json({ error });
      }
      if (isMemberExpiryCleanupPending(database, user.id)) {
        const card = inspectCard(database, cardCode, email);
        if (card.ok && !card.idempotent) return void response.status(409).json({ error: "member_cleanup_pending" });
      }
      if (!verifyCode(database, response, email, parsed.data.code)) return;
      return { email, cardCode, mode: { kind: "renew" } };
    }

    if (user) return void response.status(409).json({ error: "already_registered" });
    const qqNumber = qqNumberFromEmail(email);
    if (!qqNumber) return void response.status(400).json({ error: "qq_email_required" });
    const entry = pending.read(email);
    const settings = readGroupRegistrationSettings(database);
    if (
      !entry?.token ||
      entry.token !== parsed.data.registrationToken ||
      entry.invitation !== invitationVersion(settings)
    )
      return void response.status(400).json({ error: "registration_verification_required" });
    if (entry.cardCode !== cardCode.toUpperCase()) return void response.status(400).json({ error: "card_mismatch" });
    const log = workflowLog(options.logger, "member-registration", entry.runId);
    return { email, cardCode, log, mode: { kind: "register", qqNumber, joinSource: parsed.data.joinSource || null } };
  }

  return { authorizeActivation, clear: pending.clear };
}
