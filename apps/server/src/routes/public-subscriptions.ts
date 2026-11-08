import { memberAccessError } from "../subscriptions/member-access";
import { activateMembershipWithCard } from "../subscriptions/card-activation";
import { deliverRenewalReceipt, type RenewalEmailStatus } from "../subscriptions/renewal-outbox";
import { syncMemberEmbyAccess } from "../subscriptions/emby-access";
import type { Express, Request, Response } from "express";
import { eq } from "drizzle-orm";
import { z } from "zod";

import type { AppDatabase } from "@emby-task-center/database/client";
import { concurrencyEscalationState, submissionUsers } from "@emby-task-center/database/schema";
import type { EmailNotifier } from "../notifications/email-service";
import type { Logger } from "../logging/logger";
import type { EmbyClient } from "../integrations/emby-client";
import type { PublicSession } from "../subscriptions/public-session";
import type { RedeemResult } from "../subscriptions/cards";
import { getDriveExpiry } from "../subscriptions/drive-expiry";
import { visibleMembershipExpiryLabel } from "../subscriptions/membership-expiry-grant";
import { verifyVerificationCode } from "../subscriptions/verification";
import { getSubmissionUserByEmail, memberConcurrencyStatus, memberStatus } from "../subscriptions/membership";
import { confirmUnfreeze, memberUnfreezeView, requestUnfreeze } from "../subscriptions/self-unfreeze";
import { provisionEmbyAccount } from "../subscriptions/emby-account";
import { createEmbyUserService } from "../integrations/emby-user-service";
import { createRateLimiter } from "../subscriptions/rate-limit";
import { buildHtml } from "../subscriptions/send-notifications";
import { buildEmbyOnboardNotice, buildEmbyWelcomeEmail } from "../subscriptions/member-notices";
import { embyServerAddress } from "../integrations/emby-address";
import { readSetting } from "../settings/store";
import { emailVerificationSchema, registerPublicRegistrationRoutes } from "./public-registration";
import { registerPublicMemberProfileRoutes } from "./member-profile";

const passwordSchema = z.strictObject({ password: z.string().trim().min(6).max(200) });
/** 自助解冻：同一账号每分钟最多试 10 次（正常流程 1-2 次；挡住拿脚本刷"等没等满"的人）。 */
const unfreezeAttemptsPerMinute = createRateLimiter(10, 60_000);

export interface PublicSubscriptionOptions {
  database: AppDatabase;
  publicSession: PublicSession;
  email?: EmailNotifier;
  emby?: EmbyClient;
  logger?: Logger;
}

/**
 * 会员自己看到的那份摘要。
 *
 * 除了会员状态，还要带上**并发上限与超限处置状态**：被冻结的会员打开门户时得能看到
 * "为什么播不了、什么时候解冻"。否则他只会看到"有效"、却什么都不知道，只能来问管理员。
 * 另外带上**自助解冻状态**（能不能解、弹窗文案、本月还剩几次）——按钮与弹窗都由它决定。
 */
function toMemberView(database: AppDatabase, user: typeof submissionUsers.$inferSelect, now = new Date()) {
  const state = database
    .select()
    .from(concurrencyEscalationState)
    .where(eq(concurrencyEscalationState.memberId, user.id))
    .get();
  return {
    email: user.email,
    status: memberStatus(user, now),
    contentAccess: !memberAccessError(database, user.email, true, now),
    subscriptionExpiresAt: user.subscriptionExpiresAt ?? null,
    /**
     * 当前这份有效期的「到期时间名称」（由带 expiry_label 的自定义卡密写入）。
     *
     * 用户侧所有页面与提醒邮件都以它为主口径，为空才回落真实日期——见
     * docs/card-keys.md。管理员侧不看这个字段（要真日期核对）。
     */
    membershipExpiryLabel: visibleMembershipExpiryLabel(user),
    embyUsername: user.embyUsername ?? null,
    embyUserId: user.embyUserId ?? null,
    embyMaxStreams: user.embyMaxStreams ?? null,
    concurrency: memberConcurrencyStatus(user, state, now),
    unfreeze: memberUnfreezeView(database, user, now),
  };
}

