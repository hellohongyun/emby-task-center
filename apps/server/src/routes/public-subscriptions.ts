import { memberAccessError } from "../subscriptions/member-access";
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
import { inspectCard, redeemCard, resolveMembershipExpiry } from "../subscriptions/cards";
import { bindPendingCard, clearPendingCard, readPendingCard } from "../subscriptions/pending-cards";
import { issueVerificationCode, verifyVerificationCode } from "../subscriptions/verification";
import { getSubmissionUserByEmail, memberConcurrencyStatus, memberStatus } from "../subscriptions/membership";
import { confirmUnfreeze, memberUnfreezeView, requestUnfreeze } from "../subscriptions/self-unfreeze";
import { provisionEmbyAccount } from "../subscriptions/emby-account";
import { createEmbyUserService } from "../integrations/emby-user-service";
import { createRateLimiter } from "../subscriptions/rate-limit";
import { buildHtml } from "../subscriptions/send-notifications";
import { buildEmbyOnboardNotice, buildEmbyWelcomeEmail } from "../subscriptions/member-notices";
import { embyServerAddress } from "../integrations/emby-address";
import { readSetting } from "../settings/store";

/**
 * 发码请求：`cardCode` 是**注册资格**凭证——没注册过的邮箱必填，注册过的（含已过期）可省略。
 *
 * 卡密闸门放在服务端而不是只靠前端禁用按钮：直接打接口同样能触发发信，前端 gate 挡不住。
 */
const codeSchema = z.strictObject({
  email: z.string().trim().email().max(254),
  cardCode: z.string().trim().min(4).max(64).optional(),
});
/** 登录页「下一步」的分流判断：只给邮箱。 */
const entrySchema = z.strictObject({ email: z.string().trim().email().max(254) });
/** 卡密预检：cardCode 可省略（注册过的邮箱不需要卡密），提供时一定真的去验这张卡。 */
const cardCheckSchema = z.strictObject({
  email: z.string().trim().email().max(254),
  cardCode: z.string().trim().min(4).max(64).optional(),
});
const loginSchema = z.strictObject({ email: z.string().trim().email().max(254), code: z.string().trim().length(6) });
const activateSchema = z.strictObject({
  email: z.string().trim().email().max(254),
  code: z.string().trim().length(6),
  cardCode: z.string().trim().min(4).max(64),
});
const passwordSchema = z.strictObject({ password: z.string().trim().min(6).max(200) });
const codePerMinute = createRateLimiter(5, 60_000);
const codePerHourEmail = createRateLimiter(10, 3_600_000);
/** 分流判断单独限流：它没有副作用，但会回答"这个邮箱注册过没有"，别让人拿脚本批量问。 */
const entryPerMinute = createRateLimiter(10, 60_000);
/** 卡密预检单独限流：给「卡密看不清、重试几次」留余量，同时挡住拿脚本枚举卡密的人。 */
const cardCheckPerMinute = createRateLimiter(10, 60_000);
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
    membershipExpiryLabel: user.membershipExpiryLabel ?? null,
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

