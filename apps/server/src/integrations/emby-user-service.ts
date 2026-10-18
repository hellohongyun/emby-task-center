import { enrichSessionStreams } from "./emby-session-streams";
export { clearSessionStreamCache } from "./emby-session-streams";
import {
  normalizeEmbyDate,
  type EmbyClient,
  type EmbySession,
  type EmbyUser,
  type EmbyUserPolicy,
} from "./emby-client";
import {
  bitrateLabel,
  describePlayback,
  ticksToClock,
  type PlaybackItem,
  type PlaybackTranscoding,
} from "./emby-playback";

export interface EmbyUserViewModel {
  id: string;
  name: string;
  isAdmin: boolean;
  isHidden: boolean;
  isDisabled: boolean;
  playbackEnabled: boolean;
  enabledDevices: string[] | null;
  maxStreamingBitrate: number | null;
  lastLoginDate: string | null;
  lastActivityDate: string | null;
  activeSessions: number;
}

/**
 * 在线会话（管理端"播放详情"的数据源）。
 *
 * 字段刻意对齐 Emby 客户端顶部那块播放状态：谁、在哪台设备、用什么客户端、什么片、
 * 看到第几分钟、直接播放还是转码、容器/码率/视频编码/音轨。
 * 原始值（codec、ticks）与展示文案（videoLabel、positionText）都给：前者用于筛选/排序，后者直接渲染。
 */
export interface EmbySessionViewModel {
  id: string;
  userId: string | null;
  userName: string | null;
  deviceName: string | null;
  deviceId: string | null;
  client: string | null;
  applicationVersion: string | null;
  /** 客户端来源地址（IP:端口，取不到时只有 IP）。 */
  remoteAddress: string | null;
  /** Emby 记录的会话最后活动时间。 */
  lastActivityDate: string | null;

  /** 正在播放的条目；null = 客户端连着但没在播。 */
  item: PlaybackItem | null;
  /** 展示标题（"诛仙 S4E4 · 镇魔古洞"）；没在播时为 null。 */
  nowPlaying: string | null;
  nowPlayingType: string | null;
  runTimeTicks: number | null;
  positionTicks: number | null;
  /** "4:39 / 21:07" 里的当前进度文案。 */
  positionText: string | null;
  runTimeText: string | null;
  isPaused: boolean;
  playMethod: string | null;
  playMethodLabel: string;
  /** 进度百分比；**null = 总时长未知**（Emby 没给 RunTimeTicks，算不出百分比），不是 0%。 */
  progressPercent: number | null;
  container: string | null;
  /** bps；界面用 bitrateText 更直观。 */
  bitrate: number | null;
  bitrateText: string | null;
  mediaSourceName: string | null;
  videoLabel: string | null;
  videoDirect: boolean | null;
  audioLabel: string | null;
  audioDirect: boolean | null;
  audioStreams: string[];
  subtitleLabel: string | null;
  transcoding: PlaybackTranscoding | null;
  /** 是否正在播放（有 NowPlayingItem）。空闲/残留会话为 false，不计入并发上限。 */
  isPlaying: boolean;
}

export interface EmbyUserService {
  listUsers(): Promise<EmbyUserViewModel[]>;
  createUser(input: { name: string; password?: string; isAdmin?: boolean }): Promise<{ id: string; name: string }>;
  setPassword(userId: string, password: string): Promise<void>;
  setDisabled(userId: string, disabled: boolean): Promise<void>;
  applyPolicy(userId: string, policy: EmbyUserPolicy): Promise<void>;
  deleteUser(userId: string): Promise<void>;
  listSessions(): Promise<EmbySessionViewModel[]>;
  endSession(sessionId: string): Promise<void>;
}

/**
 * 读某账号当前的 Emby 策略。
 *
 * 为什么必须"先读再写"：Emby 的 `POST /Users/{Id}/Policy` 是**整份策略覆盖**，不是字段增量更新。
 * 只发 `{IsDisabled:true}` 会把 SimultaneousStreamLimit 冲成默认值；只发 `{SimultaneousStreamLimit:N}`
 * 又会把刚写好的 IsDisabled 冲回 false —— 于是"冻结"会被之后任意一次上限同步悄悄解除。
 * 读取失败、用户不存在或策略缺失时拒绝写入，避免用部分策略覆盖原有安全设置。
 */
