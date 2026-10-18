import { discardBody } from "../util/http";
import { fetchImage } from "../util/image-request";
import { createEmbyLibraryReader } from "./emby-library-reader";
export { normalizeEmbyDate } from "./emby-library-reader";

export interface EmbyUserPolicy {
  IsAdministrator?: boolean;
  IsHidden?: boolean;
  IsDisabled?: boolean;
  PlaybackEnabled?: boolean;
  EnableAllDevices?: boolean;
  EnabledDevices?: string[];
  MaxStreamingBitrate?: number | null;
  RemoteClientBitrateLimit?: number | null;
  [key: string]: unknown;
}

export interface EmbyUser {
  Id: string;
  Name: string;
  Policy?: EmbyUserPolicy | null;
  LastLoginDate?: string | null;
  LastActivityDate?: string | null;
}

/** Emby 的一条媒体流（视频/音频/字幕）。会话详情里的"4K HEVC""Chinese EAC3 stereo"就是它。 */
export interface EmbyMediaStream {
  /** Video / Audio / Subtitle。 */
  Type?: string | null;
  Index?: number | null;
  Codec?: string | null;
  /** 编码档次（如 hevc main 10 / aac lc）。 */
  Profile?: string | null;
  Language?: string | null;
  DisplayTitle?: string | null;
  DisplayLanguage?: string | null;
  IsDefault?: boolean | null;
  IsExternal?: boolean | null;
  Width?: number | null;
  Height?: number | null;
  BitRate?: number | null;
  Channels?: number | null;
  ChannelLayout?: string | null;
  SampleRate?: number | null;
  /** SDR / HDR10 / HLG / DolbyVision。 */
  VideoRange?: string | null;
  VideoRangeType?: string | null;
  ColorTransfer?: string | null;
  /** 字幕流才有：内封/外挂。 */
  DeliveryMethod?: string | null;
  Title?: string | null;
}

/** Emby 的媒体源（一个条目可能有多个版本：4K / 1080P）。 */
export interface EmbyMediaSource {
  Id?: string | null;
  Name?: string | null;
  Container?: string | null;
  /** 总码率（bps）。 */
  Bitrate?: number | null;
  Size?: number | null;
  RunTimeTicks?: number | null;
  MediaStreams?: EmbyMediaStream[] | null;
}

/** 会话正在播放的条目（剧集会带 SeriesName / IndexNumber）。 */
export interface EmbyNowPlayingItem {
  Id?: string | null;
  Name?: string | null;
  SeriesName?: string | null;
  SeriesId?: string | null;
  /** Movie / Episode / Series … */
  Type?: string | null;
  IndexNumber?: number | null;
  ParentIndexNumber?: number | null;
  ProductionYear?: number | null;
  RunTimeTicks?: number | null;
  Container?: string | null;
  Bitrate?: number | null;
  MediaStreams?: EmbyMediaStream[] | null;
  MediaSources?: EmbyMediaSource[] | null;
}

/** 转码信息：只有真转码时 Emby 才返回（直接播放时为 null）。 */
export interface EmbyTranscodingInfo {
  AudioCodec?: string | null;
  VideoCodec?: string | null;
  Container?: string | null;
  /** 视频/音频是否原样直传（DirectStream 的判定依据）。 */
  IsVideoDirect?: boolean | null;
  IsAudioDirect?: boolean | null;
  Bitrate?: number | null;
  Width?: number | null;
  Height?: number | null;
  AudioChannels?: number | null;
  Framerate?: number | null;
  CompletionPercentage?: number | null;
  /** 例如 ContainerNotSupported / VideoCodecNotSupported。 */
  TranscodeReasons?: string[] | null;
  HardwareAccelerationType?: string | null;
}

