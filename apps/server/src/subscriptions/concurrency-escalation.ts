import { embyAccessAllowed, syncMemberEmbyAccess } from "./emby-access";
import { eq } from "drizzle-orm";

import type { AppDatabase } from "@emby-task-center/database/client";
import { concurrencyEscalationState, submissionUsers } from "@emby-task-center/database/schema";
import type { EmbyClient } from "../integrations/emby-client";
import type { EmailNotifier } from "../notifications/email-service";
import { createEmbyUserService, type EmbyUserService } from "../integrations/emby-user-service";
import { getConcurrencyPolicy, type ConcurrencyPolicy } from "../integrations/concurrency-policy-config";
import { terminateMemberSessions } from "./stream-guard";
import { StreamLimitResolver } from "./stream-limits";
import { buildHtml } from "./send-notifications";

/**
 * 升级任务的检查周期：runtime 按它排程，累计也按它给**单次计入**封顶。
 * 为什么要封顶：进程停机/任务被关掉期间锚点不会更新，恢复后不能拿旧锚点
 * 把"超限几小时"一次性补记到会员头上（那会不经过提醒直接冻结）。
 */
export const ESCALATION_TICK_MS = 10_000;

export interface EscalationOutcome {
  /** 本次发出提醒邮件的会员邮箱。 */
  reminded: string[];
  /** 本次新冻结的会员邮箱。 */
  frozen: string[];
  /** 本次到期解冻的会员邮箱。 */
  released: string[];
  /** 冻结期间被强制断掉的会话数（Emby 不会自己拦，靠这里持续断）。 */
  terminated: number;
  /** 处置失败（停用/解冻没生效等）：由调用方写日志——失败绝不能静默。 */
  failures: Array<{ email: string; reason: string }>;
  /** 冻结期内发现停用位被外部改回启用、已重新写回的会员（自愈痕迹，值得留痕排查）。 */
  reasserted: string[];
}

/**
 * 并发超限升级（后台可配置）：**触发式累计** —— 累计超限时长到 X 分钟发提醒邮件，
 * 累计到 Y 分钟直接冻结账号 Z 小时。周期调用（每 10 秒）。
 *
 * **为什么是"累计"而不是"连续"**：看门狗每秒就把多出来的那一路掐掉，而这里每 10 秒才采样一次，
 * 采样时经常读到"已经回落限内"。若一回落就把计时清零，持续对抗的会员永远攒不到阈值——
 * 冻结形同虚设。所以改成：违规时按**相邻两次确认超限**的间隔累加，合规时只闭合当前这一档、
 * 累计值与"已提醒"标记都保留；只有冻结/解冻才归零。
 * 代价：一次性的短暂超限（换设备、客户端重连）最多只能贡献一个采样周期的累计，攒不到阈值，
 * 因此不会误伤——这也正是会员须知里"多次违规才临时封停"的口径。
 *
 * **只处理会员**（submission_users 且已绑定 Emby 账号）：登记过并发上限的用登记值，
 * 没登记的按「默认并发路数」；Emby 管理员一律不受影响（跳过）。
 *
 * **冻结是"真冻住"**：除了写 Emby 的策略位（IsDisabled），还要主动断掉该会员的全部会话、
 * 踢掉设备——这台 Emby 不因账号停用中断已登录设备的播放，只写策略位等于没冻。
 * 冻结期间每一轮都继续断流，直到到期自动恢复（或管理员在「会员与运营」里手动恢复）。
 *
 * **每一次停用/解冻都要回读确认**（{@link setDisabledAndConfirm}）：Emby 的策略写是整份覆盖，
 * 请求成功 ≠ 真的生效，而且后续任一次上限同步都可能把它冲回去。没确认就当失败——
 * 只发"已冻结"邮件但账号其实没冻，是最糟的结果。
 */
