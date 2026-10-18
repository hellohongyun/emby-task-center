import type { AppDatabase } from "@emby-task-center/database/client";
import type { EmbyClient } from "../integrations/emby-client";
import { StreamLimitResolver } from "./stream-limits";

export interface StreamGuardResult {
  /** 被停掉的会话数（含强制登出）。 */
  stopped: number;
  /** 判定为超限的账号数。 */
  overshootUsers: number;
  /** 被处理的会话明细（设备名 + 动作），用于日志里说清"停了哪台、用什么手段"。 */
  stoppedSessions: Array<{ sessionId: string; deviceName: string; action: StreamGuardAction }>;
  /** 当前有播放（或暂停）的账号数：调用方据此决定下一次检查要等多久。 */
  playingUsers: number;
}

interface PlayingSession {
  id: string;
  userId: string;
  deviceName: string;
  deviceId: string | null;
  positionTicks: number | null;
}

/**
 * 同一账号多个播放会话时，选出要停掉的那些 —— **先到先得，中断后来者**。
 *
 * 判定"谁先来"用播放进度：看得更久的那个进度更大，保留它；进度小的（刚点开的那台）停掉。
 * 进度相同/缺失时按会话 id 稳定排序，保证结果可复现。纯函数，便于单测。
 */
export function pickSessionsToStop(sessions: PlayingSession[], limit: number): PlayingSession[] {
  if (limit <= 0 || sessions.length <= limit) return [];
  const ordered = [...sessions].sort((left, right) => {
    const byPosition = (right.positionTicks ?? 0) - (left.positionTicks ?? 0);
    if (byPosition !== 0) return byPosition;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
  return ordered.slice(limit);
}

/**
 * 每个被处理会话的状态：第一次先"请客户端停止播放"，若下一次检查它还在播，就**强制登出**。
 * （真实案例：某客户端收到 Stop 命令后照播不误，只有断开会话才真的停下。）
 */
interface StopAttempt {
  attempts: number;
  lastActionAt: number;
  lastAction: StreamGuardAction;
}
const stopAttempts = new Map<string, StopAttempt>();
/** 手段逐级加强：先请客户端停 → 断开会话 → 最后踢掉设备（令牌失效，客户端必须重新登录）。 */
export type StreamGuardAction = "stop" | "logout" | "kick";
/**
 * 升级节奏（有播放时每秒检查一次）：
 *   第 1 秒 请客户端自己停 → 第 2 秒 断开会话 → 第 5 秒起 踢掉设备（令牌失效）。
 * 违规的第二路只需要挡住，不必给它时间。
 */
const STOP_ATTEMPTS_BEFORE_LOGOUT = 1;
const LOGOUT_ATTEMPTS_BEFORE_KICK = 2;
/** 同一手段的重复间隔：会话还在就持续处理，但别每 tick 都发。 */
const REPEAT_INTERVAL_MS = 3_000;

/** 清空处理记录（测试用；模块级状态在同一个进程里跨用例共享）。 */
export function clearStreamStopCooldown(): void {
  stopAttempts.clear();
}

export interface TerminateResult {
  /** 成功断开的会话数（Logout 命令）。 */
  sessions: number;
  /** 成功踢掉的设备数（令牌失效，客户端必须重新登录）。 */
  devices: number;
}

/**
 * 强制终止某会员的所有会话（冻结用）。
 *
 * 为什么不能只写策略位：这台 Emby **不因账号停用中断"已登录设备"的播放**——被冻结的人
 * 照样能看完当前片子、甚至再开一路。所以冻结必须主动断会话 + 踢设备：令牌失效后客户端
 * 必须重新登录，而账号已停用，登不回来。
 *
 * 幂等、best-effort：单个会话失败不阻断其它，下一轮（30 秒后）还会再来一遍。
 */
export async function terminateMemberSessions(emby: EmbyClient | undefined, userId: string): Promise<TerminateResult> {
  const nothing: TerminateResult = { sessions: 0, devices: 0 };
  if (!emby?.configured || !emby.listSessions || !userId) return nothing;

  let sessions: Array<{ Id?: string; UserId?: string | null; DeviceId?: string | null; NowPlayingItem?: unknown }>;
  try {
    sessions = (await emby.listSessions()) as never;
  } catch {
    return nothing;
  }

  let ended = 0;
  let kicked = 0;
  for (const session of sessions) {
    if (session.UserId !== userId || !session.Id) continue;
    // 先让服务端停掉这一路的播放，再断会话、最后踢设备。
    if (session.NowPlayingItem && emby.stopPlayback) {
      try {
        await emby.stopPlayback(session.Id);
      } catch {
        /* 单会话失败不阻断 */
      }
    }
    try {
      if (emby.endSession) {
        await emby.endSession(session.Id);
        ended += 1;
      }
    } catch {
      /* 同上 */
    }
    if (session.DeviceId && emby.removeDevice) {
      try {
        if (await emby.removeDevice(session.DeviceId)) kicked += 1;
      } catch {
        /* 同上 */
      }
    }
  }
  return { sessions: ended, devices: kicked };
}

/**
 * 并发看门狗：查 Emby 会话，同一个账号出现超过上限的播放就把多出来的掐掉。
 *
 * **这是并发限制唯一的执行点**：不在请求层猜意图（客户端浏览时也会问
 * PlaybackInfo，按请求判断必然误伤）。看门狗只看结果，客户端从哪条路进来都能兜住。
 *
 * 手段逐级加强：① `POST /Sessions/{id}/Playing/Stop`（请客户端停止播放）；
 * ② 下一次检查仍在播 → `POST /Sessions/{id}/Command`（Logout，直接断开该会话）。
 * 只处理"正在播放/已暂停"的会话（暂停也占一路）。
 */
export async function enforceStreamLimits(
  database: AppDatabase,
  emby: EmbyClient | undefined,
  resolveLimit = new StreamLimitResolver(database, emby),
): Promise<StreamGuardResult> {
  const nothing: StreamGuardResult = { stopped: 0, overshootUsers: 0, stoppedSessions: [], playingUsers: 0 };
  if (!emby?.configured || !emby.listSessions) return nothing;

  let rawSessions: Array<{
    Id?: string;
    UserId?: string | null;
    DeviceName?: string | null;
    DeviceId?: string | null;
    NowPlayingItem?: unknown;
    PlayState?: { PositionTicks?: number; IsPaused?: boolean } | null;
  }>;
  try {
    rawSessions = (await emby.listSessions()) as never;
  } catch {
    return nothing;
  }

  const byUser = new Map<string, PlayingSession[]>();
  for (const session of rawSessions) {
    const userId = session.UserId;
    if (!userId || !session.Id) continue;
    // 正在播放或已暂停都算占用一路。
    if (!session.NowPlayingItem && !session.PlayState?.IsPaused) continue;
    const list = byUser.get(userId) ?? [];
    list.push({
      id: session.Id,
      userId,
      deviceName: session.DeviceName ?? "未知设备",
      deviceId: session.DeviceId ?? null,
      positionTicks: session.PlayState?.PositionTicks ?? null,
    });
    byUser.set(userId, list);
  }

  // 会话已经不在了 → 清掉它的处理记录，避免 Map 长期增长。
  const alive = new Set([...byUser.values()].flat().map((session) => session.id));
  for (const id of stopAttempts.keys()) if (!alive.has(id)) stopAttempts.delete(id);

  let stopped = 0;
  let overshootUsers = 0;
  const stoppedSessions: StreamGuardResult["stoppedSessions"] = [];
  for (const [userId, list] of byUser) {
    // 冻结中的会员：一路都不许（冻结期间 Emby 不会自己拦住已登录设备，这里必须持续断）。
    const frozen = resolveLimit.isFrozen(userId);
    const limit = await resolveLimit.limitFor(userId);
    if (!frozen && limit == null) continue;
    const extras = frozen ? list : pickSessionsToStop(list, limit!);
    if (!extras.length) continue;
    overshootUsers += 1;
    const now = Date.now();
    for (const session of extras) {
      const attempt = stopAttempts.get(session.id);
      // 前几次请客户端自己停；连发 STOP_ATTEMPTS_BEFORE_LOGOUT 次还不停 → 强制登出该会话。
      // 冻结不再给机会：直接踢设备（令牌失效），踢不动就断会话。
      const attempts = attempt?.attempts ?? 0;
      const action: StreamGuardAction = frozen
        ? "kick"
        : attempts < STOP_ATTEMPTS_BEFORE_LOGOUT
          ? "stop"
          : attempts < LOGOUT_ATTEMPTS_BEFORE_KICK
            ? "logout"
            : "kick";
      // 同一手段的重复发送要间隔；升级到新手段时立刻发。
      const repeats = attempts > 0 && action === attempt?.lastAction;
      if (repeats && now - (attempt?.lastActionAt ?? 0) < REPEAT_INTERVAL_MS) continue;
      // 记录**实际生效**的手段：踢设备在 Emby 的 /Devices 里找不到该设备时会退化为断会话，
      // 这时候日志再写"踢设备"就是谎报——线上排查时会以为踢过了、实际只是断了会话。
      let effective: StreamGuardAction = action;
      try {
        if (action === "stop" && emby.stopPlayback) await emby.stopPlayback(session.id);
        else if (action === "logout" && emby.endSession) await emby.endSession(session.id);
        else if (action === "kick" && session.deviceId && emby.removeDevice) {
          const kicked = await emby.removeDevice(session.deviceId);
          effective = kicked ? "kick" : "logout";
          if (!kicked && emby.endSession) await emby.endSession(session.id);
        } else if (emby.endSession) {
          await emby.endSession(session.id);
          effective = "logout";
        } else if (emby.stopPlayback) {
          await emby.stopPlayback(session.id);
          effective = "stop";
        } else break;
        stopAttempts.set(session.id, { attempts: attempts + 1, lastActionAt: now, lastAction: action });
        stopped += 1;
        stoppedSessions.push({ sessionId: session.id, deviceName: session.deviceName, action: effective });
      } catch {
        // 单个会话停不掉不阻断其它；下一次检查还会再试。
      }
    }
  }
  return { stopped, overshootUsers, stoppedSessions, playingUsers: byUser.size };
}
