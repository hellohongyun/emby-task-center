/**
 * 在线播放会话分组：把 Emby 的会话列表拆成"正在播放"和"只是连着"。
 *
 * 为什么值得单独分：管理端每 3 秒轮询一次 /Sessions，返回的会话里既有会员正在看的片子，
 * 也有客户端挂着没播的、以及本应用/系统自己连上去的会话（媒体任务中心、TgtoDrive…）。
 * 以前整列平铺，没在播的卡片会把真正在播的那条挤下去，看着像"面板卡住了"——
 * 所以默认只显示正在播放，其余的折叠成一行，需要时再展开。
 */
import type { EmbySessionRow } from "../types";

export interface SessionGroups {
  /** 正在播放（有 NowPlayingItem），最近活动的排前面。 */
  playing: EmbySessionRow[];
  /** 客户端连着但没在播。 */
  idle: EmbySessionRow[];
}

/** 会话最后活动时间的排序键（ISO 字符串可直接比较，缺的排最后）。 */
function activityKey(session: EmbySessionRow): string {
  return session.lastActivityDate ?? "";
}

export function groupSessions(sessions: readonly EmbySessionRow[]): SessionGroups {
  const sorted = [...sessions].sort((left, right) => activityKey(right).localeCompare(activityKey(left)));
  return {
    playing: sorted.filter((session) => session.isPlaying),
    idle: sorted.filter((session) => !session.isPlaying),
  };
}

/**
 * 没有绑定任何 Emby 用户的会话 = 本应用/系统自己连上去的（不是会员在播）。
 * 会员会话一定有 UserId；这类会话以前和会员会话长得一模一样，容易被误读成"有人在看"。
 */
export function isSystemSession(session: EmbySessionRow): boolean {
  return !session.userId;
}
