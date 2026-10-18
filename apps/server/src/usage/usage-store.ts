/**
 * 会员使用记录的存储层（表：member_usage_segments / member_usage_events）。
 *
 * 两张表的分工：
 *   - segments：**观察区间** —— "这段会话从几点到几点在用、在看什么"。采样器不断延长它，
 *     会话消失或换片就封口；时段统计（一天里哪几个钟头在用）完全靠它算。
 *   - events：**流水** —— 登录、开始播放、结束播放。既有采样器现场记的，也有 Emby
 *     活动日志回填的历史（靠 external_id 去重）。
 *
 * 为什么不用 Emby 的播放历史当唯一数据源：那台 Emby 的活动日志只留最近有限条数，
 * 而且不同版本字段名不一致；应用自己攒的这份账才是可控、可长期统计的。
 */
import { and, asc, desc, eq, gte, isNull, lt, sql } from "drizzle-orm";

import type { AppDatabase } from "@emby-task-center/database/client";
import { memberUsageEvents, memberUsageSegments, submissionUsers } from "@emby-task-center/database/schema";

export type UsageEventKind = "login" | "play_start" | "play_stop" | "session_end" | "other";
export type UsageEventSource = "sampler" | "activity_log";
export type UsageSegmentKind = "play" | "idle";

export type UsageSegmentRow = typeof memberUsageSegments.$inferSelect;
export type UsageEventRow = typeof memberUsageEvents.$inferSelect;

/** 一次采样里观察到的一个会话（已从 Emby 的原始结构里解析出来）。 */
export interface UsageObservation {
  sessionId: string;
  embyUserId: string | null;
  memberEmail: string | null;
  userName: string | null;
  kind: UsageSegmentKind;
  /** 播放对象（idle 时为空串）：同一次会话换片即开新的一段。 */
  itemId: string;
  itemTitle: string | null;
  episodeTitle: string | null;
  seasonNumber: number | null;
  episodeNumber: number | null;
  deviceId: string | null;
  deviceName: string | null;
  client: string | null;
  appVersion: string | null;
  remoteAddress: string | null;
  playMethod: string | null;
  positionTicks: number | null;
  runTimeTicks: number | null;
  mediaSourceName: string | null;
}

/** 会员身份索引：Emby UserId / 用户名 → 会员邮箱（Emby 用户名就是邮箱，两边都查）。 */
export interface MemberDirectory {
  byUserId: Map<string, string>;
  byName: Map<string, string>;
}

export function loadMemberDirectory(database: AppDatabase): MemberDirectory {
  const byUserId = new Map<string, string>();
  const byName = new Map<string, string>();
  for (const row of database
    .select({
      email: submissionUsers.email,
      embyUserId: submissionUsers.embyUserId,
      embyUsername: submissionUsers.embyUsername,
    })
    .from(submissionUsers)
    .all()) {
    if (row.embyUserId) byUserId.set(row.embyUserId, row.email);
    byName.set(row.email.toLowerCase(), row.email);
    if (row.embyUsername) byName.set(row.embyUsername.toLowerCase(), row.email);
  }
  return { byUserId, byName };
}

/** 用 Emby 的 UserId/UserName 反查会员邮箱；对不上（例如 Emby 管理员）返回 null。 */
export function resolveMemberEmail(
  directory: MemberDirectory,
  input: { embyUserId?: string | null; userName?: string | null },
): string | null {
  if (input.embyUserId) {
    const byId = directory.byUserId.get(input.embyUserId);
    if (byId) return byId;
  }
  const name = input.userName?.trim().toLowerCase();
  if (name) return directory.byName.get(name) ?? null;
  return null;
}

/** 找到某会话+状态+片源当前未封口的那一段。 */
export function findOpenSegment(
  database: AppDatabase,
  observation: Pick<UsageObservation, "sessionId" | "kind" | "itemId">,
): UsageSegmentRow | null {
  return (
    database
      .select()
      .from(memberUsageSegments)
      .where(
        and(
          eq(memberUsageSegments.sessionId, observation.sessionId),
          eq(memberUsageSegments.kind, observation.kind),
          eq(memberUsageSegments.itemId, observation.itemId),
          isNull(memberUsageSegments.endedAt),
        ),
      )
      .get() ?? null
  );
}