export interface EmbySession {
  Id: string;
  UserId?: string | null;
  UserName?: string | null;
  DeviceName?: string | null;
  /** 客户端设备号：取流地址里带的就是它，用来把"流量"对上"账号"。 */
  DeviceId?: string | null;
  /** 客户端来源地址：取流地址没有 DeviceId 时，用 IP 反查账号。 */
  RemoteEndPoint?: string | null;
  Client?: string | null;
  ApplicationVersion?: string | null;
  /** 会话最后一次活动时间（Emby 自己维护）。 */
  LastActivityDate?: string | null;
  NowPlayingItem?: EmbyNowPlayingItem | null;
  PlayState?: {
    PositionTicks?: number | null;
    IsPaused?: boolean | null;
    IsMuted?: boolean | null;
    VolumeLevel?: number | null;
    PlayMethod?: string | null;
    PlaySessionId?: string | null;
    MediaSourceId?: string | null;
    AudioStreamIndex?: number | null;
    SubtitleStreamIndex?: number | null;
    RepeatMode?: string | null;
  } | null;
  /** 旧的顶层字段（部分 Emby 版本只在 PlayState 里给）。 */
  PlayMethod?: string | null;
  TranscodingInfo?: EmbyTranscodingInfo | null;
  /** 支持的播放能力（诊断用，不参与展示）。 */
  PlayableMediaTypes?: string[] | null;
}

/** Emby 管理端「活动」日志的一条（登录、开始播放、结束播放…）。 */
export interface EmbyActivityEntry {
  Id?: number | string | null;
  /** 条目标题的本地化文案（"User has logged in"）。 */
  Name?: string | null;
  /** 活动类型：AuthenticationSuccess / VideoPlayback / VideoPlaybackStopped / SessionStarted … */
  Type?: string | null;
  Overview?: string | null;
  ShortOverview?: string | null;
  UserId?: string | null;
  ItemId?: string | null;
  Date?: string | null;
  Severity?: string | null;
}

export interface EmbyRecentItem {
  id: string;
  mediaType: "movie" | "tv";
  title: string;
  year: number | null;
  /** Emby 记录这个媒体首次入库的时间。 */
  dateCreated: string | null;
  tmdbId: number | null;
}

export interface EmbyLibraryItem {
  id: string;
  name: string;
  year: number | null;
  type: "movie" | "tv";
  tmdbId: number | null;
  /** 是否有主图（海报）；应用不再依赖磁盘上的 poster.jpg。 */
  hasPrimaryImage?: boolean;
  /** Emby 的入库时间；「最近入库」排序用它。 */
  dateCreated?: string | null;
  /** Emby 自己的题材（中文），媒体库页的"题材"筛选用它。 */
  genres?: string[];
}

/** Emby 里的一个媒体库（Library/VirtualFolders）。库可以在 Emby 侧随时增删，所以按需实时拉取。 */
export interface EmbyLibraryFolder {
  /** Emby 的库 Id（顶层 CollectionFolder 的 ItemId）；媒体库同步以它为主键。 */
  id: string;
  name: string;
  /** movies / tvshows / mixed（Emby 对未知类型可能不返回）。 */
  collectionType: "movies" | "tvshows" | "mixed";
  /** 该库配置的磁盘路径（诊断用；应用不再依赖磁盘路径）。 */
  locations: string[];
}

