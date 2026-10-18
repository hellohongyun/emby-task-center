/**
 * 使用记录的聚合（时段热力图、每会员汇总、单会员时间线）。
 *
 * 时段统计为什么在 JS 里算而不是写 SQL：'一天里的第几个钟头'是**本地时区**概念，
 * SQLite 的 strftime 只能按 UTC 或固定偏移算，夏令时/跨时区一改就错位。
 * 区间数量本身不大（一次观看一段，保留期内通常几千条），逐段切小时是又准又简单的做法。
 */
import type { AppDatabase } from "@emby-task-center/database/client";
import { submissionUsers } from "@emby-task-center/database/schema";

import { listEventsBetween, listSegmentsBetween, type UsageEventRow, type UsageSegmentRow } from "./usage-store";

/** 单次查询最多处理多少段区间（防止异常数据把接口拖死；正常量级远小于它）。 */
const SEGMENT_SCAN_LIMIT = 50_000;

export interface UsageRange {
  /** 窗口天数（含今天）。 */
  days: number;
  from: string;
  to: string;
}

export interface UsageDailyPoint {
  /** 本地日期 YYYY-MM-DD。 */
  date: string;
  /** 在播分钟数。 */
  playMinutes: number;
  /** 挂在客户端上（没在播）的分钟数。 */
  idleMinutes: number;
  logins: number;
  plays: number;
}

export interface UsageItemStat {
  title: string;
  episodeTitle: string | null;
  plays: number;
  minutes: number;
  lastAt: string;
}

export interface UsageMemberSummary {
  /** 稳定标识：会员用邮箱，未绑定会员的 Emby 账号用 emby:<userId>。 */
  key: string;
  email: string | null;
  embyUserId: string | null;
  userName: string | null;
  /** 窗口内最后一次登录（事件时间）。 */
  lastLoginAt: string | null;
  lastPlayAt: string | null;
  loginCount: number;
  plays: number;
  /** 在播时长（分钟）。 */
  playMinutes: number;
  /** 挂着客户端的总时长（分钟）。 */
  idleMinutes: number;
  /** 窗口内有使用的天数。 */
  activeDays: number;
  /** 24 个时段的在播分钟数（本地时区，索引=小时）。 */
  hourly: number[];
  daily: UsageDailyPoint[];
  topItems: UsageItemStat[];
}

export interface UsageOverview {
  range: UsageRange;
  generatedAt: string;
  totals: {
    /** 窗口内有任何使用记录的会员数。 */
    activeMembers: number;
    /** 统计范围内的会员总数（含完全没有使用的）。 */
    knownMembers: number;
    logins: number;
    plays: number;
    playHours: number;
    /** 使用过的不同设备数。 */
    devices: number;
  };
  /** 全站时段分布（24 格，分钟）。 */
  hourly: number[];
  members: UsageMemberSummary[];
}

export interface UsageMemberDetail {
  member: UsageMemberSummary;
  events: Array<{
    id: number;
    kind: string;
    source: string;
    occurredAt: string;
    itemTitle: string | null;
    episodeTitle: string | null;
    seasonNumber: number | null;
    episodeNumber: number | null;
    deviceName: string | null;
    client: string | null;
    appVersion: string | null;
    remoteAddress: string | null;
    positionTicks: number | null;
    runTimeTicks: number | null;
    detail: string | null;
  }>;
  /** 日期 × 24 小时的在播分钟数（按时间升序，用于画热力图）。 */
  heatmap: Array<{ date: string; hours: number[] }>;
  recentItems: UsageItemStat[];
}

function emptyHours(): number[] {
  return Array.from({ length: 24 }, () => 0);
}

