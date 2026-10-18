/**
 * 会话采样器：把 Emby 的"此刻谁在播什么"攒成可统计的使用记录。
 *
 * 已知的取舍（都是刻意的）：
 *  - **只记看到的**：采样间隔内发生的事（点开又秒退的播放）会漏；封口时间取 last_seen_at，
 *    所以统计出的时长永远是下限而不是估算值。
 *  - **丢失即结束**：会话从 Emby 消失后要连续两个周期没见到才封口，避免 Emby/网络抖一下
 *    就把一次观看切成好几段。
 *  - **登录 = 新会话**：Emby 没有"登录"事件流（活动日志只留最近若干条），所以把"第一次
 *    看到某个会话 Id"记成登录（客户端接入）。换设备、重装客户端都会产生新会话 Id。
 */
import type { AppDatabase } from "@emby-task-center/database/client";

import type { EmbySession } from "../integrations/emby-client";
import { describePlayback } from "../integrations/emby-playback";
import {
  closeOtherOpenSegments,
  closeStaleOpenSegments,
  findOpenSegment,
  insertUsageEvent,
  loadMemberDirectory,
  openSegment,
  resolveMemberEmail,
  sessionSeenBefore,
  touchSegment,
  type UsageObservation,
  type UsageSegmentRow,
} from "./usage-store";

/** 采样周期（毫秒）。默认 30 秒：手机端播放一次通常几十分钟，30 秒粒度足够算时段。 */
export const DEFAULT_SAMPLE_INTERVAL_MS = 30_000;
/** 连续两个周期没见到才算结束（容忍抖动）。 */
export function staleThresholdMs(intervalMs: number): number {
  return Math.max(intervalMs * 2, 60_000);
}

export interface SampleResult {
  /** 本轮观察到、且能对上人的会话数。 */
  observed: number;
  /** 新开的区间数。 */
  opened: number;
  /** 延长（仍在用）的区间数。 */
  extended: number;
  /** 封口的区间数（会话消失/换片）。 */
  closed: number;
  /** 写入的事件数。 */
  events: number;
}

/** Emby 会话 → 采样观察值（解析播放详情、挂上会员邮箱）。 */
export function toObservation(
  session: EmbySession,
  directory: ReturnType<typeof loadMemberDirectory>,
): UsageObservation | null {
  const sessionId = session.Id;
  if (!sessionId) return null;
  // 没有绑定任何 Emby 用户的会话（我们自己后台的「媒体任务中心 / TgtoDrive」连接、未登录的匿名客户端）
  // 不属于「会员使用记录」：记下来只会在列表里多出一行说不出是谁的记录，还会把时长与设备数算大。
  if (!session.UserId) return null;
  const playback = describePlayback(session);
  const item = playback.item;
  return {
    sessionId,
    embyUserId: session.UserId ?? null,
    memberEmail: resolveMemberEmail(directory, { embyUserId: session.UserId, userName: session.UserName }),
    userName: session.UserName ?? null,
    kind: item ? "play" : "idle",
    itemId: item?.id ?? "",
    itemTitle: item ? item.title : null,
    episodeTitle: item?.episodeTitle ?? null,
    seasonNumber: item?.seasonNumber ?? null,
    episodeNumber: item?.episodeNumber ?? null,
    deviceId: session.DeviceId ?? null,
    deviceName: session.DeviceName ?? null,
    client: session.Client ?? null,
    appVersion: session.ApplicationVersion ?? null,
    remoteAddress: session.RemoteEndPoint ?? null,
    playMethod: playback.playMethod,
    positionTicks: session.PlayState?.PositionTicks ?? null,
    runTimeTicks: session.NowPlayingItem?.RunTimeTicks ?? null,
    mediaSourceName: playback.mediaSourceName,
  };
}

