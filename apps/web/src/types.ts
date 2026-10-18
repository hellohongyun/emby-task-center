// P2：前后端共享契约的单一真源在 @emby-task-center/contracts，前端只做转发导出，
// 避免两端各写一份 "movie" | "tv" 后逐渐漂移。其余仅供前端使用的类型仍留在本文件。
import type { MediaType, RootMediaType } from "@emby-task-center/contracts/media";

export type { MediaType, RootMediaType };
/** 追更（follow）已整体下线：任务只剩"完结入库"这一类。 */
export type TaskType = "ingest";
export type TaskStatus = "pending" | "claimed" | "running" | "completed" | "failed" | "cancelled";
/** 胶囊筛选按钮的一项（P4：原定义在 FilterChipRow.vue 里，服务器 tsc 读不了 .vue 的导出）。 */
export interface FilterOption {
  value: string;
  label: string;
}

export type AppView =
  | "home"
  | "tasks"
  | "missingEpisodes"
  | "library"
  | "virtualLibraries"
  | "system"
  | "logs"
  | "config"
  | "submissions"
  | "cardKeys";

/** 配置项来源：db=后台已保存，env=首次启动从环境变量种子导入，default=注册表默认值。 */
export type SettingSource = "db" | "env" | "default";

/** 后台配置页的单项（密钥只回掩码，value 恒为 "****"）。 */
export interface PublicSettingEntry {
  key: string;
  group: string;
  label: string;
  help?: string;
  /** 枚举/多选候选（配置页据此渲染开关）。 */
  choices?: ReadonlyArray<{ value: string; label: string; help?: string }>;
  /** 多行长文本（邮件正文、会员端提示文案）：渲染成 textarea，而不是一行 input。 */
  multiline?: boolean;
  secret: boolean;
  hasValue: boolean;
  source: SettingSource;
  value: unknown;
}

export interface SettingsGroup {
  group: string;
  label: string;
  settings: PublicSettingEntry[];
}

export interface SettingsPayload {
  groups: SettingsGroup[];
  admin: { username: string; hasPassword: boolean; mustChangePassword: boolean };
  warnings: string[];
}

export type MemberStatus = "active" | "expiring" | "expired" | "none";

export interface DashboardSummary {
  tasks: { total: number; pending: number; processing: number; completed: number; failed: number };
  library: { roots: number; items: number; matched: number; unmatched: number };
  members: { total: number; active: number; expiring: number; expired: number; concurrencyActive: number };
  recentTasks: Array<{
    id: number;
    title: string;
    mediaType: string;
    taskType: string;
    status: string;
    updatedAt: string;
  }>;
}

export interface SubmissionUser {
  id: number;
  email: string;
  enabled: boolean;
  subscriptionExpiresAt: string | null;
  embyUsername: string | null;
  embyUserId: string | null;
  embyMaxStreams: number | null;
  note: string | null;
  /** 每日投稿入库额度（管理员后台设置）。 */
  processPerDay: number;
  /** 首批投稿入库额度（管理员后台设置）。 */
  processFirstBatch: number;
  status: MemberStatus;
  concurrency: ConcurrencyMemberStatus;
  createdAt: string;
  updatedAt: string;
}

export interface ConcurrencyMemberStatus {
  overshooting: boolean;
  notified: boolean;
  disabled: boolean;
  disabledUntil: string | null;
  remainingMs: number | null;
}