/** 这一次会话有没有被观察过（用来判断"新上线"）。 */
export function sessionSeenBefore(database: AppDatabase, sessionId: string): boolean {
  return Boolean(
    database
      .select({ id: memberUsageSegments.id })
      .from(memberUsageSegments)
      .where(eq(memberUsageSegments.sessionId, sessionId))
      .limit(1)
      .get(),
  );
}

/** 关掉某会话上除"仍在观察的那一段"之外的所有未封口区间，返回被关掉的行（用于补事件）。 */
export function closeOtherOpenSegments(
  database: AppDatabase,
  input: { sessionId: string; keepKind: UsageSegmentKind; keepItemId: string; at: string },
): UsageSegmentRow[] {
  const open = database
    .select()
    .from(memberUsageSegments)
    .where(and(eq(memberUsageSegments.sessionId, input.sessionId), isNull(memberUsageSegments.endedAt)))
    .all()
    .filter((row) => !(row.kind === input.keepKind && row.itemId === input.keepItemId));
  for (const row of open) {
    database.update(memberUsageSegments).set({ endedAt: input.at }).where(eq(memberUsageSegments.id, row.id)).run();
  }
  return open;
}

/**
 * 关掉"太久没被看到"的未封口区间。
 *
 * 封口时间取 last_seen_at 而不是 now：我们只能证明它到那一刻还在用，多算的时间是编的。
 * （服务重启、Emby 重启、客户端崩溃都会留下这种悬空区间。）
 */
export function closeStaleOpenSegments(
  database: AppDatabase,
  input: { now: Date; staleMs: number },
): UsageSegmentRow[] {
  const threshold = new Date(input.now.getTime() - input.staleMs).toISOString();
  const stale = database
    .select()
    .from(memberUsageSegments)
    .where(and(isNull(memberUsageSegments.endedAt), lt(memberUsageSegments.lastSeenAt, threshold)))
    .all();
  for (const row of stale) {
    database
      .update(memberUsageSegments)
      .set({ endedAt: row.lastSeenAt })
      .where(eq(memberUsageSegments.id, row.id))
      .run();
  }
  return stale;
}

export function openSegment(database: AppDatabase, observation: UsageObservation, at: string): UsageSegmentRow {
  return database
    .insert(memberUsageSegments)
    .values({
      sessionId: observation.sessionId,
      embyUserId: observation.embyUserId,
      memberEmail: observation.memberEmail,
      userName: observation.userName,
      kind: observation.kind,
      itemId: observation.itemId,
      itemTitle: observation.itemTitle,
      episodeTitle: observation.episodeTitle,
      seasonNumber: observation.seasonNumber,
      episodeNumber: observation.episodeNumber,
      deviceId: observation.deviceId,
      deviceName: observation.deviceName,
      client: observation.client,
      appVersion: observation.appVersion,
      remoteAddress: observation.remoteAddress,
      playMethod: observation.playMethod,
      positionTicks: observation.positionTicks,
      runTimeTicks: observation.runTimeTicks,
      mediaSourceName: observation.mediaSourceName,
      startedAt: at,
      lastSeenAt: at,
      endedAt: null,
    })
    .returning()
    .get();
}

/** 把一段已经打开的区间延长到"现在"，并刷新进度/身份等信息。 */
export function touchSegment(database: AppDatabase, id: number, observation: UsageObservation, at: string): void {
  database
    .update(memberUsageSegments)
    .set({
      lastSeenAt: at,
      positionTicks: observation.positionTicks,
      runTimeTicks: observation.runTimeTicks,
      playMethod: observation.playMethod,
      remoteAddress: observation.remoteAddress,
      deviceName: observation.deviceName,
      client: observation.client,
      appVersion: observation.appVersion,
      // 会员是后绑定的（先有 Emby 账号、后收编成会员）：补上邮箱，历史记录也能归到人。
      memberEmail: observation.memberEmail,
      embyUserId: observation.embyUserId,
      userName: observation.userName,
    })
    .where(eq(memberUsageSegments.id, id))
    .run();
}