export interface EmbyClient {
  configured: boolean;
  /** Opaque cache generation, changed whenever connection credentials change. */
  readonly mediaStreamsCacheIdentity?: object;
  systemInfo(): Promise<{ id: string | null; serverName: string; version: string }>;
  verify(input: { tmdbId: number; mediaType: "movie" | "tv"; episodes: number[] }): Promise<boolean>;
  /** 用户管理（可选能力，由支持用户管理的 Emby 客户端提供） */
  listUsers?(): Promise<EmbyUser[]>;
  /**
   * 按 Id 取单个用户。**GUID 与内部数字 id 都接受** —— Emby 活动日志里的 `UserId` 给的是
   * 内部数字 id（线上实测：同一个账号在 /Sessions 是 GUID `01234567…`，在活动日志里是 `1`），
   * 所以这是把活动日志的身份翻译回 GUID 的入口。取不到（用户已删/密钥无权限）返回 null。
   */
  getUser?(userId: string): Promise<{ id: string; name: string } | null>;
  createUser?(name: string): Promise<EmbyUser>;
  setUserPassword?(userId: string, password: string): Promise<void>;
  updateUserPolicy?(userId: string, policy: EmbyUserPolicy): Promise<void>;
  deleteUser?(userId: string): Promise<void>;
  /** 实时会话/播放（可选） */
  listSessions?(): Promise<EmbySession[]>;
  /**
   * 取某条目的媒体流（会话里没带 MediaStreams 时的兜底）。
   * 只用来把"4K HEVC / EAC3 stereo"这类播放详情显示完整，失败不影响会话列表。
   */
  itemMediaStreams?(itemId: string): Promise<{ container: string | null; mediaStreams: EmbyMediaStream[] } | null>;
  /** Emby 管理端活动日志（登录/播放记录的历史来源；需要管理员密钥）。 */
  listActivityLog?(query?: { startIndex?: number; limit?: number }): Promise<EmbyActivityEntry[]>;
  /** 结束某设备会话（断开会话，最佳努力；Emby 版本差异可能不支持） */
  endSession?(sessionId: string): Promise<void>;
  /** 停掉某会话正在进行的播放（比 endSession 更硬：让客户端停止播放） */
  stopPlayback?(sessionId: string): Promise<void>;
  /**
   * 踢掉某台设备（DELETE /Devices?Id=）：会让该设备的访问令牌失效，客户端必须重新登录。
   * 对付"收到 Stop/Logout 也不停、又没有 WebSocket 收不到服务端命令"的第三方客户端时，
   * 这是服务端最后能用的手段。
   */
  removeDevice?(deviceId: string): Promise<boolean>;
  /** Emby「最近添加」：按 DateCreated 返回最新 Movie/Series。 */
  recentItems?(): Promise<EmbyRecentItem[]>;
  /** 按 tmdbId 或标题（可加年份/类型）查库；用于去重与入库确认。 */
  searchItems?(query: {
    tmdbId?: number | null;
    title?: string;
    year?: number | null;
    mediaType?: "movie" | "tv";
  }): Promise<EmbyLibraryItem[]>;
  /** Emby 的媒体库列表（实时；Emby 侧增删库后下次调用即反映）。 */
  listLibraryFolders?(): Promise<EmbyLibraryFolder[]>; /** Emby 全库条目（Movie/Series）；带 libraryId 时只取该库。 */
  listLibraryItems?(query?: {
    mediaType?: "movie" | "tv";
    /** 每页大小（兼容旧参数名）；结果不会按它截断。 */
    limit?: number;
    libraryId?: string;
  }): Promise<EmbyLibraryItem[]>;
  /**
   * 删除一个 Emby 条目（Emby 官方的 `DELETE /Items/{Id}`：「Deletes an item from the library and file system」）。
   * 剧集删除会按 Emby 侧策略联动片源清理 —— 缺集总览的"删除该影片"走这里。
   */
  deleteItem?(itemId: string): Promise<void>;
  /**
   * 某剧集已在 Emby 的集索引（电影返回空）；用于缺集计算。
   * 带每集自己的 Emby Id 与集名：同一剧集里可能存在重复集号（真实库里「超级飞侠大百科」第 20 季第 19 集有 17 条），
   * 只有集 Id 能唯一标识一条；集名用于缺集的"换号存在"兜底判定。
   */
  listItemEpisodes?(seriesId: string): Promise<
    Array<{
      id: string;
      seasonNumber: number | null;
      /** Null only for an explicitly identified S00 special without a number. */
      episodeNumber: number | null;
      /** Inclusive end of a combined episode file; absent for ordinary single episodes. */
      episodeNumberEnd?: number | null;
      name: string | null;
    }>
  >;
  /**
   * 某剧集的季列表（带季的 Emby Id）：缺集总览的「在 Emby 查看」按季跳转需要它。
   * Emby 里同一季可能出现多个条目（重复入库），调用方自行按季号取第一个。
   */
  listSeasons?(seriesId: string): Promise<Array<{ id: string; seasonNumber: number | null; name: string }>>;
  /**
   * 让 Emby 立刻扫描媒体库（入库后调用）。
   * 不做这一步，Emby 只能等它自己的扫描周期，"已入库"状态就要靠轮询，窗口期可能很长。
   */
  refreshLibrary?(): Promise<boolean>;
  /** 取 Emby 海报原图（服务端带 token 透传；公开代理用）。 */
  image?(
    itemId: string,
    size?: "Primary" | "Backdrop",
    signal?: AbortSignal,
  ): Promise<{ contentType: string; body: Buffer } | null>;
}