export async function enforceConcurrencyEscalation(
  database: AppDatabase,
  emby: EmbyClient | undefined,
  email: EmailNotifier | undefined,
  now = new Date(),
): Promise<EscalationOutcome> {
  const outcome: EscalationOutcome = {
    reminded: [],
    frozen: [],
    released: [],
    terminated: 0,
    failures: [],
    reasserted: [],
  };
  const policy = getConcurrencyPolicy(database);
  if (!policy.enabled) return outcome;
  if (!emby?.configured || !emby.listSessions) return outcome;

  const service = createEmbyUserService(emby);
  // 只处理**会员**：登记过上限的用登记值，没登记的按默认路数；管理员在下面逐个跳过。
  const members = database
    .select()
    .from(submissionUsers)
    .all()
    .filter((member) => member.embyUserId);
  if (!members.length) return outcome;

  // 上限口径与看门狗共用同一个解析器：管理员、以及「默认路数 = 0（不限）」都会得到 null。
  const resolver = new StreamLimitResolver(database, emby, policy.defaultStreamLimit);

  let sessions: Array<{ userId: string | null; isPlaying: boolean; isPaused: boolean }>;
  try {
    sessions = await service.listSessions();
  } catch {
    return outcome;
  }

  const remindMs = policy.remindAfterMinutes * 60_000;
  const disableMs = policy.disableAfterMinutes * 60_000;
  const disableForMs = policy.disableForHours * 3_600_000;
  const nowMs = now.getTime();

  for (const member of members) {
    const userId = member.embyUserId!;
    // 管理员不受影响：即便这个 Emby 账号被登记成了会员，也不进冻结流程。
    if (await resolver.isAdministrator(userId)) continue;
    // 上限：登记值 → 否则默认路数；null = 不限（管理员或默认路数为 0）→ 没有可执行的限制。
    const limit = await resolver.limitFor(userId);
    if (limit == null) continue;

    const count = sessions.filter(
      (session) => session.userId === userId && (session.isPlaying || session.isPaused),
    ).length;
    const state = database
      .select()
      .from(concurrencyEscalationState)
      .where(eq(concurrencyEscalationState.memberId, member.id))
      .get();
    const lastConfirmedAt = state?.overshootSince ? Date.parse(state.overshootSince) : null;
    const notifiedAt = state?.notifiedAt ? Date.parse(state.notifiedAt) : null;
    const disabledUntil = state?.disabledUntil ? Date.parse(state.disabledUntil) : null;

    if (disabledUntil != null && !Number.isNaN(disabledUntil)) {
      if (nowMs >= disabledUntil) {
        // 冻结到期：恢复账号。**恢复同样要确认**：状态清了但 Emby 还停用着，会员就再也进不来了。
        if (!(await syncMemberEmbyAccess(database, emby, member.id, true, now))) {
          outcome.failures.push({ email: member.email, reason: "解冻未确认（Emby 仍是停用），下一轮重试" });
          continue;
        }
        await resetState(database, member.id);
        outcome.released.push(member.email);
        continue;
      }
      // 冻结期内做两件事：
      //  ① 持续断流 —— Emby 不会自己拦住已登录设备，不断流冻结就不成立；
      //  ② 守住停用位 —— 期间任何一次策略写入（上限同步、管理员改设置）都可能把它冲回启用。
      const kept = await ensureStillDisabled(service, userId);
      if (kept === "healed") outcome.reasserted.push(member.email);
      if (kept === "failed") {
        outcome.failures.push({ email: member.email, reason: "冻结期内停用位失效，重写后仍未确认" });
      }
      const { sessions: ended, devices } = await terminateMemberSessions(emby, userId);
      outcome.terminated += ended + devices;
      continue;
    }

    // 触发式累计：违规时把「上一次确认超限」到现在这段计入累计；合规时只闭合这一档，累计不清零。
    const over = count > limit;
    let accruedMs = state?.overshootMs ?? 0;
    if (over && lastConfirmedAt != null && nowMs > lastConfirmedAt) {
      accruedMs += Math.min(nowMs - lastConfirmedAt, ESCALATION_TICK_MS);
    }
    const overshootSince = over ? now.toISOString() : null;

    if (accruedMs >= disableMs) {
      // 累计超限满阈值：冻结 = 停用 + 断掉全部会话 + 踢设备 + 发信。
      // 顺序很讲究：**先确认停用真的生效**，再发"已冻结"邮件、才记冻结状态。
      // 停用没生效就只断流、记一条失败、下一轮重试 —— 绝不发一封假的"已冻结"。
      const disabled = await setDisabledAndConfirm(service, userId, true);
      const { sessions: ended, devices } = await terminateMemberSessions(emby, userId);
      if (!disabled) {
        // 失败也要把进度落库：不然下一跳按「上一次落库的锚点」算，会被单次封顶削掉一截，
        // 累计反而往回退，阈值可能再也够不着（冻结就一直重试不上）。
        await upsertState(database, member.id, {
          overshootSince,
          overshootMs: accruedMs,
          notifiedAt: state?.notifiedAt ?? null,
          disabledUntil: null,
        });
        outcome.failures.push({ email: member.email, reason: "冻结失败：Emby 停用位未生效，已先断流" });
        continue;
      }
      await sendDisabledEmail(
        email,
        member,
        policy,
        { limit, streamCount: count, overshootMs: accruedMs },
        ended + devices,
        new Date(nowMs + disableForMs),
      );
      await upsertState(database, member.id, {
        overshootSince: null,
        overshootMs: 0,
        notifiedAt: null,
        disabledUntil: new Date(nowMs + disableForMs).toISOString(),
        // 新一轮冻结从零开始：上一轮留下的解冻申请时刻必须清掉，否则这次一点开就能立刻解冻。
        unfreezeRequestedAt: null,
      });
      outcome.frozen.push(member.email);
    } else if (remindMs > 0 && notifiedAt == null && accruedMs >= remindMs) {
      // 累计到提醒档：只发提醒（可设 0 关掉，直接等冻结档）。
      await sendRemindEmail(email, member, policy, { limit, streamCount: count, overshootMs: accruedMs });
      outcome.reminded.push(member.email);
      await upsertState(database, member.id, {
        overshootSince,
        overshootMs: accruedMs,
        notifiedAt: now.toISOString(),
        disabledUntil: null,
      });
    } else if (over || accruedMs > 0 || state) {
      // 注意 `state` 这一项不能省：段结束时累计可能正好是 0，但**旧锚点必须写回 null**，
      // 否则下次违规会拿一个陈旧锚点补记一大段（曾经会因此误冻合规会员）。
      await upsertState(database, member.id, {
        overshootSince,
        overshootMs: accruedMs,
        notifiedAt: state?.notifiedAt ?? null,
        disabledUntil: null,
      });
    }
  }

  return outcome;
}