/** 本地日期键（YYYY-MM-DD）。 */
export function localDateKey(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function usageRange(days: number, now = new Date()): UsageRange {
  const safeDays = Math.max(1, Math.min(365, Math.floor(days)));
  const start = new Date(now.getTime() - (safeDays - 1) * 86_400_000);
  start.setHours(0, 0, 0, 0);
  const end = new Date(now.getTime());
  return { days: safeDays, from: start.toISOString(), to: end.toISOString() };
}

interface Bucket {
  playMinutes: number;
  idleMinutes: number;
  hourly: number[];
  daily: Map<string, UsageDailyPoint>;
  items: Map<string, UsageItemStat>;
  firstAt: number;
  devices: Set<string>;
}

function newBucket(): Bucket {
  return {
    playMinutes: 0,
    idleMinutes: 0,
    hourly: emptyHours(),
    daily: new Map(),
    items: new Map(),
    firstAt: Number.POSITIVE_INFINITY,
    devices: new Set(),
  };
}

function dailyPoint(bucket: Bucket, key: string): UsageDailyPoint {
  const existing = bucket.daily.get(key);
  if (existing) return existing;
  const created: UsageDailyPoint = { date: key, playMinutes: 0, idleMinutes: 0, logins: 0, plays: 0 };
  bucket.daily.set(key, created);
  return created;
}

/** 把一段区间切成"本地小时"的切片，累加进各桶。只统计与窗口相交的部分。 */
export function accumulateSegment(
  bucket: Bucket,
  segment: UsageSegmentRow,
  window: { fromMs: number; toMs: number },
): void {
  const startedMs = Date.parse(segment.startedAt);
  const endedMs = Date.parse(segment.endedAt ?? segment.lastSeenAt);
  if (!Number.isFinite(startedMs) || !Number.isFinite(endedMs)) return;
  let cursor = Math.max(startedMs, window.fromMs);
  const end = Math.min(endedMs, window.toMs);
  if (!(end > cursor)) return;

  bucket.firstAt = Math.min(bucket.firstAt, startedMs);
  if (segment.deviceId) bucket.devices.add(segment.deviceId);

  while (cursor < end) {
    const current = new Date(cursor);
    // 下一个整点（本地时间；用 setMinutes 让夏令时切换也交给 Date 处理）。
    const nextHour = new Date(current);
    nextHour.setMinutes(60, 0, 0);
    const sliceEnd = Math.min(end, nextHour.getTime());
    const minutes = (sliceEnd - cursor) / 60_000;
    const hour = current.getHours();
    const dayKey = localDateKey(current);
    const day = dailyPoint(bucket, dayKey);

    if (segment.kind === "play") {
      bucket.playMinutes += minutes;
      bucket.hourly[hour] += minutes;
      day.playMinutes += minutes;
    } else {
      bucket.idleMinutes += minutes;
      day.idleMinutes += minutes;
    }
    cursor = sliceEnd > cursor ? sliceEnd : cursor + 60_000;
  }

  if (segment.kind === "play") {
    // 每次"开始看一个片"算一次播放（与事件表里的 play_start 同源，但区间更可靠：
    // 采样开始时就在播的历史区间不会有 play_start 事件）。
    dailyPoint(bucket, localDateKey(new Date(startedMs))).plays += 1;
    const itemKey = segment.itemId || `title:${segment.itemTitle ?? "未知"}`;
    const stat = bucket.items.get(itemKey) ?? {
      title: segment.itemTitle ?? "未知内容",
      episodeTitle: segment.episodeTitle ?? null,
      plays: 0,
      minutes: 0,
      lastAt: segment.startedAt,
    };
    stat.plays += 1;
    stat.minutes += Math.max(0, (end - Math.max(startedMs, window.fromMs)) / 60_000);
    if (segment.startedAt > stat.lastAt) stat.lastAt = segment.startedAt;
    bucket.items.set(itemKey, stat);
  }
}

function bucketKey(segment: {
  memberEmail: string | null;
  embyUserId: string | null;
  userName: string | null;
}): string {
  if (segment.memberEmail) return `email:${segment.memberEmail}`;
  if (segment.embyUserId) return `emby:${segment.embyUserId}`;
  return `name:${segment.userName ?? "unknown"}`;
}

/**
 * 这一行有没有"身份"：会员邮箱、Emby UserId、或至少一个用户名。
 *
 * 三者都没有的行不进「会员使用情况」：它们是**我们自己后台客户端的连接**（媒体任务中心 / TgtoDrive，
 * 没有 UserId）和未登录的匿名会话，既不是会员在用，也没有名字可显示 —— 早期它们会以
 * `name:unknown` 甚至 `emby:1` 这种形式出现在列表里，还会把设备数与时长算大。
 */
function hasIdentity(identity: { email: string | null; embyUserId: string | null; userName: string | null }): boolean {
  return Boolean(identity.email || identity.embyUserId || identity.userName);
}

function toSummary(input: {
  key: string;
  email: string | null;
  embyUserId: string | null;
  userName: string | null;
  bucket: Bucket | null;
  events: UsageEventRow[];
}): UsageMemberSummary {
  const bucket = input.bucket ?? newBucket();
  const logins = input.events.filter((event) => event.kind === "login");
  const playEvents = input.events.filter((event) => event.kind === "play_stop" || event.kind === "play_start");
  const lastLoginAt = logins.reduce<string | null>(
    (latest, event) => (latest == null || event.occurredAt > latest ? event.occurredAt : latest),
    null,
  );
  const lastPlayAt = playEvents.reduce<string | null>(
    (latest, event) => (latest == null || event.occurredAt > latest ? event.occurredAt : latest),
    null,
  );
  for (const event of logins) {
    dailyPoint(bucket, localDateKey(new Date(event.occurredAt))).logins += 1;
  }

  const daily = [...bucket.daily.values()].sort((left, right) => (left.date < right.date ? 1 : -1));
  return {
    key: input.key,
    email: input.email,
    embyUserId: input.embyUserId,
    userName: input.userName,
    lastLoginAt,
    lastPlayAt,
    loginCount: logins.length,
    plays: [...bucket.items.values()].reduce((total, item) => total + item.plays, 0),
    playMinutes: Math.round(bucket.playMinutes),
    idleMinutes: Math.round(bucket.idleMinutes),
    activeDays: daily.filter((day) => day.playMinutes > 0 || day.idleMinutes > 0 || day.plays > 0).length,
    hourly: bucket.hourly.map((minutes) => Math.round(minutes)),
    daily,
    topItems: [...bucket.items.values()].sort((left, right) => right.minutes - left.minutes).slice(0, 8),
  };
}

export function listUsageOverview(database: AppDatabase, input: { days: number; now?: Date }): UsageOverview {
  const now = input.now ?? new Date();
  const range = usageRange(input.days, now);
  const fromMs = Date.parse(range.from);
  const toMs = Date.parse(range.to);

  const segments = listSegmentsBetween(database, range.from, range.to).slice(-SEGMENT_SCAN_LIMIT);
  const events = listEventsBetween(database, range.from, range.to);

  const buckets = new Map<string, Bucket>();
  const identities = new Map<string, { email: string | null; embyUserId: string | null; userName: string | null }>();
  for (const segment of segments) {
    const key = bucketKey(segment);
    const bucket = buckets.get(key) ?? newBucket();
    accumulateSegment(bucket, segment, { fromMs, toMs });
    buckets.set(key, bucket);
    const identity = identities.get(key) ?? { email: null, embyUserId: null, userName: null };
    identities.set(key, {
      email: identity.email ?? segment.memberEmail,
      embyUserId: identity.embyUserId ?? segment.embyUserId,
      userName: identity.userName ?? segment.userName,
    });
  }

  const eventsByKey = new Map<string, UsageEventRow[]>();
  for (const event of events) {
    const key = bucketKey(event);
    const list = eventsByKey.get(key) ?? [];
    list.push(event);
    eventsByKey.set(key, list);
    const identity = identities.get(key) ?? { email: null, embyUserId: null, userName: null };
    identities.set(key, {
      email: identity.email ?? event.memberEmail,
      embyUserId: identity.embyUserId ?? event.embyUserId,
      userName: identity.userName ?? event.userName,
    });
  }

  const members = new Map<string, UsageMemberSummary>();
  const build = (key: string): UsageMemberSummary => {
    const identity = identities.get(key) ?? { email: null, embyUserId: null, userName: null };
    return toSummary({
      key,
      email: identity.email,
      embyUserId: identity.embyUserId,
      userName: identity.userName,
      bucket: buckets.get(key) ?? null,
      events: eventsByKey.get(key) ?? [],
    });
  };
  // 没有身份的行不进「会员使用情况」（见 hasIdentity 注释）：设备数、时长、播放次数都按同一份口径算。
  const identifiedKeys = [...new Set([...buckets.keys(), ...eventsByKey.keys()])].filter((key) =>
    hasIdentity(identities.get(key) ?? { email: null, embyUserId: null, userName: null }),
  );
  for (const key of identifiedKeys) members.set(key, build(key));

  // 会员表里的人即使窗口内没有任何使用，也要出现在列表里（显示 0 才好判断"谁没用"）。
  const registry = database.select().from(submissionUsers).all();
  for (const row of registry) {
    const key = `email:${row.email}`;
    if (members.has(key)) continue;
    members.set(
      key,
      toSummary({
        key,
        email: row.email,
        embyUserId: row.embyUserId ?? null,
        userName: row.embyUsername ?? row.email,
        bucket: null,
        events: [],
      }),
    );
  }

  const hourly = emptyHours();
  const devices = new Set<string>();
  for (const key of identifiedKeys) {
    const bucket = buckets.get(key);
    if (!bucket) continue;
    bucket.hourly.forEach((minutes, hour) => {
      hourly[hour] += minutes;
    });
    for (const device of bucket.devices) devices.add(device);
  }

  const list = [...members.values()].sort((left, right) => {
    if (right.playMinutes !== left.playMinutes) return right.playMinutes - left.playMinutes;
    return (right.lastPlayAt ?? "") < (left.lastPlayAt ?? "") ? -1 : 1;
  });

  const identifiedBuckets = identifiedKeys.flatMap((key) => (buckets.get(key) ? [buckets.get(key)!] : []));
  const logins = events.filter((event) => event.kind === "login").length;
  const plays = identifiedBuckets.reduce(
    (total, bucket) => total + [...bucket.items.values()].reduce((sum, item) => sum + item.plays, 0),
    0,
  );
  const playMinutes = identifiedBuckets.reduce((total, bucket) => total + bucket.playMinutes, 0);

  return {
    range,
    generatedAt: now.toISOString(),
    totals: {
      activeMembers: list.filter((member) => member.playMinutes > 0 || member.idleMinutes > 0 || member.loginCount > 0)
        .length,
      knownMembers: registry.length,
      logins,
      plays,
      playHours: Math.round((playMinutes / 60) * 10) / 10,
      devices: devices.size,
    },
    hourly: hourly.map((minutes) => Math.round(minutes)),
    members: list,
  };
}

export function getUsageMemberDetail(
  database: AppDatabase,
  input: { days: number; key: string; now?: Date },
): UsageMemberDetail | null {
  const overview = listUsageOverview(database, { days: input.days, now: input.now });
  const member = overview.members.find((candidate) => candidate.key === input.key) ?? null;
  if (!member) return null;

  const fromMs = Date.parse(overview.range.from);
  const toMs = Date.parse(overview.range.to);
  const segments = listSegmentsBetween(database, overview.range.from, overview.range.to).filter(
    (segment) => bucketKey(segment) === input.key,
  );
  const events = listEventsBetween(database, overview.range.from, overview.range.to, {
    memberEmail: member.email,
    limit: 500,
  }).filter((event) => bucketKey(event) === input.key);

  // 日期 × 小时矩阵：热力图直接用它画。
  const heatmap = new Map<string, number[]>();
  for (const segment of segments) {
    const cursorStart = Math.max(Date.parse(segment.startedAt), fromMs);
    const end = Math.min(Date.parse(segment.endedAt ?? segment.lastSeenAt), toMs);
    if (!(end > cursorStart) || segment.kind !== "play") continue;
    let cursor = cursorStart;
    while (cursor < end) {
      const current = new Date(cursor);
      const nextHour = new Date(current);
      nextHour.setMinutes(60, 0, 0);
      const sliceEnd = Math.min(end, nextHour.getTime());
      const key = localDateKey(current);
      const hours = heatmap.get(key) ?? emptyHours();
      hours[current.getHours()] += (sliceEnd - cursor) / 60_000;
      heatmap.set(key, hours);
      cursor = sliceEnd > cursor ? sliceEnd : cursor + 60_000;
    }
  }

  const recentItems = [...member.topItems].sort((left, right) => (left.lastAt < right.lastAt ? 1 : -1));

  return {
    member,
    events: events.slice(0, 200).map((event) => ({
      id: event.id,
      kind: event.kind,
      source: event.source,
      occurredAt: event.occurredAt,
      itemTitle: event.itemTitle,
      episodeTitle: event.episodeTitle,
      seasonNumber: event.seasonNumber,
      episodeNumber: event.episodeNumber,
      deviceName: event.deviceName,
      client: event.client,
      appVersion: event.appVersion,
      remoteAddress: event.remoteAddress,
      positionTicks: event.positionTicks,
      runTimeTicks: event.runTimeTicks,
      detail: event.detail,
    })),
    heatmap: [...heatmap.entries()]
      .sort((left, right) => (left[0] < right[0] ? -1 : 1))
      .map(([date, hours]) => ({ date, hours: hours.map((minutes) => Math.round(minutes)) })),
    recentItems,
  };
}