/**
 * Emby 客户端。
 *
 * 凭据有两种给法：
 *  - 直接给 `baseUrl` / `apiKey`（测试与一次性用途）；
 *  - 给 `resolve()`，每次请求现取（生产用：后台改了 Emby 地址/密钥立刻生效，不必重启）。
 */
export function createEmbyClient(options: {
  baseUrl?: string;
  apiKey?: string;
  resolve?: () => { baseUrl?: string; apiKey?: string };
}): EmbyClient {
  let streamIdentity = {};
  let streamCredentials: string | undefined;
  function credentials(): { baseUrl: string | undefined; apiKey: string | undefined } {
    if (options.resolve) {
      const live = options.resolve();
      return { baseUrl: live.baseUrl?.replace(/\/$/, ""), apiKey: live.apiKey };
    }
    return { baseUrl: options.baseUrl?.replace(/\/$/, ""), apiKey: options.apiKey };
  }

  async function request(method: string, path: string, body?: unknown): Promise<unknown> {
    const { baseUrl, apiKey } = credentials();
    if (!baseUrl || !apiKey) throw new Error("emby_not_configured");
    const response = await fetch(`${baseUrl}/emby${path}`, {
      method,
      headers: {
        "X-Emby-Token": apiKey,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      // 非 2xx 分支不读 body，必须显式释放：否则对端关闭 socket 时会触发
      // undici 的 assert(!this.paused) 崩溃（见 util/http.ts）。
      discardBody(response);
      throw new Error(`emby_http_${response.status}`);
    }
    if (response.status === 204) return undefined;
    return response.json();
  }
  function get(path: string, query?: URLSearchParams): Promise<unknown> {
    return request("GET", query ? `${path}?${query}` : path);
  }

  return {
    get mediaStreamsCacheIdentity() {
      const live = credentials();
      const key = JSON.stringify([live.baseUrl, live.apiKey]);
      if (key !== streamCredentials) {
        streamCredentials = key;
        streamIdentity = {};
      }
      return streamIdentity;
    },
    get configured() {
      const { baseUrl, apiKey } = credentials();
      return Boolean(baseUrl && apiKey);
    },
    systemInfo: async () => {
      const body = (await get("/System/Info")) as { Id?: unknown; ServerName?: unknown; Version?: unknown };
      return {
        id: typeof body.Id === "string" && body.Id ? body.Id : null,
        serverName: String(body.ServerName ?? "Emby"),
        version: String(body.Version ?? "unknown"),
      };
    },
    verify: async (input) => {
      const items = (await get(
        "/Items",
        new URLSearchParams({
          Recursive: "true",
          IncludeItemTypes: input.mediaType === "movie" ? "Movie" : "Series",
          AnyProviderIdEquals: `Tmdb.${input.tmdbId}`,
          Fields: "ProviderIds",
          Limit: "10",
        }),
      )) as { Items?: Array<{ Id?: string }> };
      const item = items.Items?.find((candidate) => candidate.Id);
      if (!item?.Id) return false;
      if (input.mediaType === "movie" || input.episodes.length === 0) return true;
      const episodeBody = (await get(
        "/Items",
        new URLSearchParams({
          ParentId: item.Id,
          Recursive: "true",
          IncludeItemTypes: "Episode",
          Fields: "IndexNumber,ParentIndexNumber",
          Limit: "10000",
        }),
      )) as { Items?: Array<{ IndexNumber?: number; ParentIndexNumber?: number }> };
      const present = new Set(
        (episodeBody.Items ?? []).flatMap((episode) =>
          Number.isInteger(episode.IndexNumber) ? [episode.IndexNumber!] : [],
        ),
      );
      return input.episodes.every((episode) => present.has(episode));
    },
    listUsers: async () => (await get("/Users")) as EmbyUser[],
    // Emby 的 /Users/{id} 同时吃 GUID 与内部数字 id（实测 4.10：/Users/1 → GUID 01234567…/sample-member）。
    getUser: async (userId: string) => {
      try {
        const body = (await get(`/Users/${encodeURIComponent(userId)}`)) as EmbyUser;
        if (!body?.Id) return null;
        return { id: String(body.Id), name: String(body.Name ?? "") };
      } catch {
        return null;
      }
    },
    createUser: async (name) => (await request("POST", "/Users/New", { Name: name })) as EmbyUser,
    setUserPassword: async (userId, password) => {
      await request("POST", `/Users/${userId}/Password`, { NewPw: password });
    },
    updateUserPolicy: async (userId, policy) => {
      await request("POST", `/Users/${userId}/Policy`, policy);
    },
    deleteUser: async (userId) => {
      await request("DELETE", `/Users/${userId}`);
    },
    listSessions: async () => (await get("/Sessions")) as EmbySession[],
    itemMediaStreams: async (itemId) => {
      const body = (await get(
        "/Items",
        new URLSearchParams({ Ids: itemId, Fields: "MediaStreams,MediaSources", Limit: "1" }),
      )) as {
        Items?: Array<{ Container?: unknown; MediaStreams?: EmbyMediaStream[]; MediaSources?: EmbyMediaSource[] }>;
      };
      const item = body.Items?.[0];
      if (!item) return null;
      // 单版本条目媒体流在条目上；多版本（4K/1080P）时以第一个媒体源为准。
      const mediaStreams = item.MediaStreams?.length ? item.MediaStreams : (item.MediaSources?.[0]?.MediaStreams ?? []);
      const container =
        typeof item.Container === "string" ? item.Container : (item.MediaSources?.[0]?.Container ?? null);
      return { container, mediaStreams };
    },
    listActivityLog: async (query = {}) => {
      const body = (await get(
        "/System/ActivityLog/Entries",
        new URLSearchParams({
          StartIndex: String(query.startIndex ?? 0),
          Limit: String(query.limit ?? 100),
          HasUserId: "true",
        }),
      )) as { Items?: EmbyActivityEntry[] } | EmbyActivityEntry[];
      // 老版本直接返回数组，新版本包在 { Items, TotalRecordCount } 里。
      if (Array.isArray(body)) return body;
      return body.Items ?? [];
    },
    endSession: async (sessionId) => {
      // 客户端日志正在播放的会话会被撤销；管理员发送 Logout 会话消息。
      // 注意：Logout 命令是否真正断开由客户端 App 决定（网页/部分安卓端不响应），属最佳努力。
      await request("POST", `/Sessions/${sessionId}/Command`, { Name: "Logout", CommandType: "Logout", Arguments: {} });
    },
    stopPlayback: async (sessionId) => {
      // POST /Sessions/{id}/Playing/Stop：服务端直接让该会话停止播放（比 Logout 命令更硬）。
      await request("POST", `/Sessions/${sessionId}/Playing/Stop`);
    },
    removeDevice: async (deviceId) => {
      const body = (await get("/Devices")) as { Items?: Array<{ Id?: string; DeviceId?: string }> };
      const device = body.Items?.find((item) => item.DeviceId === deviceId);
      if (!device?.Id) return false;
      await request("DELETE", `/Devices?Id=${encodeURIComponent(device.Id)}`);
      return true;
    },
    recentItems: async () => {
      const body = (await get(
        "/Items",
        new URLSearchParams({
          Recursive: "true",
          IncludeItemTypes: "Movie,Series",
          SortBy: "DateCreated",
          SortOrder: "Descending",
          Limit: "20",
          Fields: "ProviderIds,DateCreated,ProductionYear",
        }),
      )) as {
        Items?: Array<{
          Id?: unknown;
          Name?: unknown;
          SeriesName?: unknown;
          Type?: unknown;
          ProductionYear?: unknown;
          DateCreated?: unknown;
          ProviderIds?: Record<string, unknown>;
        }>;
      };
      return (body.Items ?? []).flatMap((item): EmbyRecentItem[] => {
        const id = typeof item.Id === "string" ? item.Id : "";
        const type = item.Type === "Movie" ? "movie" : item.Type === "Series" ? "tv" : null;
        const title = type === "tv" ? (item.Name ?? item.SeriesName ?? "") : (item.Name ?? "");
        if (!id || !type || typeof title !== "string" || !title.trim()) return [];
        const rawTmdb = item.ProviderIds?.Tmdb;
        const tmdbId = typeof rawTmdb === "string" ? Number(rawTmdb) : typeof rawTmdb === "number" ? rawTmdb : null;
        return [
          {
            id,
            mediaType: type,
            title,
            year: Number.isFinite(Number(item.ProductionYear)) ? Number(item.ProductionYear) : null,
            dateCreated: typeof item.DateCreated === "string" ? item.DateCreated : null,
            tmdbId: Number.isInteger(tmdbId) ? tmdbId : null,
          },
        ];
      });
    },
    searchItems: async (query) => {
      const year = query.year ?? null;
      const norm = (value: string) => value.normalize("NFKC").toLocaleLowerCase().replace(/[\s]+/g, "");
      const titleNorm = query.title ? norm(query.title.trim()) : null;
      const toItems = (body: {
        Items?: Array<{
          Id?: unknown;
          Name?: unknown;
          Type?: unknown;
          ProductionYear?: unknown;
          ProviderIds?: Record<string, unknown>;
        }>;
      }): EmbyLibraryItem[] =>
        (body.Items ?? []).flatMap((item): EmbyLibraryItem[] => {
          const id = typeof item.Id === "string" ? item.Id : "";
          const type = item.Type === "Movie" ? "movie" : item.Type === "Series" ? "tv" : null;
          const name = typeof item.Name === "string" ? item.Name : "";
          if (!id || !type || !name) return [];
          const itemYear = Number.isFinite(Number(item.ProductionYear)) ? Number(item.ProductionYear) : null;
          // 标题搜索时做客户端年份/标题过滤，避免 Emby 模糊搜索把无关项带回来。
          if (titleNorm && norm(name) !== titleNorm) {
            if (!norm(name).includes(titleNorm) && !titleNorm.includes(norm(name))) return [];
          }
          if (year && itemYear && itemYear !== year) return [];
          const rawTmdb = item.ProviderIds?.Tmdb;
          const tmdbId = typeof rawTmdb === "string" ? Number(rawTmdb) : typeof rawTmdb === "number" ? rawTmdb : null;
          return [{ id, name, year: itemYear, type, tmdbId: Number.isInteger(tmdbId) ? tmdbId : null }];
        });
      const queryItems = async (includeProviderFilter: boolean) => {
        const params = new URLSearchParams({
          Recursive: "true",
          IncludeItemTypes:
            query.mediaType === "movie" ? "Movie" : query.mediaType === "tv" ? "Series" : "Movie,Series",
          Fields: "ProviderIds,ProductionYear",
          Limit: "50",
        });
        if (includeProviderFilter && query.tmdbId) params.set("AnyProviderIdEquals", `Tmdb.${query.tmdbId}`);
        if (query.title) params.set("SearchTerm", query.title.trim());
        const body = (await get("/Items", params)) as {
          Items?: Array<{
            Id?: unknown;
            Name?: unknown;
            Type?: unknown;
            ProductionYear?: unknown;
            ProviderIds?: Record<string, unknown>;
          }>;
        };
        return toItems(body);
      };
      // 优先按 TMDB ProviderId 精确查；很多 STRM/网盘条目没有 Tmdb id，查不到则按标题回退。
      let items = await queryItems(true);
      if (!items.length && query.title) items = await queryItems(false);
      return items;
    },
    listLibraryFolders: async () => {
      const body = (await get("/Library/VirtualFolders")) as Array<{
        ItemId?: unknown;
        Name?: unknown;
        CollectionType?: unknown;
        Locations?: unknown;
      }>;
      if (!Array.isArray(body)) return [];
      return body.flatMap((folder): EmbyLibraryFolder[] => {
        const id = typeof folder.ItemId === "string" ? folder.ItemId : "";
        const name = typeof folder.Name === "string" ? folder.Name : "";
        if (!id || !name) return [];
        // Emby 对"混合内容"库可能不给 CollectionType；按 mixed 处理，交给上层按条目类型判断。
        const raw = typeof folder.CollectionType === "string" ? folder.CollectionType.toLowerCase() : "";
        const collectionType: EmbyLibraryFolder["collectionType"] =
          raw === "movies" ? "movies" : raw === "tvshows" ? "tvshows" : "mixed";
        const locations = Array.isArray(folder.Locations)
          ? folder.Locations.filter((item): item is string => typeof item === "string")
          : [];
        return [{ id, name, collectionType, locations }];
      });
    },
    ...createEmbyLibraryReader((params) => get("/Items", params)),
    deleteItem: async (itemId) => {
      await request("DELETE", `/Items/${encodeURIComponent(itemId)}`);
    },
    listSeasons: async (seriesId) => {
      const body = (await get(
        "/Items",
        new URLSearchParams({
          ParentId: seriesId,
          IncludeItemTypes: "Season",
          Recursive: "false",
          Fields: "IndexNumber",
        }),
      )) as { Items?: Array<{ Id?: unknown; Name?: unknown; IndexNumber?: number }> };
      return (body.Items ?? []).flatMap((season) => {
        if (typeof season.Id !== "string" || !season.Id) return [];
        return [
          {
            id: season.Id,
            seasonNumber: Number.isInteger(season.IndexNumber) ? season.IndexNumber! : null,
            name: typeof season.Name === "string" ? season.Name : "",
          },
        ];
      });
    },
    refreshLibrary: async () => {
      const { baseUrl, apiKey } = credentials();
      if (!baseUrl || !apiKey) return false;
      try {
        const response = await fetch(`${baseUrl}/emby/Library/Refresh`, {
          method: "POST",
          headers: { "X-Emby-Token": apiKey },
          signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok) discardBody(response);
        return response.ok;
      } catch {
        // 刷新失败不该让入库流程失败：Emby 自己的定时扫描仍会捡到新文件。
        return false;
      }
    },
    image: async (itemId, size = "Primary", signal) => {
      const { baseUrl, apiKey } = credentials();
      if (!baseUrl || !apiKey) return null;
      try {
        return await fetchImage(
          `${baseUrl}/emby/Items/${encodeURIComponent(itemId)}/Images/${size}?maxWidth=300&quality=90`,
          {
            headers: { "X-Emby-Token": apiKey },
            signal,
            timeoutMs: 15_000,
            allowUrl: (value) => new URL(value).origin === new URL(baseUrl).origin,
          },
        );
      } catch {
        return null;
      }
    },
  };
}