async function upsertState(
  database: AppDatabase,
  memberId: number,
  data: {
    overshootSince: string | null;
    overshootMs: number;
    notifiedAt: string | null;
    disabledUntil: string | null;
    /** 自助解冻的申请时刻：**不传 = 保留现值**（累计/提醒那几档不该把它碰掉）。 */
    unfreezeRequestedAt?: string | null;
  },
): Promise<void> {
  const updatedAt = new Date().toISOString();
  const existing = database
    .select()
    .from(concurrencyEscalationState)
    .where(eq(concurrencyEscalationState.memberId, memberId))
    .get();
  if (existing) {
    database
      .update(concurrencyEscalationState)
      .set({
        overshootSince: data.overshootSince,
        overshootMs: data.overshootMs,
        notifiedAt: data.notifiedAt,
        disabledUntil: data.disabledUntil,
        ...(data.unfreezeRequestedAt === undefined ? {} : { unfreezeRequestedAt: data.unfreezeRequestedAt }),
        updatedAt,
      })
      .where(eq(concurrencyEscalationState.memberId, memberId))
      .run();
  } else {
    database
      .insert(concurrencyEscalationState)
      .values({
        memberId,
        overshootSince: data.overshootSince,
        overshootMs: data.overshootMs,
        notifiedAt: data.notifiedAt,
        disabledUntil: data.disabledUntil,
        unfreezeRequestedAt: data.unfreezeRequestedAt ?? null,
        updatedAt,
      })
      .run();
  }
}