/** 一段区间封口时补一条事件：在播 → play_stop（附看到哪儿了），挂着 → session_end。 */
function recordCloseEvent(database: AppDatabase, segment: UsageSegmentRow, at: string): boolean {
  if (segment.kind === "idle") {
    return insertUsageEvent(database, {
      embyUserId: segment.embyUserId,
      memberEmail: segment.memberEmail,
      userName: segment.userName,
      kind: "session_end",
      source: "sampler",
      deviceId: segment.deviceId,
      deviceName: segment.deviceName,
      client: segment.client,
      appVersion: segment.appVersion,
      remoteAddress: segment.remoteAddress,
      occurredAt: at,
    });
  }
  return insertUsageEvent(database, {
    embyUserId: segment.embyUserId,
    memberEmail: segment.memberEmail,
    userName: segment.userName,
    kind: "play_stop",
    source: "sampler",
    itemId: segment.itemId || null,
    itemTitle: segment.itemTitle,
    episodeTitle: segment.episodeTitle,
    seasonNumber: segment.seasonNumber,
    episodeNumber: segment.episodeNumber,
    deviceId: segment.deviceId,
    deviceName: segment.deviceName,
    client: segment.client,
    appVersion: segment.appVersion,
    remoteAddress: segment.remoteAddress,
    positionTicks: segment.positionTicks,
    runTimeTicks: segment.runTimeTicks,
    occurredAt: at,
  });
}

/**
 * 采样一次：延长仍在用的区间、封口已经结束的区间、按需补登录/开播事件。
 *
 * 纯函数式的"输入 = 会话快照 + 现在时间"，因此可以在单测里直接喂假的会话序列
 * 造出"登录 → 开播 → 换片 → 结束"的完整时间线。
 */
export function sampleMemberSessions(
  database: AppDatabase,
  sessions: EmbySession[],
  now: Date = new Date(),
  options: { intervalMs?: number } = {},
): SampleResult {
  const intervalMs = options.intervalMs ?? DEFAULT_SAMPLE_INTERVAL_MS;
  const at = now.toISOString();
  const directory = loadMemberDirectory(database);
  const result: SampleResult = { observed: 0, opened: 0, extended: 0, closed: 0, events: 0 };

  // ① 先收尾"太久没见到"的区间（服务重启残留、客户端已下线）。
  for (const segment of closeStaleOpenSegments(database, { now, staleMs: staleThresholdMs(intervalMs) })) {
    result.closed += 1;
    if (recordCloseEvent(database, segment, segment.lastSeenAt)) result.events += 1;
  }

  // ② 再处理本轮看到的每个会话。
  for (const session of sessions) {
    const observation = toObservation(session, directory);
    if (!observation) continue;
    result.observed += 1;

    const open = findOpenSegment(database, observation);
    if (open) {
      touchSegment(database, open.id, observation, at);
      result.extended += 1;
      continue;
    }

    // 换片 / 从"挂着"变成"在播"：先把旧区间封口（封口时间就是现在，我们知道它刚切走）。
    for (const closedSegment of closeOtherOpenSegments(database, {
      sessionId: observation.sessionId,
      keepKind: observation.kind,
      keepItemId: observation.itemId,
      at,
    })) {
      result.closed += 1;
      if (recordCloseEvent(database, closedSegment, at)) result.events += 1;
    }

    // 这个会话第一次出现 = 客户端接入（登录）。必须在写入新区间**之前**判断，
    // 否则刚插进去的那一段会让"见过"立刻成立，登录事件永远记不下来。
    const isNewSession = !sessionSeenBefore(database, observation.sessionId);

    openSegment(database, observation, at);
    result.opened += 1;

    if (isNewSession) {
      if (
        insertUsageEvent(database, {
          embyUserId: observation.embyUserId,
          memberEmail: observation.memberEmail,
          userName: observation.userName,
          kind: "login",
          source: "sampler",
          deviceId: observation.deviceId,
          deviceName: observation.deviceName,
          client: observation.client,
          appVersion: observation.appVersion,
          remoteAddress: observation.remoteAddress,
          detail: "客户端接入",
          occurredAt: at,
        })
      ) {
        result.events += 1;
      }
    }

    if (observation.kind === "play") {
      if (
        insertUsageEvent(database, {
          embyUserId: observation.embyUserId,
          memberEmail: observation.memberEmail,
          userName: observation.userName,
          kind: "play_start",
          source: "sampler",
          itemId: observation.itemId || null,
          itemTitle: observation.itemTitle,
          episodeTitle: observation.episodeTitle,
          seasonNumber: observation.seasonNumber,
          episodeNumber: observation.episodeNumber,
          deviceId: observation.deviceId,
          deviceName: observation.deviceName,
          client: observation.client,
          appVersion: observation.appVersion,
          remoteAddress: observation.remoteAddress,
          positionTicks: observation.positionTicks,
          runTimeTicks: observation.runTimeTicks,
          occurredAt: at,
        })
      ) {
        result.events += 1;
      }
    }
  }

  return result;
}
