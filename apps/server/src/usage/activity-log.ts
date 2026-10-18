/**
 * Emby 活动日志回填：把 Emby 自己记的"谁登录了 / 谁开始播放了"捞进本地使用记录。
 *
 * 为什么需要它：采样器只能记录**装上之后**发生的事（而且服务没跑的时候是空档）。
 * Emby 的管理端活动日志里有历史登录/播放记录，回填一遍，界面上立刻就有内容可看，
 * 而不是"从今天开始才有数据"。日志条目有限（Emby 自己会截断），所以它只是补充，
 * 权威数据仍然是采样器攒的 segments。
 *
 * 兼容性做法：Emby 各版本的活动条目字段名/文案不一致（Type 可能是 VideoPlayback，
 * 也可能只有一句本地化文案），所以分类**先看 Type 再看文本**，认不出来的一律记成 other
 * 并把原文留在 detail 里 —— 宁可界面上多一行看不懂的原文，也不要静默丢事件。
 */
import { and, eq, inArray, isNotNull } from "drizzle-orm";

import type { AppDatabase } from "@emby-task-center/database/client";
import { libraryItems, memberUsageEvents } from "@emby-task-center/database/schema";

import { normalizeEmbyDate, type EmbyActivityEntry, type EmbyClient } from "../integrations/emby-client";
import { createDatabaseSingleFlight } from "../util/database-single-flight";
import {
  insertUsageEvent,
  loadMemberDirectory,
  resolveMemberEmail,
  type MemberDirectory,
  type UsageEventKind,
} from "./usage-store";

export interface ActivitySyncResult {
  /** Emby 返回的条目数。 */
  fetched: number;
  /** 真正新写入的事件数（重复回填不会重复计数）。 */
  inserted: number;
  /** 认不出来的条目数（记为 other）。 */
  unknown: number;
  /** 身份解析不出真实 Emby 用户的条目数（不写入）。 */
  unresolved: number;
  /** 被修回 GUID 的历史行数（早期版本把活动日志的内部数字 id 当成了 Emby UserId）。 */
  repaired: number;
  /** Emby 不支持该接口（或密钥无权限）时为 true。 */
  unsupported: boolean;
}

/** Emby 的公开用户 Id 是 32 位十六进制 GUID。 */
export function looksLikeEmbyUserId(value: string): boolean {
  return /^[0-9a-f]{32}$/i.test(value.trim());
}

type ResolvedUser = { id: string; name: string };

/**
 * 把活动日志里的 UserId 解析成真正的 Emby 用户。
 *
 * 为什么必须解析：Emby 活动日志给的是**内部数字 id**（线上实测：同一个账号在 /Sessions 里是
 * GUID `01234567…`，在活动日志里却是 `1`）。早期版本直接把它当 Emby UserId 存进使用记录，
 * 于是「会员使用情况」里冒出一个根本不存在的 `emby:1`。`/Users/{id}` 两种 id 都吃，用它翻译。
 * 一次同步内按原始 id 缓存（一轮只有个位数个用户，别为同一个人反复问 Emby）。
 */
async function resolveActivityUser(
  emby: EmbyClient | undefined,
  raw: string,
  cache: Map<string, ResolvedUser | null>,
): Promise<ResolvedUser | null> {
  if (cache.has(raw)) return cache.get(raw) ?? null;
  const resolved = emby?.getUser ? await emby.getUser(raw) : looksLikeEmbyUserId(raw) ? { id: raw, name: "" } : null;
  cache.set(raw, resolved);
  return resolved;
}

/**
 * 修历史：早期版本把活动日志里的**内部数字 id** 当成 Emby UserId 存了下来 —— 界面上就是那个
 * 不存在的 `emby:1`。这里用 `/Users/{id}` 把这类行翻译回 GUID，并补上用户名与会员邮箱。
 * 幂等：只处理"看起来不是 GUID"的行，修完之后再也匹配不到（解析不到用户的行原样保留，不静默删）。
 */
async function repairLegacyActivityIdentities(
  database: AppDatabase,
  emby: EmbyClient | undefined,
  directory: MemberDirectory,
  cache: Map<string, ResolvedUser | null>,
): Promise<number> {
  const legacy = database
    .selectDistinct({ embyUserId: memberUsageEvents.embyUserId })
    .from(memberUsageEvents)
    .where(and(eq(memberUsageEvents.source, "activity_log"), isNotNull(memberUsageEvents.embyUserId)))
    .all()
    .map((row) => row.embyUserId)
    .filter((id): id is string => typeof id === "string" && id.trim().length > 0 && !looksLikeEmbyUserId(id));
  let repaired = 0;
  for (const raw of legacy) {
    const user = await resolveActivityUser(emby, raw, cache);
    if (!user) continue;
    const updated = database
      .update(memberUsageEvents)
      .set({
        embyUserId: user.id,
        userName: user.name || null,
        memberEmail: resolveMemberEmail(directory, { embyUserId: user.id, userName: user.name }),
      })
      .where(and(eq(memberUsageEvents.source, "activity_log"), eq(memberUsageEvents.embyUserId, raw)))
      .run();
    repaired += Number(updated.changes ?? 0);
  }
  return repaired;
}