/**
 * 写停用位并**回读确认**。
 *
 * 为什么不能"把请求发出去就当成功"：
 *  - Emby 的 `POST /Users/{Id}/Policy` 是**整份策略覆盖**：只发 `{IsDisabled:true}` 会把并发上限
 *    冲成默认值，只发 `{SimultaneousStreamLimit:N}` 又会把停用位冲回 false —— 冻结会被后续任何
 *    一次上限同步悄悄解除（"发了冻结邮件但账号还能用"就是这么来的）；
 *  - 所以这里既不省掉回读，也不假设写一定成功：返回 false 就让调用方按失败处理。
 *
 * 返回 true 表示"确认处于目标状态"（含账号已不在 Emby 的情况）。
 */
async function setDisabledAndConfirm(service: EmbyUserService, userId: string, disabled: boolean): Promise<boolean> {
  const before = await readDisabled(service, userId);
  if (before === "missing") return true; // 账号已不在 Emby：没有可停用/可恢复的对象
  if (before === disabled) return true; // 已经是目标状态，不必再写
  try {
    await service.setDisabled(userId, disabled);
  } catch {
    return false;
  }
  const after = await readDisabled(service, userId);
  return after === "missing" || after === disabled;
}

/**
 * 冻结期内守住停用位。
 *
 * 为什么需要自愈：Emby 的策略是整份覆盖，冻结期间任何一次别的写入（会员上限同步、管理员改设置、
 * 自动绑定账号）都可能把 IsDisabled 冲回 false —— 账号就"解冻"了，而冻结状态还在。
 * 每一轮都确认一次，被冲掉就立刻写回。
 *
 * 返回 "ok"（本来就是停用）/ "healed"（被改回启用、已重新停用）/ "failed"（重写后仍未确认）。
 */
async function ensureStillDisabled(service: EmbyUserService, userId: string): Promise<"ok" | "healed" | "failed"> {
  const before = await readDisabled(service, userId);
  if (before === true || before === "missing") return "ok";
  return (await setDisabledAndConfirm(service, userId, true)) ? "healed" : "failed";
}

/** 回读某账号的停用位：true/false；账号在 Emby 里不存在返回 "missing"；读不到返回 null。 */
async function readDisabled(service: EmbyUserService, userId: string): Promise<boolean | "missing" | null> {
  try {
    const users = await service.listUsers();
    const user = users.find((item) => item.id === userId);
    if (!user) return "missing";
    return user.isDisabled;
  } catch {
    return null;
  }
}

/** 归零：冻结到期/手动恢复/自助解冻时，把累计超限时长、已提醒标记与解冻申请时刻一起清掉。 */
async function resetState(database: AppDatabase, memberId: number): Promise<void> {
  await upsertState(database, memberId, {
    overshootSince: null,
    overshootMs: 0,
    notifiedAt: null,
    disabledUntil: null,
    unfreezeRequestedAt: null,
  });
}

/** 管理员解除并发冻结：会员仍须启用且未过期，Emby 恢复确认后才清理冻结状态。 */
export async function restoreConcurrencyUser(
  database: AppDatabase,
  emby: EmbyClient | undefined,
  member: { id: number; embyUserId: string | null; email: string },
): Promise<void> {
  const state = database
    .select()
    .from(concurrencyEscalationState)
    .where(eq(concurrencyEscalationState.memberId, member.id))
    .get();
  if (!embyAccessAllowed(database, member.id, true)) throw new Error("member_restore_blocked");
  if (!state) return;
  if (!(await syncMemberEmbyAccess(database, emby, member.id, true))) throw new Error("member_restore_failed");
  await resetState(database, member.id);
}

/**
 * 解冻一个会员（门户自助解冻走这条）：**先确认 Emby 账号真的重新启用**，再清升级状态。
 *
 * 管理员、自助与自动恢复都检查会员最新启用状态和有效期。
 * 未确认 Emby 恢复时保留冻结，不记录成功次数。
 *
 * 返回 true = 已确认恢复并清空状态；false = 没确认上，调用方必须按失败处理、不能记次数。
 */