async function readPolicy(emby: EmbyClient, userId: string): Promise<EmbyUserPolicy> {
  const users = await emby.listUsers?.();
  if (!Array.isArray(users)) throw new Error("emby_user_policy_unavailable");
  const user = users.find((entry) => entry.Id === userId);
  if (!user) throw new Error("emby_http_404");
  if (!user.Policy || typeof user.Policy !== "object" || Array.isArray(user.Policy))
    throw new Error("emby_user_policy_unavailable");
  return user.Policy;
}

/** Emby 错误：带有 user-facing message + HTTP status。 */
export class EmbyUserError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

function translate(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  if (message === "emby_not_configured")
    throw new EmbyUserError("Emby 未配置：请检查 EMBY_BASE_URL 与 EMBY_API_KEY。", 409);
  if (message === "emby_user_management_unsupported")
    throw new EmbyUserError("当前 EMBY_API_KEY 不允许用户管理，请使用具备用户管理权限的管理员密钥。", 409);
  // 注意：这里**不能**回 401。前端把 401 一律当成"管理端登录失效"→ 直接弹回登录页；
  // 而"Emby 侧凭据失效"是上游的问题，跟管理员会话无关（曾经因此把人踢出登录页）。
  if (message === "emby_http_401")
    throw new EmbyUserError("Emby API 鉴权失败：EMBY_API_KEY 无效或已过期，请在「系统设置 → Emby API Key」更换。", 502);
  if (message === "emby_http_403") throw new EmbyUserError("Emby 拒绝该操作：密钥权限不足。", 403);
  if (message === "emby_http_404") throw new EmbyUserError("Emby 用户或会话不存在。", 404);
  if (message === "emby_user_policy_unavailable")
    throw new EmbyUserError("无法读取完整 Emby 用户策略，请稍后重试。", 502);
  throw new EmbyUserError(`Emby 请求失败：${message.replace(/^emby_http_/, "")}`, 502);
}

/**
 * Emby 用户管理服务：封装 Emby 用户/会话 API。后续需求（会员到期自动停用、
 * 投稿通过自动开户、同时在线上限等）都在这层扩展，保持路由与 UI 薄。
 */