export function registerPublicSubscriptionRoutes(app: Express, options: PublicSubscriptionOptions): void {
  function sessionEmail(request: Request): string | null {
    const { email } = options.publicSession.read(request.headers.cookie);
    return email && !memberAccessError(options.database, email) ? email : null;
  }

  /**
   * 登录页分流用的判定。
   *
   * 只认一件事：**这个邮箱注册过没有**（库里还有没有这条会员记录）。过期也算注册过——
   * 他照样要能正常登录，续费去「我的 → 续费 / 兑换卡密」，而不是被挡在门外逼着买卡。
   * 所以「需要卡密」= 从没注册过 = 走注册页。
   */
  function membershipGate(email: string, now = new Date()) {
    const user = getSubmissionUserByEmail(options.database, email);
    const status = user ? memberStatus(user, now) : "none";
    return {
      user,
      status,
      registered: Boolean(user),
      isMember: status === "active" || status === "expiring",
      expired: status === "expired",
    };
  }

  /**
   * 登录页「下一步」：问服务端这个邮箱该走登录还是走注册（卡密）。
   *
   * 零副作用——不发信、不签发验证码、不动卡密；但它的回答本身会暴露"某邮箱是否注册过"，
   * 所以单独限流（宁可多给自家用户几次重试，也不让人拿它批量扫）。
   */
  app.post("/api/public/subscriptions/entry", (request: Request, response: Response) => {
    const parsed = entrySchema.safeParse(request.body);
    if (!parsed.success) return void response.status(400).json({ error: "invalid_request" });
    const email = parsed.data.email.toLowerCase().trim();
    if (!entryPerMinute.check(`ip:${request.ip ?? "unknown"}`))
      return void response.status(429).json({ error: "rate_limited" });
    const gate = membershipGate(email);
    if (gate.user && !gate.user.enabled) return void response.status(403).json({ error: "member_disabled" });
    response.json({ registered: gate.registered, needsCard: !gate.registered, expired: gate.expired });
  });

  /**
   * 卡密预检：只校验、**不消耗**。
   *
   * 注册页用它实现「先验证卡密 → 通过后『发送验证码』才可点」；`/code` 里服务端会再验一次，
   * 所以绕过前端直接打发码接口同样过不去。
   */
  app.post("/api/public/subscriptions/card/check", (request: Request, response: Response) => {
    const parsed = cardCheckSchema.safeParse(request.body);
    if (!parsed.success) return void response.status(400).json({ error: "invalid_request" });
    const email = parsed.data.email.toLowerCase().trim();
    if (!cardCheckPerMinute.check(`ip:${request.ip ?? "unknown"}`))
      return void response.status(429).json({ error: "rate_limited" });
    const gate = membershipGate(email);
    if (gate.user && !gate.user.enabled) return void response.status(403).json({ error: "member_disabled" });
    const cardCode = parsed.data.cardCode?.trim();
    // 没给卡密：只有注册过的邮箱能过（对它来说卡密本来就不是必需品）
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
    // 给了卡密就真的去验：续费场景（已注册、但要兑换一张新卡）也靠这条路径拿到卡类型与天数
    const inspection = inspectCard(options.database, cardCode, email);
    if (!inspection.ok) return void response.status(400).json({ error: inspection.reason });
    response.json({
      ok: true,
      registered: gate.registered,
      needsCard: !gate.registered,
      expired: gate.expired,
      card: {
        kind: inspection.kind,
        label: inspection.label,
        days: inspection.days,
        idempotent: inspection.idempotent,
        /** 管理员 DIY 的卡密名称（没起名字时回落类型标签）。 */
        name: inspection.name,
        /** 固定到期日（ISO）与它的 DIY 名称；两者都为 null 表示"兑换后 N 天"的相对卡。 */
        expiresAt: inspection.expiresAt,
        expiryLabel: inspection.expiryLabel,
        /** 到期时间的主文案（名称优先）与真实日期小字：页面直接照抄，不自己拼。 */
        expiryText: inspection.expiryText,
        expiryDetail: inspection.expiryDetail,
        /** 距到期还剩几天（相对卡为 null）。 */
        expiryDays: inspection.expiryDays,
        /** 彩蛋祝福文案：前端据此决定要不要弹窗（为空就是不弹，不拿通用话术糊弄）。 */
        blessing: inspection.blessing,
      },
    });
  });

  app.post("/api/public/subscriptions/code", async (request: Request, response: Response) => {
    const parsed = codeSchema.safeParse(request.body);
    if (!parsed.success) return void response.status(400).json({ error: "invalid_request" });
    const email = parsed.data.email.toLowerCase().trim();
    if (!codePerMinute.check(`ip:${request.ip ?? "unknown"}`))
      return void response.status(429).json({ error: "rate_limited" });
    if (!codePerHourEmail.check(`email:${email}`))
      return void response.status(429).json({ error: "rate_limited_email" });
    const gate = membershipGate(email);
    if (gate.user && !gate.user.enabled) return void response.status(403).json({ error: "member_disabled" });
    // 卡密闸门：**没注册过**的邮箱不给卡密就既不签发验证码、也不发邮件（本次改造的核心承诺）。
    // 注册过的（含已过期）直接放行——他要能登录，续费在「我的」页做。
    const needsCard = !gate.registered;
    let cardCode: string | null = null;
    if (needsCard) {
      cardCode = parsed.data.cardCode?.trim() ?? "";
      if (!cardCode) return void response.status(400).json({ error: "card_required" });
      const inspection = inspectCard(options.database, cardCode, email);
      if (!inspection.ok) return void response.status(400).json({ error: inspection.reason });
    }
    try {
      const code = issueVerificationCode(options.database, email);
      // 记下「这封码是用哪张卡换来的」：开通时必须提交同一张卡，闸门才不会被另一张卡绕过。
      if (cardCode) bindPendingCard(email, cardCode);
      else clearPendingCard(email);
      const text = gate.registered
        ? `你的「天鸿影院」登录验证码：${code}（10 分钟内有效）。如非本人操作请忽略。`
        : `你的「天鸿影院」邮箱验证码：${code}（10 分钟内有效）。输入验证码即可开通会员。`;
      const subject = "[天鸿影院] 邮箱验证码";
      await options.email?.sendNotification(email, subject, text, buildHtml(subject, text));
      response.json({ sent: true, registered: gate.registered, needsCard, expired: gate.expired });
    } catch (caught) {
      // 发信失败要撤掉绑定，免得留下一张「码没发出去、卡密却已绑定」的尴尬状态
      clearPendingCard(email);
      response.status(502).json({ error: "email_send_failed" });
    }
  });

  app.post("/api/public/subscriptions/login", async (request: Request, response: Response) => {
    const parsed = loginSchema.safeParse(request.body);
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
    const parsed = activateSchema.safeParse(request.body);
    if (!parsed.success) return void response.status(400).json({ error: "invalid_request" });
    const email = parsed.data.email.toLowerCase().trim();
    // 卡密一致性：发码时校验过的那张卡，必须就是现在核销的这张。
    // 放在验证码校验**之前**——不一致不该顺手把用户的验证码消费掉。
    const boundCard = readPendingCard(email);
    if (boundCard && boundCard !== parsed.data.cardCode.trim().toUpperCase()) {
      return void response.status(400).json({ error: "card_mismatch" });
    }
    if (getSubmissionUserByEmail(options.database, email)?.enabled === false)
      return void response.status(403).json({ error: "member_disabled" });
    const verification = verifyVerificationCode(options.database, email, parsed.data.code);
    if (!verification.ok) {
      return void response
        .status(verification.reason === "too_many_attempts" ? 429 : 401)
        .json({ error: verification.reason === "too_many_attempts" ? "too_many_attempts" : "invalid_code" });
    }
    // 兑换卡密（幂等：同一邮箱重复用同卡不重复计费；他人已用过的卡直接拒绝；过期卡拒绝）
    let card: ReturnType<typeof redeemCard>;
    try {
      card = redeemCard(options.database, parsed.data.cardCode, email);
    } catch (caught) {
      const reason = (caught as { message?: string }).message ?? "";
      const known = ["invalid_card", "card_used", "card_expired"];
      return void response.status(400).json({ error: known.includes(reason) ? reason : "invalid_card" });
    }
    // 卡密已核销，绑定使命完成
    clearPendingCard(email);
    const now = new Date();
    const timestamp = now.toISOString();
    const existing = getSubmissionUserByEmail(options.database, email);
    // 幂等重试只返回当前结果：旧卡不能重新启用已停用/过期账号、清掉提醒或再次触发 Emby 开户。
    // 会员已被删除时也不能凭已消费的卡重新创建；长期会员的 null 到期时间同样必须原样保留。
    if (card.idempotent) {
      if (!existing) return void response.status(403).json({ error: "not_member" });
      response.setHeader("set-cookie", options.publicSession.issueCookie(email));
      return void response.json({
        status: "activated",
        email,
        member: toMemberView(options.database, existing),
        card: {
          code: card.code,
          kind: card.kind,
          name: card.name,
          expiresAt: card.expiresAt,
          expiryLabel: card.expiryLabel,
          idempotent: true,
        },
        emby: null,
      });
    }
    // 新用户：创建会员；老用户：从当前到期时间续期
    const base =
      existing?.subscriptionExpiresAt && Date.parse(existing.subscriptionExpiresAt) > now.getTime()
        ? Date.parse(existing.subscriptionExpiresAt)
        : now.getTime();
    // 两条有效期口径的分流点（固定到期日 / base+days）唯一收在 cards.resolveMembershipExpiry。
    const newExpiry = resolveMembershipExpiry(card, base);
    /**
     * 用户侧到期口径：带「到期时间名称」的卡把名称记到会员行上，用户侧所有页面与提醒邮件
     * 优先显示它。不带名称的卡**显式清空**——换了卡就是换了口径，旧名称不能粘在新的到期时间上。
     * 幂等兑换已在上面返回，不动这一列。
     */
    const expiryLabel = card.expiryLabel ?? null;

    if (existing) {
      options.database
        .update(submissionUsers)
        .set({
          subscriptionExpiresAt: newExpiry,
          membershipExpiryLabel: expiryLabel,
          membershipReminderState: null,
          membershipRemindedAt: null,
          updatedAt: timestamp,
        })
        .where(eq(submissionUsers.id, existing.id))
        .run();
    } else {
      // 新注册会员**默认登记并发上限**（不再是"留空跟随全局默认"）：刚入门的会员多设备同时播放
      // 最容易触发冻结，先按后台配的默认值登记下来，Emby 侧同时设 SimultaneousStreamLimit。
      // 登记值后台可改（系统设置 →「会员」→ 新注册会员默认并发上限），开通后也能在「会员与运营」单独调。
      options.database
        .insert(submissionUsers)
        .values({
          email,
          subscriptionExpiresAt: newExpiry,
          membershipExpiryLabel: expiryLabel,
          enabled: true,
          embyMaxStreams: readSetting(options.database, "member.newMemberMaxStreams"),
          note: `卡密开通(${card.kind})`,
          createdAt: timestamp,
          updatedAt: timestamp,
        } as never)
        .returning()
        .get();
    }
    // 自动创建/关联 Emby 账号
    let emby: { embyUserId: string; embyUsername: string; password: string } | null = null;
    if (options.emby?.configured) {
      try {
        emby = await provisionEmbyAccount(options.database, options.emby, email);
      } catch {
        /* Emby 开户失败不阻断会员开通 */
      }
    }
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
      await options.email.sendNotification(email, subject, text, buildHtml(subject, text)).catch(() => undefined);
    }
    const finalAccessError = memberAccessError(options.database, email);
    if (finalAccessError) {
      const fresh = getSubmissionUserByEmail(options.database, email);
      if (fresh) await syncMemberEmbyAccess(options.database, options.emby, fresh.id);
      response.setHeader("set-cookie", options.publicSession.clearCookie());
      return void response.status(403).json({ error: finalAccessError });
    }
    response.setHeader("set-cookie", options.publicSession.issueCookie(email));
    response.json({
      status: "activated",
      email,
      member: toMemberViewByEmail(options.database, email),
      /**
       * 这次兑换用的卡（名称 / 到期时间口径）：开通成功页据此显示
       * "你是用哪张卡开通的、到什么时候为止"，与预检那一步给的是同一套字段。
       */
      card: {
        code: card.code,
        kind: card.kind,
        name: card.name,
        expiresAt: card.expiresAt,
        expiryLabel: card.expiryLabel,
        idempotent: card.idempotent,
      },
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