export async function releaseFrozenMember(
  database: AppDatabase,
  emby: EmbyClient | undefined,
  member: { id: number; embyUserId: string | null; email: string },
): Promise<boolean> {
  if (!embyAccessAllowed(database, member.id, true)) return false;
  if (!(await syncMemberEmbyAccess(database, emby, member.id, true))) return false;
  await resetState(database, member.id);
  return true;
}

/** 触发处置时这一轮的超限快照：会员邮件与管理员邮件共用同一组数字。 */
interface OvershootSnapshot {
  /** 该会员当前允许的同时播放路数。 */
  limit: number;
  /** 触发时实际在播的设备数。 */
  streamCount: number;
  /** 已累计超限时长（毫秒）。 */
  overshootMs: number;
}

/** 上限的来源：管理员排查时最想知道"这个 1 路是谁定的"。 */
function limitSourceLabel(member: typeof submissionUsers.$inferSelect): string {
  return member.embyMaxStreams != null && member.embyMaxStreams > 0 ? "会员登记值" : "全局默认路数";
}

/** 超限时长：分钟（不足 1 分钟如实说，不四舍五入成 0）。 */
function formatDuration(ms: number): string {
  const minutes = ms / 60_000;
  if (minutes < 1) return "不足 1 分钟";
  return `${Math.round(minutes)} 分钟`;
}

