import { desc, eq, inArray } from "drizzle-orm";
import { randomBytes } from "node:crypto";

import type { AppDatabase } from "@emby-task-center/database/client";
import { cardKeys } from "@emby-task-center/database/schema";

export type CardKind = "trial" | "month" | "year" | "custom";
export type CardRow = typeof cardKeys.$inferSelect;

export const CARD_DAYS: Record<CardKind, number> = {
  trial: 10,
  month: 30,
  year: 365,
  custom: 0, // 自定义卡：按固定到期日或管理员给的天数
};

export const CARD_KIND_LABEL: Record<CardKind, string> = {
  trial: "试用卡",
  month: "月卡",
  year: "年卡",
  custom: "自定义",
};

const MS_PER_DAY = 86_400_000;

/**
 * 把日历选中的日期归一到该日 **23:59:59.999**（本地时区）。
 *
 * 为什么不是 00:00：管理员写"10 月 8 日到期"，用户理解是"8 号这天还能看"。
 * 归到当日零点等于 7 号夜里就失效，差一天会被当成 bug 报上来。
 *
 * 非法日期（2027-02-31 这种会被 JS 顺延成 3 月）必须拒绝，不能悄悄变成别的日子。
 */
export function normalizeExpiryDate(value: string): string | null {
  const text = value.trim();
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  if (!match) {
    const parsed = Date.parse(text);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const local = new Date(year, month - 1, day, 23, 59, 59, 999);
  const drifted = local.getFullYear() !== year || local.getMonth() !== month - 1 || local.getDate() !== day;
  return drifted ? null : local.toISOString();
}

/** 到期日的展示格式（YYYY-MM-DD，本地时区）。 */
export function formatExpiryDate(value: string | null): string {
  if (!value) return "长期有效";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  const pad = (count: number) => String(count).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 生成日 → 到期日 的天数（至少 1 天；只用于列表展示与老链路兜底）。 */
export function daysUntil(value: string, now = new Date()): number {
  const target = Date.parse(value);
  if (!Number.isFinite(target)) return 1;
  return Math.max(1, Math.round((target - now.getTime()) / MS_PER_DAY));
}

/**
 * 卡密的展示名：管理员起的名字优先，没起就回落类型标签。
 *
 * 约定：用户侧读到的任何"卡密叫什么"都必须走这里，避免出现空白或内部枚举值。
 */
export function cardDisplayName(card: { name: string | null; kind: string }): string {
  const name = card.name?.trim();
  return name && name.length > 0 ? name : cardKindLabel(card.kind);
}

/**
 * 到期时间的两段式展示：**名称优先**，真实日期作为次要信息。
 *
 * 口径来自用户决策（docs/card-keys.md）：
 * 用自定义卡密开通的会员，用户侧所有页面与提醒邮件都以 `expiryLabel` 为主口径，
 * 不直接甩一个日期；后端把名称与日期两段都给出去，由前端决定小字怎么排。
 *
 * 三种卡各自的说法：
 *  - 固定到期日 + 有名称 → `2027 年春节结束到期`（小字 `2027-02-20`）
 *  - 固定到期日 + 没名称 → `2027-02-20`
 *  - 相对天数卡（月/年/试用卡与所有老卡）→ `兑换后 30 天`：兑换前根本不存在确定日期，
 *    硬编一个日期才是撒谎。老卡要是被写上名称（现在是允许的），名称优先。
 */
export function expiryDisplay(
  card: { expiryLabel: string | null; expiresAt: string | null; days: number },
  now = new Date(),
): { text: string; detail: string | null; days: number | null } {
  const label = card.expiryLabel?.trim() || null;
  if (card.expiresAt) {
    const target = Date.parse(card.expiresAt);
    const left = Number.isFinite(target) ? Math.max(0, Math.ceil((target - now.getTime()) / MS_PER_DAY)) : null;
    return {
      text: label ?? formatExpiryDate(card.expiresAt),
      detail: formatExpiryDate(card.expiresAt),
      days: left,
    };
  }
  return { text: label ?? `兑换后 ${card.days} 天`, detail: null, days: null };
}

function encodeCode(): string {
  // 12 位大写字母/数字，去掉易混淆字符
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(12);
  let code = "";
  for (let i = 0; i < 12; i++) code += alphabet[bytes[i]! % alphabet.length];
  return code;
}

export interface CreateCardInput {
  kind: CardKind;
  count: number;
  /** 老链路（相对天数）用；`custom` 且没给 expiresAt 时必填。 */
  days?: number;
  /** 卡密名称（管理员 DIY）。 */
  name?: string | null;
  /** 固定到期日（YYYY-MM-DD 或 ISO）；给了就走"固定到期日"语义。 */
  expiresAt?: string | null;
  /** 到期时间名称（管理员 DIY），仅在固定到期日卡上有意义。 */
  expiryLabel?: string | null;
  /** 彩蛋祝福文案。 */
  blessing?: string | null;
}

function cleanText(value: string | null | undefined, max: number): string | null {
  const text = value?.trim();
  if (!text) return null;
  return text.slice(0, max);
}

/**
 * 创建卡密。
 *
 * 两条有效期口径（详见 docs/card-keys.md）：
 *  - 给了 `expiresAt` → 固定到期日卡：用户**统一到期于该日期**；`days` 存派生天数仅供展示。
 *  - 没给 → 沿用历史语义 `base + days`（月/年/试用卡与所有老卡走这条）。
 */
export function createCardKeys(database: AppDatabase, input: CreateCardInput): string[] {
  const count = Math.max(1, Math.min(200, Math.floor(input.count)));
  const now = new Date();
  const normalizedExpiry = input.expiresAt ? normalizeExpiryDate(input.expiresAt) : null;
  if (input.expiresAt && !normalizedExpiry) throw new Error("invalid_expires_at");

  let days: number;
  let expiresAt: string | null = null;
  let expiryLabel: string | null = null;
  if (normalizedExpiry) {
    expiresAt = normalizedExpiry;
    days = daysUntil(normalizedExpiry, now);
    expiryLabel = cleanText(input.expiryLabel, 60);
  } else {
    // 注意：这里**不能**用 Math.max(1, ...) 兜底。旧写法 `Math.max(1, Math.floor(input.days ?? 0))`
    // 让下面的 invalid_days 永远不可能触发——custom 卡不填天数时会静默生成一张「1 天卡」，
    // 管理员要到用户兑换后才发现。缺参数就该当场拒绝。
    const raw = input.kind === "custom" ? input.days : CARD_DAYS[input.kind];
    days = Math.floor(raw ?? 0);
    if (!Number.isFinite(days) || days <= 0) throw new Error("invalid_days");
  }

  const name = cleanText(input.name, 40);
  const blessing = cleanText(input.blessing, 200);
  const timestamp = now.toISOString();
  const codes: string[] = [];
  let attempts = 0;
  while (codes.length < count && attempts < count * 20) {
    const code = encodeCode();
    attempts++;
    const exists = database.select({ id: cardKeys.id }).from(cardKeys).where(eq(cardKeys.code, code)).get();
    if (exists) continue;
    codes.push(code);
    database
      .insert(cardKeys)
      .values({
        code,
        kind: input.kind,
        days,
        name,
        expiresAt,
        expiryLabel,
        blessing,
        status: "unused",
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .run();
  }
  return codes;
}

export function listCardKeys(database: AppDatabase): CardRow[] {
  return database.select().from(cardKeys).orderBy(desc(cardKeys.id)).all();
}

export interface UpdateCardInput {
  ids: number[];
  name?: string | null;
  expiryLabel?: string | null;
  blessing?: string | null;
}

/**
 * 批量改卡的"文案类"字段（名称 / 到期时间名称 / 彩蛋文案）。
 *
 * 存在的理由：批量生成 10 张后，甲方常常只想给其中一张换个名字或改一句话，
 * 为了改一句话重新生成一批会把已发出去的卡打乱。到期时间与天数故意不在这里改——
 * 改了会让"已经按旧到期日卖出去的卡"语义漂移，那是另一件事。
 */
export function updateCardKeys(database: AppDatabase, input: UpdateCardInput): number {
  const ids = input.ids.filter((id) => Number.isInteger(id) && id > 0);
  if (!ids.length) return 0;
  const patch: Partial<typeof cardKeys.$inferInsert> = { updatedAt: new Date().toISOString() };
  if (input.name !== undefined) patch.name = cleanText(input.name, 40);
  if (input.expiryLabel !== undefined) patch.expiryLabel = cleanText(input.expiryLabel, 60);
  if (input.blessing !== undefined) patch.blessing = cleanText(input.blessing, 200);
  return database.update(cardKeys).set(patch).where(inArray(cardKeys.id, ids)).run().changes;
}

/** idempotent = true 表示同一邮箱重复提交同一张卡（调用方不能再叠加时长）。 */
export type RedeemResult = {
  code: string;
  kind: CardKind;
  days: number;
  idempotent: boolean;
  name: string | null;
  expiresAt: string | null;
  expiryLabel: string | null;
};

/**
 * 卡密预检结果：ok=true 时带上卡密本身的信息（名称/类型/有效期/是否幂等），ok=false 时给出拒绝原因。
 *
 * `code` 是归一化（去空格 + 转大写）后的卡密，调用方可以直接沿用。
 */
export type CardInspection =
  | {
      ok: true;
      cardId: number;
      code: string;
      kind: CardKind;
      days: number;
      label: string;
      name: string;
      idempotent: boolean;
      expiresAt: string | null;
      expiryLabel: string | null;
      blessing: string | null;
      expiryText: string;
      expiryDetail: string | null;
      /** 距到期还剩几天（固定到期日卡才有）；为 0 表示今天最后一天。 */
      expiryDays: number | null;
    }
  | { ok: false; reason: "invalid_card" | "card_used" | "card_expired" };

/**
 * 只读预检卡密：**不改变卡密状态**。
 *
 * 用途是「发验证码之前先验证卡密是否正确」——发邮件是会被刷的外部副作用，必须先用它把关；
 * 真正的核销仍然只在开通那一步由 redeemCard 完成。两条路径共用这一处判定，避免出现
 * 「预检说能用、核销时又拒绝」的规则漂移。
 *
 * 语义与 redeemCard 完全一致：同一邮箱重复提交自己用过的卡 → 幂等放行；被别人用过 → 拒绝；
 * **固定到期日已过 → card_expired 拒绝**（否则用户消耗一张卡却换到 0 天，纯属事故）。
 */
export function inspectCard(database: AppDatabase, code: string, email: string, now = new Date()): CardInspection {
  const normalized = code.trim().toUpperCase();
  const card = database.select().from(cardKeys).where(eq(cardKeys.code, normalized)).get();
  if (!card) return { ok: false, reason: "invalid_card" };
  const normalizedEmail = email.toLowerCase().trim();
  const display = expiryDisplay(card, now);
  const hit = {
    cardId: card.id,
    code: card.code,
    kind: card.kind as CardKind,
    days: card.days,
    label: cardKindLabel(card.kind),
    name: cardDisplayName(card),
    expiresAt: card.expiresAt ?? null,
    expiryLabel: card.expiryLabel ?? null,
    blessing: card.blessing ?? null,
    expiryText: display.text,
    expiryDetail: display.detail,
    expiryDays: display.days,
  };
  if (card.status === "used") {
    if (card.usedByEmail && card.usedByEmail.toLowerCase().trim() === normalizedEmail) {
      return { ok: true, ...hit, idempotent: true };
    }
    return { ok: false, reason: "card_used" };
  }
  // 固定到期日已过：这张卡已经把价值耗光了，不能再让下一个人白兑换一次。
  if (card.expiresAt && Date.parse(card.expiresAt) <= now.getTime()) {
    return { ok: false, reason: "card_expired" };
  }
  return { ok: true, ...hit, idempotent: false };
}

/**
 * 兑换卡密：标记为 used 并返回有效期信息。
 *
 * 三条必须守住的语义：
 *  ① 同一邮箱重复提交同一张卡 → 幂等：返回 idempotent=true，调用方据此**不再叠加时长**
 *     （否则重复点「确认续费」会白送一份天数）。
 *  ② 已被**别人**使用过的卡 → 直接拒绝 card_used：一张卡不能被两个账号各兑换一次。
 *  ③ 固定到期日已过的卡 → card_expired（同上，不能让用户白烧一张卡）。
 *
 * 判定本身复用 inspectCard，本函数只负责「把卡标成已用」这一步写入。
 */
export function redeemCard(database: AppDatabase, code: string, email: string, now = new Date()): RedeemResult {
  const inspection = inspectCard(database, code, email, now);
  if (!inspection.ok) throw Object.assign(new Error(inspection.reason), { status: 400 });
  if (inspection.idempotent) {
    return {
      code: inspection.code,
      kind: inspection.kind,
      days: inspection.days,
      idempotent: true,
      name: inspection.name,
      expiresAt: inspection.expiresAt,
      expiryLabel: inspection.expiryLabel,
    };
  }
  const timestamp = now.toISOString();
  database
    .update(cardKeys)
    .set({
      status: "used",
      usedByEmail: email.toLowerCase().trim(),
      usedAt: timestamp,
      updatedAt: timestamp,
    })
    .where(eq(cardKeys.id, inspection.cardId))
    .run();
  return {
    code: inspection.code,
    kind: inspection.kind,
    days: inspection.days,
    idempotent: false,
    name: inspection.name,
    expiresAt: inspection.expiresAt,
    expiryLabel: inspection.expiryLabel,
  };
}

/**
 * 算出兑换后的会员到期时间。**两条口径在这里分流，是全仓唯一一处**。
 *
 *  - 固定到期日卡（expiresAt 有值）：到那个日期为止；已是会员且原到期更晚 → 保持原到期
 *    （绝不让"续费"把会员期变短）。
 *  - 老卡（expiresAt 为空）：`base + days`，历史语义一行不改。
 */
export function resolveMembershipExpiry(card: { days: number; expiresAt: string | null }, base: number): string {
  if (card.expiresAt) {
    const target = Date.parse(card.expiresAt);
    if (Number.isFinite(target)) return new Date(Math.max(base, target)).toISOString();
  }
  return new Date(base + card.days * MS_PER_DAY).toISOString();
}

/** 统计：未使用/已使用数量。 */
export function cardKeyStats(database: AppDatabase): { total: number; unused: number; used: number } {
  const rows = database.select({ status: cardKeys.status }).from(cardKeys).all();
  const total = rows.length;
  const unused = rows.filter((row) => row.status === "unused").length;
  return { total, unused, used: total - unused };
}

export function deleteCardKeys(database: AppDatabase, ids: number[]): number {
  if (!ids.length) return 0;
  return database.delete(cardKeys).where(inArray(cardKeys.id, ids)).run().changes;
}

export function cardStatusLabel(status: string): string {
  return { unused: "未使用", used: "已使用", copied: "已复制" }[status] ?? status;
}

export function cardKindLabel(kind: string): string {
  return CARD_KIND_LABEL[kind as CardKind] ?? kind;
}