function toMemberViewByEmail(database: AppDatabase, email: string, now = new Date()) {
  const user = getSubmissionUserByEmail(database, email);
  return user ? toMemberView(database, user, now) : null;
}

function redeemedCardView(database: AppDatabase, card: RedeemResult, member: ReturnType<typeof toMemberView> | null) {
  const capped = member && getDriveExpiry(database);
  return {
    code: card.code,
    kind: card.kind,
    name: card.name,
    expiresAt: capped ? member.subscriptionExpiresAt : card.expiresAt,
    expiryLabel: capped ? member.membershipExpiryLabel : card.expiryLabel,
    idempotent: card.idempotent,
  };
}

export function registerPublicSubscriptionRoutes(app: Express, options: PublicSubscriptionOptions): void {
  function sessionEmail(request: Request): string | null {
    const { email } = options.publicSession.read(request.headers.cookie);
    return email && !memberAccessError(options.database, email) ? email : null;
  }

  const registration = registerPublicRegistrationRoutes(app, options);
  registerPublicMemberProfileRoutes(app, options, sessionEmail);

  app.post("/api/public/subscriptions/login", async (request: Request, response: Response) => {
    const parsed = emailVerificationSchema.safeParse(request.body);
    if (!parsed.success) return void response.status(400).json({ error: "invalid_request" });
    const email = parsed.data.email.toLowerCase().trim();
    if (getSubmissionUserByEmail(options.database, email)?.enabled === false)
      return void response.status(403).json({ error: "member_disabled" });
    const verification = verifyVerificationCode(options.database, email, parsed.data.code);
    if (!verification.ok) {
      return void response
        .status(verification.reason === "too_many_attempts" ? 429 : 401)
        .json({ error: verification.reason === "too_many_attempts" ? "too_many_attempts" : "invalid_code" });
    }
    const user = getSubmissionUserByEmail(options.database, email);
    if (!user) return void response.status(403).json({ error: "not_member" });
    response.setHeader("set-cookie", options.publicSession.issueCookie(email));
    response.json({ status: "member", email, member: toMemberView(options.database, user) });
  });

  app.post("/api/public/subscriptions/activate", async (request: Request, response: Response) => {
    const activation = registration.authorizeActivation(request, response);
    if (!activation) return;
    const { email, cardCode, mode, log } = activation;
    const started = Date.now();
    log?.write("info", "registration_activating", "收到资料确认，正在核销卡密并创建会员");
    // 核销、会员有效期与续期凭证在同一 SQLite 事务中提交，外部操作仍在事务外。
    let activated: ReturnType<typeof activateMembershipWithCard>;
    try {
      activated = activateMembershipWithCard(options.database, cardCode, email, new Date(), mode);
    } catch (caught) {
      const reason = (caught as { message?: string }).message ?? "";
      const known = ["invalid_card", "card_used", "card_expired"];
      log?.write(
        known.includes(reason) ? "warn" : "error",
        "registration_activation_failed",
        "会员开通事务未完成",
        { reason: known.includes(reason) || reason === "already_registered" ? reason : "activation_rejected" },
        Date.now() - started,
      );
      if (reason === "member_disabled" || reason === "not_member")
        return void response.status(403).json({ error: reason });
      if (
        reason === "member_renewal_not_needed" ||
        reason === "member_cleanup_pending" ||
        reason === "already_registered"
      )
        return void response.status(409).json({ error: reason });
      if (known.includes(reason)) return void response.status(400).json({ error: reason });
      throw caught;
    }
    registration.clear(email);
    const { card, existing, receiptKey } = activated;
    if (!card.idempotent) log?.write("info", "registration_committed", "会员资料已保存，卡密已核销");
    // 幂等重试只返回当前结果：旧卡不能重新启用已停用/过期账号、清掉提醒或再次触发 Emby 开户。
    // 会员已被删除时也不能凭已消费的卡重新创建；长期会员的 null 到期时间同样必须原样保留。
    if (card.idempotent) {
      if (!existing) return void response.status(403).json({ error: "not_member" });
      const member = toMemberView(options.database, existing);
      response.setHeader("set-cookie", options.publicSession.issueCookie(email));
      return void response.json({
        status: "activated",
        email,
        member,
        card: redeemedCardView(options.database, card, member),
        emby: null,
        emailStatus: "unchanged",
      });
    }
    const emailStatus: RenewalEmailStatus | undefined = receiptKey
      ? await deliverRenewalReceipt(options.database, options.email, receiptKey)
      : undefined;
    // 自动创建/关联 Emby 账号
    let emby: { embyUserId: string; embyUsername: string; password: string } | null = null;
    if (options.emby?.configured) {
      log?.write("info", "registration_emby_started", "正在创建或关联 Emby 账号");
      try {
        emby = await provisionEmbyAccount(options.database, options.emby, email, undefined, options.logger);
        log?.write("info", "registration_emby_ready", "Emby 账号已关联");
      } catch {
        log?.write("warn", "registration_emby_failed", "Emby 开户失败，会员资料已保存");
      }
    } else log?.write("info", "registration_emby_skipped", "Emby 尚未配置，跳过账号创建");
    // 续费用户：重新启用 Emby 账号（若之前被到期停用）
    if (existing && emby?.embyUserId && options.emby?.configured) {
      try {
        await syncMemberEmbyAccess(options.database, options.emby, existing.id);
      } catch {
        /* 忽略 */
      }
    }
    // 通知用户 Emby 初始账号（若新创建且有密码）。主题与正文都来自设置（系统设置 →「会员」），
    // 管理员改文案后无需改代码：占位符由 member-notices 按当前配置渲染。
    const serverAddress = embyServerAddress(options.database);
    const maxStreams = existing
      ? (existing.embyMaxStreams ?? null)
      : readSetting(options.database, "member.newMemberMaxStreams");
    // 「我的」页那块开通提示（标题 + 正文）：与开通邮件同一套后台模板，服务端渲染好再下发。
    const onboard = emby
      ? buildEmbyOnboardNotice(options.database, {
          email,
          username: emby.embyUsername,
          password: emby.password,
          maxStreams,
          serverAddress,
        })
      : null;
    if (emby?.password && options.email?.configured) {
      const { subject, text } = buildEmbyWelcomeEmail(options.database, {
        email,
        username: emby.embyUsername,
        password: emby.password,
        maxStreams,
        serverAddress,
      });
      log?.write("info", "registration_welcome_sending", "正在发送开通通知邮件");
      try {
        await options.email.sendNotification(email, subject, text, buildHtml(subject, text));
        log?.write("info", "registration_welcome_sent", "开通通知已提交给 SMTP");
      } catch {
        log?.write("warn", "registration_welcome_failed", "开通通知邮件发送失败，会员已开通");
      }
    }
    const finalAccessError = memberAccessError(options.database, email);
    if (finalAccessError) {
      log?.write("warn", "registration_access_blocked", "会员状态发生变化，开通会话未签发");
      const fresh = getSubmissionUserByEmail(options.database, email);
      if (fresh) await syncMemberEmbyAccess(options.database, options.emby, fresh.id);
      response.setHeader("set-cookie", options.publicSession.clearCookie());
      return void response.status(403).json({ error: finalAccessError });
    }
    response.setHeader("set-cookie", options.publicSession.issueCookie(email));
    const member = toMemberViewByEmail(options.database, email);
    log?.write("info", "registration_completed", "会员注册完成", { embyLinked: Boolean(emby) }, Date.now() - started);
    response.json({
      status: "activated",
      email,
      emailStatus,
      member,
      /**
       * 这次兑换用的卡（名称 / 到期时间口径）：开通成功页据此显示
       * "你是用哪张卡开通的、到什么时候为止"，与预检那一步给的是同一套字段。
       */
      card: redeemedCardView(options.database, card, member),
      emby: emby
        ? {
            embyUsername: emby.embyUsername,
            password: emby.password,
            serverAddress,
            onboardTitle: onboard?.title ?? "",
            onboardNotice: onboard?.notice ?? "",
          }
        : null,
    });
  });

  // 断开会话（保留登录态），供客户端退出
  app.post("/api/public/subscriptions/logout", (_request: Request, response: Response) => {
    response.setHeader("set-cookie", options.publicSession.clearCookie());
    response.json({ ok: true });
  });

  // 门户会话的会员摘要（原 /api/public/submissions/mine 的会员部分；投稿列表与额度台账随投稿删除）。
  app.get("/api/public/subscriptions/member", (request: Request, response: Response) => {
    const email = sessionEmail(request);
    if (!email) return void response.status(401).json({ error: "unauthorized" });
    const member = toMemberViewByEmail(options.database, email);
    if (!member) return void response.status(403).json({ error: "not_member" });
    response.json({ email: member.email, member });
  });

  app.get("/api/public/subscriptions/member/emby", async (request: Request, response: Response) => {
    const email = sessionEmail(request);
    if (!email) return void response.status(401).json({ error: "unauthorized" });
    const user = getSubmissionUserByEmail(options.database, email);
    response.json({ embyUserId: user?.embyUserId ?? null, embyUsername: user?.embyUsername ?? null });
  });

  app.post("/api/public/subscriptions/member/emby/password", async (request: Request, response: Response) => {
    const email = sessionEmail(request);
    if (!email) return void response.status(401).json({ error: "unauthorized" });
    const parsed = passwordSchema.safeParse(request.body);
    if (!parsed.success) return void response.status(400).json({ error: "invalid_request" });
    const user = getSubmissionUserByEmail(options.database, email);
    if (!user?.embyUserId) return void response.status(400).json({ error: "no_emby_account" });
    try {
      await createEmbyUserService(options.emby).setPassword(user.embyUserId, parsed.data.password);
      response.json({ ok: true });
    } catch (caught) {
      const status = (caught as { status?: number }).status ?? 502;
      response.status(status).json({ error: caught instanceof Error ? caught.message : "emby_request_failed" });
    }
  });

  /**
   * 自助解冻 · 第一步：点开弹窗。
   *
   * 只做两件事：确认"这个账号现在真的能自助解冻"，并把**申请时刻**落库——
   * 强制等待由服务端按这个时刻算（前端倒计时只是展示，改接口绕不过去）。
   * 同一轮冻结里重复调用不会重置时刻。
   */
  app.post("/api/public/subscriptions/member/unfreeze/ack", (request: Request, response: Response) => {
    const email = sessionEmail(request);
    if (!email) return void response.status(401).json({ error: "unauthorized" });
    const result = requestUnfreeze(options.database, email);
    if (!result.ok) {
      const status = result.error === "not_member" ? 403 : 400;
      return void response.status(status).json({ error: result.error });
    }
    response.json({ ok: true, unfreeze: result.view });
  });

  /**
   * 自助解冻 · 第二步：正式解冻。
   *
   * 服务端校验「本人 + 冻结中 + 本月还有次数 + 已等满等待秒数」，确认 Emby 账号恢复启用后
   * 才记次数、发「已解冻」邮件、写审计日志（member.self_unfreeze）。
   */
  app.post("/api/public/subscriptions/member/unfreeze", async (request: Request, response: Response) => {
    const email = sessionEmail(request);
    if (!email) return void response.status(401).json({ error: "unauthorized" });
    if (!unfreezeAttemptsPerMinute.check(`email:${email}`))
      return void response.status(429).json({ error: "rate_limited" });
    const result = await confirmUnfreeze(options.database, options.emby, options.email, email);
    if (!result.ok) {
      const status = result.error === "not_member" ? 403 : result.error === "release_failed" ? 502 : 400;
      return void response.status(status).json({
        error: result.error,
        retryAfterMs: result.retryAfterMs ?? null,
      });
    }
    options.logger?.info({
      event: "member_self_unfreeze",
      message: `${email} 在门户自助解冻成功（本月已用 ${result.usedThisMonth} 次，剩 ${result.remainingChances} 次）`,
    });
    response.json({ ok: true, member: toMemberViewByEmail(options.database, email) });
  });
}