/** 活动条目 → 使用事件类型（导出以便单测各种 Emby 版本的写法）。 */
export function classifyActivityEntry(entry: EmbyActivityEntry): { kind: UsageEventKind; matched: boolean } {
  const type = (entry.Type ?? "").toLowerCase();
  const text = [entry.Name, entry.ShortOverview, entry.Overview]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();

  // 顺序要紧："stopped playing" 里也有 "playing"。
  if (/stopped playing|finished playing|playback stop|playback stopped/.test(text) || type.includes("playbackstopped"))
    return { kind: "play_stop", matched: true };
  if (/停止播放|结束播放|播放结束|已停止播放/.test(text)) return { kind: "play_stop", matched: true };

  if (type.includes("videoplayback") || type.includes("audioplayback")) return { kind: "play_start", matched: true };
  if (/started playing|start playback|began playing/.test(text)) return { kind: "play_start", matched: true };
  if (/开始播放|正在播放/.test(text)) return { kind: "play_start", matched: true };

  if (type.includes("sessionended")) return { kind: "session_end", matched: true };
  if (/logged out|signed out|session ended/.test(text)) return { kind: "session_end", matched: true };
  // 注意顺序：中文的"退出登录"里也含"登录"，登出必须先判。
  if (/退出登录|登出|断开连接|会话结束/.test(text)) return { kind: "session_end", matched: true };

  if (type.includes("authentication") || type.includes("sessionstarted")) return { kind: "login", matched: true };
  if (/logged in|signed in|has logged in|login success/.test(text)) return { kind: "login", matched: true };
  if (/登录|登入/.test(text)) return { kind: "login", matched: true };

  return { kind: "other", matched: false };
}

/** 库里已有的 Emby 条目 Id → 作品名（活动日志只有 ItemId，标题得本地补）。 */
export function loadActivityItemTitles(
  database: AppDatabase,
  entries: readonly EmbyActivityEntry[],
): Map<string, string> {
  const map = new Map<string, string>();
  const ids = [
    ...new Set(entries.map((entry) => entry.ItemId).filter((id): id is string => typeof id === "string" && !!id)),
  ];
  for (let offset = 0; offset < ids.length; offset += 500) {
    for (const row of database
      .select({ embyItemId: libraryItems.embyItemId, sourceTitle: libraryItems.sourceTitle })
      .from(libraryItems)
      .where(inArray(libraryItems.embyItemId, ids.slice(offset, offset + 500)))
      .all()) {
      if (row.embyItemId && row.sourceTitle) map.set(row.embyItemId, row.sourceTitle);
    }
  }
  return map;
}

export const syncEmbyActivityLog = createDatabaseSingleFlight(syncActivityRound);

async function syncActivityRound(
  database: AppDatabase,
  emby: EmbyClient | undefined,
  options: { limit?: number; now?: Date } = {},
): Promise<ActivitySyncResult> {
  const result: ActivitySyncResult = {
    fetched: 0,
    inserted: 0,
    unknown: 0,
    unresolved: 0,
    repaired: 0,
    unsupported: false,
  };
  if (!emby?.configured || !emby.listActivityLog) {
    result.unsupported = true;
    return result;
  }
  const entries = await emby.listActivityLog({ startIndex: 0, limit: options.limit ?? 100 });
  result.fetched = entries.length;

  const now = options.now ?? new Date();
  const directory = loadMemberDirectory(database);
  const titles = loadActivityItemTitles(database, entries);
  const userCache = new Map<string, ResolvedUser | null>();

  // 先把历史遗留的"内部数字 id"行修回 GUID（幂等）。放在"没有新条目就返回"之前：
  // Emby 的日志可能一条新记录都没有，但库里那些 emby:1 依然需要被修掉。
  result.repaired = await repairLegacyActivityIdentities(database, emby, directory, userCache);

  if (!entries.length) return result;

  for (const entry of entries) {
    const rawUserId = typeof entry.UserId === "string" && entry.UserId ? entry.UserId : null;
    // 没有用户的活动（扫描、插件安装之类）不属于"会员使用记录"。
    if (!rawUserId) continue;
    const user = await resolveActivityUser(emby, rawUserId, userCache);
    if (!user) {
      // 解析不出真实用户就不要写：写进去只会变成界面上一个不存在的账号（曾经的 emby:1）。
      result.unresolved += 1;
      continue;
    }
    const { kind, matched } = classifyActivityEntry(entry);
    if (!matched) result.unknown += 1;
    const detail =
      [entry.ShortOverview, entry.Overview, entry.Name]
        .find((value): value is string => typeof value === "string" && value.trim().length > 0)
        ?.slice(0, 500) ?? null;
    const itemId = typeof entry.ItemId === "string" && entry.ItemId ? entry.ItemId : null;
    const inserted = insertUsageEvent(database, {
      embyUserId: user.id,
      memberEmail: resolveMemberEmail(directory, { embyUserId: user.id, userName: user.name }),
      userName: user.name || null,
      kind,
      source: "activity_log",
      externalId: entry.Id != null ? String(entry.Id) : null,
      itemId,
      itemTitle: itemId ? (titles.get(itemId) ?? null) : null,
      detail,
      occurredAt: normalizeEmbyDate(entry.Date) ?? now.toISOString(),
    });
    if (inserted) result.inserted += 1;
  }
  return result;
}