export interface EmbyUserRow {
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

/** 会话正在播放的条目（剧集带季集号）。 */
export interface EmbyPlaybackItem {
  id: string | null;
  title: string;
  episodeTitle: string | null;
  type: string | null;
  seasonNumber: number | null;
  episodeNumber: number | null;
  /** "诛仙 S4E4 · 镇魔古洞"。 */
  displayTitle: string;
  /** "第 4 季 第 4 集"。 */
  episodeLabel: string | null;
}

/** 转码详情（只有真转码时才有）。 */
export interface EmbyPlaybackTranscoding {
  videoCodec: string | null;
  audioCodec: string | null;
  container: string | null;
  bitrate: number | null;
  width: number | null;
  height: number | null;
  audioChannels: number | null;
  framerate: number | null;
  hardwareAcceleration: string | null;
  reasons: string[];
  reasonsLabel: string;
}

/** 在线会话详情（对齐 Emby 客户端的播放状态面板）。 */
export interface EmbySessionRow {
  id: string;
  userId: string | null;
  userName: string | null;
  deviceName: string | null;
  deviceId: string | null;
  client: string | null;
  applicationVersion: string | null;
  /** 客户端来源地址（IP:端口）。 */
  remoteAddress: string | null;
  /** Emby 记录的会话最后活动时间。 */
  lastActivityDate: string | null;
  item: EmbyPlaybackItem | null;
  nowPlaying: string | null;
  nowPlayingType: string | null;
  runTimeTicks: number | null;
  positionTicks: number | null;
  positionText: string | null;
  runTimeText: string | null;
  isPaused: boolean;
  playMethod: string | null;
  /** 直接播放 / 直接串流 / 转码。 */
  playMethodLabel: string;
  /** 进度百分比；**null = 总时长未知**（Emby 没给 RunTimeTicks，算不出百分比），不是 0%。 */
  progressPercent: number | null;
  /** MKV / MP4。 */
  container: string | null;
  bitrate: number | null;
  bitrateText: string | null;
  mediaSourceName: string | null;
  /** "4K HEVC"。 */
  videoLabel: string | null;
  videoDirect: boolean | null;
  /** "Chinese EAC3 stereo (默认)"。 */
  audioLabel: string | null;
  audioDirect: boolean | null;
  audioStreams: string[];
  subtitleLabel: string | null;
  transcoding: EmbyPlaybackTranscoding | null;
  isPlaying: boolean;
}

/** 使用记录：某会员在某一天的使用情况。 */
export interface UsageDailyPoint {
  date: string;
  playMinutes: number;
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

/** 使用记录：单个会员在窗口内的汇总（24 个时段桶按本地时间）。 */
export interface UsageMemberSummary {
  key: string;
  email: string | null;
  embyUserId: string | null;
  userName: string | null;
  lastLoginAt: string | null;
  lastPlayAt: string | null;
  loginCount: number;
  plays: number;
  playMinutes: number;
  idleMinutes: number;
  activeDays: number;
  hourly: number[];
  daily: UsageDailyPoint[];
  topItems: UsageItemStat[];
}

export interface UsageOverview {
  range: { days: number; from: string; to: string };
  generatedAt: string;
  totals: {
    activeMembers: number;
    knownMembers: number;
    logins: number;
    plays: number;
    playHours: number;
    devices: number;
  };
  hourly: number[];
  members: UsageMemberSummary[];
}

/** 使用记录：单会员详情（时间线 + 日期×小时热力图）。 */
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
  heatmap: Array<{ date: string; hours: number[] }>;
  recentItems: UsageItemStat[];
}

/** 使用记录：立刻采样 + 回填活动日志的返回。 */
export interface UsageRefreshResult {
  sampled: { observed: number; opened: number; extended: number; closed: number; events: number };
  activity: { fetched: number; inserted: number; unknown: number; unsupported: boolean };
}

/** 媒体库归属的一项：库里这部作品的落点（看板「媒体库」列）。 */
export interface TaskLibrarySource {
  /** 库根 id：Emby 模式下就是 Emby 库 Id。 */
  rootId: string;
  /** 媒体库显示名（Emby 库名，例如「剧集」「动漫」）。 */
  name: string;
  mediaType: RootMediaType;
  /** 该库里去重后的已存集数（电影没有逐集明细，恒为 0，用 fileCount 判断是否已入库）。 */
  episodeCount: number;
  /** 该库内这部作品的文件条目数（电影 = 1）。 */
  fileCount: number;
  /** 该库里有集数的季号（电影为空数组）。 */
  seasons: number[];
  /** 该库内的作品目录（相对库根；作品直接放在库根下时为空串）。 */
  path: string;
}

/** 分季的媒体库归属：这一季存在哪个库、在该库里哪个目录、存了几集。 */
export interface TaskSeasonLibrary {
  rootId: string;
  name: string;
  mediaType: RootMediaType;
  episodeCount: number;
  /** 这一季在该库里的目录（例如 "Dark/Season 01"）。 */
  path: string;
}

/** 剧集追踪的分季行（GET /api/tasks 返回）。 */
export interface TaskSeasonRow {
  seasonNumber: number;
  status: "tracking" | "finished";
  airProgress: number | null;
  /** 已播出、仍在宽限期内（默认=今日更新）的集数：不算缺集。 */
  airPendingProgress?: number | null;
  storedProgress: number | null;
  lastCheckedAt: string | null;
  /** 已播之后还没入库的集号（缺哪几集）。 */
  missingEpisodes: number[];
  /** 宽限期内（默认=今日更新）的集号：只提示，不算缺集。 */
  pendingEpisodes?: number[];
  /**
   * 该季是否参与缺集比对。媒体库有逐集明细、但这一季没有记录时（TMDB 与 Emby 的季划分
   * 对不上）为 false：不臆造缺集，也不计入合计。
   */
  aligned?: boolean;
  /** 这一季的已存分别在哪些媒体库（同一季可能同时存在多个库）。 */
  libraries?: TaskSeasonLibrary[];
}

/** 季号对不上、被排除在合计之外的季。 */
export interface TaskUnmatchedSeason {
  seasonNumber: number;
  airedEpisodes: number;
}

/** 缺集总览里的一集（GET /api/missing-episodes）。 */
export interface MissingEpisode {
  episodeNumber: number;
  /** TMDB 集名（zh-CN）；TMDB 拿不到时为 null，界面只显示集号。 */
  name: string | null;
  airDate: string | null;
}

/** 缺集总览里的一季：缺了哪几集、这一季落在哪个库。 */
export interface MissingEpisodesSeason {
  seasonNumber: number;
  /** TMDB 该季已播集数。 */
  aired: number;
  /** 库内该季已存集数。 */
  stored: number;
  libraries: TaskSeasonLibrary[];
  episodes: MissingEpisode[];
  /** 该季在 Emby 的季条目 Id（「在 Emby 查看」跳转用；旧快照可能没有）。 */
  embySeasonId?: string | null;
  /** 按当前库解析后跳转的同源链接，不包含上游凭据。 */
  embyUrl?: string | null;
}

/** 编号体系疑似不一致、未判定缺集的季（例如 TVDB 半集合并 vs TMDB 分段）。 */
export interface MissingEpisodeSuspectSeason {
  seasonNumber: number;
  aired: number;
  stored: number;
}

/**
 * 宽限期内（默认=今日更新）还没入库的季：暂不计缺集，页面单独标「今日更新」。
 *
 * 为什么要有这一档：TMDB 的 air_date 只有日期，"今天 18 点更新"从 00:00 起就算已播，
 * 而片源晚上才入库——按旧口径白天会看到假的缺集。
 */
export interface MissingEpisodePendingSeason {
  seasonNumber: number;
  episodes: MissingEpisode[];
  /** 该季在 Emby 的季条目 Id（跳转用；旧快照可能没有）。 */
  embySeasonId?: string | null;
}

/** 缺集总览里的一部剧（全库扫描快照，不依赖任务中心是否建过任务）。 */
export interface MissingEpisodesShow {
  /** 媒体条目 id（media_items.id）；删除时用它。 */
  mediaItemId: number;
  tmdbId: number | null;
  title: string;
  posterUrl: string | null;
  airProgress: number | null;
  storedProgress: number | null;
  missingCount: number;
  /** 宽限期内（默认=今日更新）还没入库的集数：只提示，不计缺集。 */
  pendingCount: number;
  libraries: TaskLibrarySource[];
  unmatchedSeasons: TaskUnmatchedSeason[];
  /** 编号体系疑似不一致、未判定缺集的季（只提示，不计缺集）。 */
  suspectSeasons: MissingEpisodeSuspectSeason[];
  seasons: MissingEpisodesSeason[];
  /** 宽限期内（默认=今日更新）还没入库的集：只提示，不计缺集。 */
  pendingSeasons: MissingEpisodePendingSeason[];
  /** 该剧在 Emby 的剧集条目 Id（季 Id 缺失时跳转用）。 */
  embySeriesId?: string | null;
  embyUrl?: string | null;
  /** TMDB 暂时不可用但用了旧缓存重算时标记（界面提示集名/已播可能偏旧）。 */
  error?: string | null;
  metadata?: MissingMetadataHealth | null;
}

export interface MissingMetadataHealth {
  stale: true;
  error: "tmdb_unavailable" | "tmdb_partial_unavailable";
  failedSeasons: number[];
  unavailableSeasons: number[];
  lastCompleteAt: string | null;
  expiresAt: string | null;
  attemptedAt: string;
  retryAt: string;
}

export interface MissingMetadataIssue extends MissingMetadataHealth {
  mediaItemId: number;
  tmdbId: number | null;
  title: string;
}

/** 未纳入检测的一条：本地记录的 TMDB 与 Emby 实际登记的不一致（多为同名剧匹配错误）。 */
export interface MissingEpisodeMismatch {
  mediaItemId: number;
  title: string;
  /** 本地记录的 TMDB id（错了的那个）。 */
  tmdbId: number | null;
  /** Emby 里同名条目的剧集 Id（跳转用）。 */
  embySeriesId: string | null;
  /** Emby 条目实际登记的 TMDB id；Emby 未登记时为空。 */
  embyTmdbId: number | null;
}

/** 缺集总览接口的响应（GET /api/missing-episodes）。 */
export interface MissingEpisodesPayload {
  /** 当前启用媒体库的上游公开 ID；无启用库时为 null。 */
  rootId?: string | null;
  /** 库存读取失败或尚未扫描时，零缺集不能作为已齐结论。 */
  inventoryIssue?: "scan_failed" | "not_scanned" | null;
  /** 可切换的启用剧集库，包含当前没有缺集的库。 */
  libraries?: Array<{ rootId: string; name: string; mediaType?: string }>;
  generatedAt: string;
  /** 最近一轮全库检测的完成时间（null = 还没扫过）。 */
  lastScanAt: string | null;
  /** 后台是否正在跑全库检测。 */
  scanning: boolean;
  /** 检测进度（首次全量会比较久）。 */
  progress: { processed: number; total: number } | null;
  /** TMDB 标识与 Emby 实际不一致、未纳入检测的剧数。 */
  mismatchCount: number;
  /** 这些剧的明细（单独展示，不混进缺集清单）。 */
  mismatches: MissingEpisodeMismatch[];
  /** 「在 Emby 查看」跳转配置：网页地址 + serverId（未配置 Emby 时为 null）。 */
  emby: { webBaseUrl: string; serverId: string | null } | null;
  showCount: number;
  /** 只差"今日更新"、没有其它缺集的剧数（列在列表里，但不构成缺集、不参与批量删除）。 */
  pendingShowCount: number;
  episodeCount: number;
  /** 今日更新（宽限期内）的集数合计：只提示，不计入 episodeCount。 */
  pendingEpisodeCount: number;
  shows: MissingEpisodesShow[];
  metadataIssueCount?: number;
  metadataIssues?: MissingMetadataIssue[];
}

/** 批量删除的结果（POST /api/missing-episodes/delete）。 */
export interface MissingEpisodesDeleteResult {
  deleted: number;
  failed: number;
  results: Array<{
    mediaItemId: number;
    title: string;
    ok: boolean;
    embyItemIds: string[];
    error?: string;
  }>;
}

export interface Task {
  id: number;
  tmdbId: number | null;
  releaseYear?: number | null;
  mediaType: MediaType;
  title: string;
  taskType: TaskType;
  seasonNumber?: number | null;
  contentKind?: "series" | "variety" | null;
  status: TaskStatus;
  statusMessage: string | null;
  completedAt?: string | null;
  airProgress: number | null;
  /** 已播出、仍在宽限期内（默认=今日更新）的集数：不算缺集。 */
  airPendingProgress?: number | null;
  storedProgress: number | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  posterUrl?: string | null;
  aliases?: string[];
  scheduleDay?: number | null;
  scheduleDays?: number[] | null;
  sourceMode?: "auto" | "mapped";
  releaseDays?: number[];
  releaseTime?: string | null;
  scheduleTime?: string | null;
  createdSource?: string;
  mappedRootId?: string | null;
  mappedFolderPath?: string | null;
  /** 最近一次已播进度检查时刻（看板「最后检查」列）。 */
  lastCheckedAt?: string | null;
  /** 任务级缺集（已播之后还没入库的集号）。 */
  missingEpisodes?: number[];
  /** 任务级「今日更新」集号（宽限期内、不算缺集；仅 GET /api/tasks 返回）。 */
  pendingEpisodes?: number[];
  /** 分季进度（仅 GET /api/tasks 的列表返回；详情接口不带）。 */
  seasons?: TaskSeasonRow[];
  /** 媒体库归属：已存集数落在哪个库、库内哪个目录（仅 GET /api/tasks 返回；未入库为空数组）。 */
  libraries?: TaskLibrarySource[];
  /** 季号对不上、未纳入合计的季（看板会提示，避免"缺 N 集"看起来比实际大）。 */
  unmatchedSeasons?: TaskUnmatchedSeason[];
}

export interface TmdbSeason {
  seasonNumber: number;
  name: string | null;
  episodeCount: number;
  airDate: string | null;
}

export interface TmdbMedia {
  id: number;
  mediaType: MediaType;
  title: string;
  originalTitle: string;
  releaseYear: number | null;
  overview: string;
  posterUrl: string | null;
  backdropUrl: string | null;
  totalEpisodes?: number | null;
  seasons?: TmdbSeason[];
  airedEpisodes?: number | null;
}

export interface CreateTaskInput {
  mediaType: MediaType;
  taskType: TaskType;
  title: string;
  tmdbId: number;
  seasonNumber?: number | null;
  contentKind?: "series" | "variety" | null;
}

export interface LibraryRoot {
  id: string;
  name: string;
  mediaType: RootMediaType;
  lastScannedAt?: string | null;
  lastScanStatus?: string | null;
}

export interface LibraryIdentity {
  physicalSeason: number | null;
  parsedSeason: number | null;
  episodeNumbers: number[];
  absoluteEpisodeNumbers: number[];
  numberingMode: "seasonal" | "absolute" | "unresolved";
  warning: string | null;
}

export interface LibraryItem {
  id?: string;
  databaseId?: number;
  relativePath: string;
  sourceTitle?: string;
  sourceYear?: number | null;
  posterPath?: string | null;
  tags?: string[];
  recognitionStatus?: string;
  mediaItemId?: number | null;
  confidence?: number | null;
  genres?: string[];
  cast?: string[];
  /** 入库时间（Emby 的 DateCreated；STRM 时代为文件修改时间）——「最近入库」排序用。 */
  fileModifiedAt?: string | null;
  identity: LibraryIdentity;
}

export interface LibraryScan {
  root: LibraryRoot;
  items: LibraryItem[];
  scannedAt?: string;
}

export interface BatchDuplicate {
  title: string;
  tmdbId: number;
  reason: string;
}
export interface BatchCreateResponse {
  results: Array<{
    title: string;
    tmdbId: number;
    ok: boolean;
    created?: boolean;
    task?: { id: number; title: string };
    error?: string;
  }>;
  duplicates?: BatchDuplicate[];
  creatable?: Array<{ title: string; tmdbId: number }>;
}

export type LogLevel = "info" | "warn" | "error";
export type LogSource = "server" | "web";
export interface LogEntry {
  id: number;
  level: LogLevel;
  source: LogSource;
  message: string;
  method: string | null;
  path: string | null;
  status: number | null;
  durationMs: number | null;
  detail: string | null;
  createdAt: string;
}