/** 时刻：本地「月-日 时:分」（管理员看的是自己服务器的时区）。 */
function formatMoment(value: Date): string {
  return value.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * 给管理员的超限处置邮件。
 *
 * 为什么不再"抄送一封和会员一模一样的邮件"：管理员收到的若是会员口吻的信，
 * 根本不知道是谁触发的、超到什么程度、系统已经做了什么 —— 等于没有通知。
 * 这里把**是谁 + 什么情况 + 系统做了什么 + 现在能做什么**一次说清。
 * 没配管理员邮箱就整段跳过（不阻断会员那封）。
 */
async function sendAdminEscalationEmail(
  email: EmailNotifier | undefined,
  policy: ConcurrencyPolicy,
  member: typeof submissionUsers.$inferSelect,
  data: { subject: string; headline: string; over: OvershootSnapshot; extra: string[] },
): Promise<void> {
  const admin = policy.adminEmail?.trim();
  if (!email?.configured || !admin) return;
  try {
    const text = [
      data.headline,
      "",
      `・会员邮箱：${member.email}`,
      `・Emby 用户名：${member.embyUsername ?? member.email}`,
      `・Emby 用户 ID：${member.embyUserId ?? "（未绑定 Emby 账号）"}`,
      `・同时播放上限：${data.over.limit} 路（${limitSourceLabel(member)}）`,
      `・触发时同时播放：${data.over.streamCount} 路`,
      ...data.extra,
      "",
      "如需人工处理：后台「会员与运营」搜这个邮箱 → 一键恢复（会同时解除冻结并清零累计超限时长）。",
      "",
      `（处置口径可在后台「系统设置 → 并发超限升级」里调整；本邮件只发给管理员邮箱 ${admin}）`,
    ].join("\n");
    await email.sendNotification(admin, data.subject, text, buildHtml(data.subject, text));
  } catch {
    /* 管理员通知失败不影响会员邮件与处置本身 */
  }
}

/** 触发提醒时给会员的邮件；管理员另发一封**带会员信息**的（不再抄送同一封）。 */
async function sendRemindEmail(
  email: EmailNotifier | undefined,
  member: typeof submissionUsers.$inferSelect,
  policy: ConcurrencyPolicy,
  over: OvershootSnapshot,
): Promise<void> {
  if (!email?.configured) return;
  try {
    const text = [
      "尊敬的会员您好：",
      "",
      "我们留意到您的账号当前正在多个设备上同时播放，已超出同时播放上限。",
      "",
      `为了让每位会员都能顺畅观看：如果继续多路同时播放，系统将在超限满 ${policy.disableAfterMinutes} 分钟时冻结您的账号 ${policy.disableForHours} 小时（冻结会立即中断当前所有设备的播放，之后到期自动恢复）。`,
      "",
      "如果是误操作，只需把多余的播放设备关掉即可，无需任何处理。如有疑问，欢迎随时联系我。",
      "",
      "祝观影愉快！",
    ].join("\n");
    const subject = "账号并发播放提醒";
    await email.sendNotification(member.email, subject, text, buildHtml(subject, text));
  } catch {
    /* 邮件失败不阻断 */
  }
  await sendAdminEscalationEmail(email, policy, member, {
    subject: `[并发超限·提醒] ${member.email}（${over.streamCount}/${over.limit} 路同时播放）`,
    headline: "会员并发播放超出上限（系统自动发送）",
    over,
    extra: [
      `・已累计超限：${formatDuration(over.overshootMs)}（累计满 ${policy.disableAfterMinutes} 分钟将冻结账号 ${policy.disableForHours} 小时）`,
      "・本轮已给会员发送提醒邮件；同一轮超限不会重复提醒。",
    ],
  });
}

/** 冻结时给会员的邮件；管理员另发一封**带会员信息与处置结果**的（不再抄送同一封）。 */
async function sendDisabledEmail(
  email: EmailNotifier | undefined,
  member: typeof submissionUsers.$inferSelect,
  policy: ConcurrencyPolicy,
  over: OvershootSnapshot,
  terminated: number,
  disabledUntil: Date,
): Promise<void> {
  if (!email?.configured) return;
  try {
    const lines = [
      "尊敬的会员您好：",
      "",
      `由于您的账号持续多路同时播放、超过了系统上限，系统已冻结您的账号 ${policy.disableForHours} 小时。`,
      "",
      terminated > 0
        ? "冻结已同时中断当前正在播放的设备，到期后会自动恢复正常播放。"
        : "冻结期间账号无法登录与播放，到期后会自动恢复正常播放。",
    ];
    // 自助解冻入口：会员不必干等到期。开关、每月次数、等待秒数、平台地址都在
    // 「并发超限升级」面板里配——这一句只在真的能自助解冻时才出现，不给会员指一条走不通的路。
    if (policy.unfreezeEnabled && policy.unfreezeMonthlyLimit > 0) {
      lines.push(
        "",
        `如果你想现在就看：登录平台 → 「我的」→ 点「申请解冻」，阅读提示并等待 ${policy.unfreezeWaitSeconds} 秒后确认，账号会立即恢复播放。`,
        `自助解冻每月最多 ${policy.unfreezeMonthlyLimit} 次（等到期自动恢复不占次数）。`,
      );
      if (policy.portalUrl) lines.push(`平台地址：${policy.portalUrl}`);
    }
    lines.push(
      "",
      "如果之后还需要更高的同时播放上限，欢迎联系管理员为您开通。给您带来的不便，我们深表歉意。",
      "",
      "感谢您的理解与配合！",
    );
    const text = lines.join("\n");
    const subject = "账号已因超限冻结";
    await email.sendNotification(member.email, subject, text, buildHtml(subject, text));
  } catch {
    /* 邮件失败不阻断 */
  }
  await sendAdminEscalationEmail(email, policy, member, {
    subject: `[并发超限·已冻结] ${member.email}（${over.streamCount}/${over.limit} 路同时播放）`,
    headline: "会员账号已因并发超限被冻结（系统自动发送）",
    over,
    extra: [
      `・已累计超限：${formatDuration(over.overshootMs)}（冻结阈值 ${policy.disableAfterMinutes} 分钟）`,
      `・冻结时长：${policy.disableForHours} 小时，自动解冻时间：${formatMoment(disabledUntil)}`,
      `・已强制中断：${terminated} 项（断开会话 + 踢掉设备，Emby 不会因停用自动中断播放）`,
      policy.unfreezeEnabled && policy.unfreezeMonthlyLimit > 0
        ? `・会员可自助解冻：每月最多 ${policy.unfreezeMonthlyLimit} 次，需等待 ${policy.unfreezeWaitSeconds} 秒`
        : "・会员不可自助解冻：只能等到期自动恢复或管理员手动恢复",
      "・已给会员发送「账号已因超限冻结」通知。",
    ],
  });
}