export function createEmbyUserService(client: EmbyClient | undefined): EmbyUserService {
  function manager(): EmbyClient & {
    listUsers: Exclude<EmbyClient["listUsers"], undefined>;
    createUser: Exclude<EmbyClient["createUser"], undefined>;
    setUserPassword: Exclude<EmbyClient["setUserPassword"], undefined>;
    updateUserPolicy: Exclude<EmbyClient["updateUserPolicy"], undefined>;
    deleteUser: Exclude<EmbyClient["deleteUser"], undefined>;
    listSessions: Exclude<EmbyClient["listSessions"], undefined>;
  } {
    if (!client?.configured) throw new EmbyUserError("emby_not_configured", 409);
    if (
      !client.listUsers ||
      !client.createUser ||
      !client.setUserPassword ||
      !client.updateUserPolicy ||
      !client.deleteUser
    ) {
      throw new EmbyUserError("emby_user_management_unsupported", 409);
    }
    return client as never;
  }

  function toUserView(user: EmbyUser, activeSessions: number): EmbyUserViewModel {
    return {
      id: user.Id,
      name: user.Name,
      isAdmin: Boolean(user.Policy?.IsAdministrator),
      isHidden: Boolean(user.Policy?.IsHidden),
      isDisabled: Boolean(user.Policy?.IsDisabled),
      playbackEnabled: user.Policy?.PlaybackEnabled !== false,
      enabledDevices: user.Policy?.EnabledDevices ?? null,
      maxStreamingBitrate: user.Policy?.MaxStreamingBitrate ?? null,
      lastLoginDate: user.LastLoginDate ?? null,
      lastActivityDate: user.LastActivityDate ?? null,
      activeSessions,
    };
  }

  return {
    async listUsers() {
      try {
        const emby = manager();
        const [users, sessions] = await Promise.all([emby.listUsers(), emby.listSessions?.() ?? []]);
        const counts = new Map<string, number>();
        for (const session of sessions) {
          if (session.UserId) counts.set(session.UserId, (counts.get(session.UserId) ?? 0) + 1);
        }
        return users.map((user) => toUserView(user, counts.get(user.Id) ?? 0));
      } catch (error) {
        translate(error);
      }
    },
    async createUser(input) {
      try {
        const emby = manager();
        const user = await emby.createUser(input.name);
        if (input.password) await emby.setUserPassword(user.Id, input.password);
        if (input.isAdmin) await emby.updateUserPolicy(user.Id, { IsAdministrator: true });
        return { id: user.Id, name: user.Name };
      } catch (error) {
        translate(error);
      }
    },
    async setPassword(userId, password) {
      try {
        await manager().setUserPassword(userId, password);
      } catch (error) {
        translate(error);
      }
    },
    async setDisabled(userId, disabled) {
      try {
        const emby = manager();
        await emby.updateUserPolicy(userId, { ...(await readPolicy(emby, userId)), IsDisabled: disabled });
      } catch (error) {
        translate(error);
      }
    },
    async applyPolicy(userId, policy) {
      try {
        const emby = manager();
        await emby.updateUserPolicy(userId, { ...(await readPolicy(emby, userId)), ...policy });
      } catch (error) {
        translate(error);
      }
    },
    async deleteUser(userId) {
      try {
        await manager().deleteUser(userId);
      } catch (error) {
        translate(error);
      }
    },
    async listSessions() {
      try {
        const emby = manager();
        const sessions = (await emby.listSessions?.()) ?? [];
        // 先把缺媒体流的会话补齐（4K HEVC / EAC3 stereo 这些详情来自它），再统一转视图模型。
        await enrichSessionStreams(emby, sessions);
        return sessions.map((session: EmbySession): EmbySessionViewModel => {
          const playback = describePlayback(session);
          // 用解析后的值：总时长会从"条目层 → 媒体源层"兜底（strm 片源 Emby 两层都可能不给）。
          const positionTicks = playback.positionTicks;
          const runTimeTicks = playback.runTimeTicks;
          return {
            id: session.Id,
            userId: session.UserId ?? null,
            userName: session.UserName ?? null,
            deviceName: session.DeviceName ?? null,
            deviceId: session.DeviceId ?? null,
            client: session.Client ?? null,
            applicationVersion: session.ApplicationVersion ?? null,
            remoteAddress: session.RemoteEndPoint ?? null,
            lastActivityDate: normalizeEmbyDate(session.LastActivityDate),
            item: playback.item,
            nowPlaying: playback.item?.displayTitle ?? null,
            nowPlayingType: session.NowPlayingItem?.Type ?? null,
            runTimeTicks,
            positionTicks,
            positionText: positionTicks != null ? ticksToClock(positionTicks) : null,
            runTimeText: runTimeTicks != null ? ticksToClock(runTimeTicks) : null,
            isPaused: Boolean(session.PlayState?.IsPaused),
            playMethod: playback.playMethod,
            playMethodLabel: playback.playMethodLabel,
            progressPercent: playback.progressPercent,
            container: playback.container,
            bitrate: playback.bitrate,
            bitrateText: bitrateLabel(playback.bitrate),
            mediaSourceName: playback.mediaSourceName,
            videoLabel: playback.videoLabel,
            videoDirect: playback.videoDirect,
            audioLabel: playback.audioLabel,
            audioDirect: playback.audioDirect,
            audioStreams: playback.audioStreams,
            subtitleLabel: playback.subtitleLabel,
            transcoding: playback.transcoding,
            isPlaying: Boolean(session.NowPlayingItem),
          };
        });
      } catch (error) {
        translate(error);
      }
    },
    async endSession(sessionId) {
      try {
        await client?.endSession?.(sessionId);
      } catch (error) {
        translate(error);
      }
    },
  };
}