export interface UsageEventInput {
  embyUserId?: string | null;
  memberEmail?: string | null;
  userName?: string | null;
  kind: UsageEventKind;
  source: UsageEventSource;
  externalId?: string | null;
  itemId?: string | null;
  itemTitle?: string | null;
  episodeTitle?: string | null;
  seasonNumber?: number | null;
  episodeNumber?: number | null;
  deviceId?: string | null;
  deviceName?: string | null;
  client?: string | null;
  appVersion?: string | null;
  remoteAddress?: string | null;
  positionTicks?: number | null;
  runTimeTicks?: number | null;
  detail?: string | null;
  occurredAt: string;
}

/**
 * 写一条使用事件；带 externalId 的（Emby 活动日志回填）靠唯一索引去重。
 * 返回是否真的插入了（回填时用它统计"新增了多少条"）。
 */
export function insertUsageEvent(database: AppDatabase, event: UsageEventInput): boolean {
  const createdAt = new Date().toISOString();
  if (event.externalId) {
    const exists = database
      .select({ id: memberUsageEvents.id })
      .from(memberUsageEvents)
      .where(and(eq(memberUsageEvents.source, event.source), eq(memberUsageEvents.externalId, event.externalId)))
      .limit(1)
      .get();
    if (exists) return false;
  }
  database
    .insert(memberUsageEvents)
    .values({
      embyUserId: event.embyUserId ?? null,
      memberEmail: event.memberEmail ?? null,
      userName: event.userName ?? null,
      kind: event.kind,
      source: event.source,
      externalId: event.externalId ?? null,
      itemId: event.itemId ?? null,
      itemTitle: event.itemTitle ?? null,
      episodeTitle: event.episodeTitle ?? null,
      seasonNumber: event.seasonNumber ?? null,
      episodeNumber: event.episodeNumber ?? null,
      deviceId: event.deviceId ?? null,
      deviceName: event.deviceName ?? null,
      client: event.client ?? null,
      appVersion: event.appVersion ?? null,
      remoteAddress: event.remoteAddress ?? null,
      positionTicks: event.positionTicks ?? null,
      runTimeTicks: event.runTimeTicks ?? null,
      detail: event.detail ?? null,
      occurredAt: event.occurredAt,
      createdAt,
    })
    .run();
  return true;
}

/** 按时间窗取区间（取与窗口有交集的：起点在窗口内，或起点更早但尚未封口/结束在窗口内）。 */
export function listSegmentsBetween(database: AppDatabase, from: string, to: string): UsageSegmentRow[] {
  return database
    .select()
    .from(memberUsageSegments)
    .where(
      and(
        lt(memberUsageSegments.startedAt, to),
        sql`COALESCE(${memberUsageSegments.endedAt}, ${memberUsageSegments.lastSeenAt}) >= ${from}`,
      ),
    )
    .orderBy(asc(memberUsageSegments.startedAt))
    .all();
}

export function listEventsBetween(
  database: AppDatabase,
  from: string,
  to: string,
  options: { memberEmail?: string | null; limit?: number } = {},
): UsageEventRow[] {
  const filters = [gte(memberUsageEvents.occurredAt, from), lt(memberUsageEvents.occurredAt, to)];
  if (options.memberEmail) filters.push(eq(memberUsageEvents.memberEmail, options.memberEmail));
  const rows = database
    .select()
    .from(memberUsageEvents)
    .where(and(...filters))
    .orderBy(desc(memberUsageEvents.occurredAt))
    .limit(options.limit ?? 5_000)
    .all();
  return rows;
}

/** 保留策略：删掉过期的事件与区间（区间按"封口时间/最后观察时间"老化）。 */
export function pruneUsageHistory(database: AppDatabase, input: { now: Date; retentionDays: number }): number {
  if (input.retentionDays <= 0) return 0;
  const cutoff = new Date(input.now.getTime() - input.retentionDays * 86_400_000).toISOString();
  const events = database.delete(memberUsageEvents).where(lt(memberUsageEvents.occurredAt, cutoff)).run().changes;
  const segments = database
    .delete(memberUsageSegments)
    .where(and(lt(memberUsageSegments.lastSeenAt, cutoff), sql`${memberUsageSegments.endedAt} IS NOT NULL`))
    .run().changes;
  return events + segments;
}
