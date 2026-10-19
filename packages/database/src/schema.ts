import { sql } from "drizzle-orm";
import { check, index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { virtualLibraries, virtualLibraryItems, virtualLibraryPosters } from "./virtual-libraries-schema";
export { virtualLibraries, virtualLibraryItems, virtualLibraryPosters } from "./virtual-libraries-schema";

const mediaTypes = ["movie", "tv"] as const;
const rootMediaTypes = ["movie", "tv", "mixed"] as const;
const taskTypes = ["ingest"] as const;
const taskStatuses = ["pending", "claimed", "running", "completed", "failed", "cancelled"] as const;
const logLevels = ["info", "warn", "error"] as const;
const logSources = ["server", "web", "mcp"] as const;
/** 使用记录事件类型：登录/开播/结束播放/断开连接/其它 Emby 活动。 */
const usageEventKinds = ["login", "play_start", "play_stop", "session_end", "other"] as const;
/** 使用记录来源：应用采样 / Emby 活动日志回填。 */
const usageEventSources = ["sampler", "activity_log"] as const;
/** 使用区间类型：在播 / 挂着（连着但没播）。 */
const usageSegmentKinds = ["play", "idle"] as const;

export const mediaItems = sqliteTable(
  "media_items",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    tmdbId: integer("tmdb_id"),
    mediaType: text("media_type", { enum: mediaTypes }).notNull(),
    title: text("title").notNull(),
    originalTitle: text("original_title"),
    aliases: text("aliases_json", { mode: "json" })
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'`),
    releaseYear: integer("release_year"),
    overview: text("overview"),
    posterUrl: text("poster_url"),
    backdropUrl: text("backdrop_url"),
    genres: text("genres_json", { mode: "json" })
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'`),
    languages: text("languages_json", { mode: "json" })
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'`),
    regions: text("regions_json", { mode: "json" })
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'`),
    platforms: text("platforms_json", { mode: "json" })
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'`),
    seasonCount: integer("season_count"),
    episodeCount: integer("episode_count"),
    mappedRootId: text("mapped_root_id"),
    mappedFolderPath: text("mapped_folder_path"),
    imdbId: text("imdb_id"),
    doubanId: text("douban_id"),
    externalIds: text("external_ids_json", { mode: "json" })
      .$type<Record<string, string>>()
      .notNull()
      .default(sql`'{}'`),
    tmdbPayload: text("tmdb_payload_json", { mode: "json" })
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'`),
    syncedAt: text("synced_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("media_items_identity_idx").on(table.mediaType, table.tmdbId),
    check("media_items_type_check", sql`${table.mediaType} IN ('movie', 'tv')`),
  ],
);

export const mediaTasks = sqliteTable(
  "media_tasks",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    mediaItemId: integer("media_item_id")
      .notNull()
      .references(() => mediaItems.id),
    taskType: text("task_type", { enum: taskTypes }).notNull(),
    seasonNumber: integer("season_number"),
    /** 完结入库内容类型：series=剧集完结 / variety=综艺完结（仅 TV + ingest 有值）。 */
    contentKind: text("content_kind", { enum: ["series", "variety"] }),
    airProgress: integer("air_progress"),
    /** 已播出、仍在宽限期内（默认=今日更新）的集数：不计缺集，看板标「今日更新」。见 task_seasons.air_pending_progress。 */
    airPendingProgress: integer("air_pending_progress"),
    storedProgress: integer("stored_progress"),
    sourceMode: text("source_mode", { enum: ["auto", "mapped"] })
      .notNull()
      .default("auto"),
    scheduleDay: integer("schedule_day"),
    scheduleDays: text("schedule_days", { mode: "json" }).$type<number[] | null>(),
    scheduleTime: text("schedule_time"),
    scheduleAppliedKey: text("schedule_applied_key"),
    status: text("status", { enum: taskStatuses }).notNull(),
    statusMessage: text("status_message"),
    priority: integer("priority").notNull().default(0),
    createdSource: text("created_source").notNull().default("unknown"),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: text("lease_expires_at"),
    lastCheckedAt: text("last_checked_at"),
    version: integer("version").notNull().default(1),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    /** 任务完成时刻（仅 completed 状态有值；用于已入库电影 24 小时自动清理倒计时）。 */
    completedAt: text("completed_at"),
    /** 内容回收：最近一次被播放的时刻（从 Emby 会话读取）。 */
    lastPlayedAt: text("last_played_at"),
    /** 内容回收：被"看完"的时刻（手动标记 或 最后一集进度≥80% 自动判定）。 */
    watchedFinishedAt: text("watched_finished_at"),
    /** 内容回收：管理员在回收站确认已删除/已回收的时刻（非空则从回收列表移除）。 */
    recycledAt: text("recycled_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    // 'follow' 仍留在 CHECK 里：SQLite 改不了 CHECK 约束，改它只能重建 media_tasks 表（含外键与索引），
    // 而追更行已由 reconcile 的幂等清理删除，应用层也再无写入方，留个更宽的约束无害。
    check("media_tasks_type_check", sql`${table.taskType} IN ('ingest', 'follow')`),
    check(
      "media_tasks_status_check",
      sql`${table.status} IN ('pending', 'claimed', 'running', 'completed', 'failed', 'cancelled')`,
    ),
  ],
);

/** 并发超限升级策略（单行）：超限后几小时提醒邮件、几分钟后停用、停用时长为小时；adminEmail 为管理员抄送。 */
export const concurrencyPolicySettings = sqliteTable("concurrency_policy_settings", {
  id: integer("id").primaryKey(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  remindAfterMinutes: integer("remind_after_minutes").notNull().default(2),
  disableAfterMinutes: integer("disable_after_minutes").notNull().default(5),
  disableForHours: integer("disable_for_hours").notNull().default(1),
  adminEmail: text("admin_email"),
  updatedAt: text("updated_at").notNull(),
});

/** 每会员的并发超限升级状态（谁超了、累计超限多久、是否已提醒、停用到期）。 */
export const concurrencyEscalationState = sqliteTable("concurrency_escalation_state", {
  memberId: integer("member_id").primaryKey(),
  /** 上一次「确认超限」的采样时刻；null = 当前这一档不在超限（累计值仍保留）。 */
  overshootSince: text("overshoot_since"),
  /**
   * 累计超限时长（毫秒）：违规时按采样间隔累加，合规时**不清零**，冻结/解冻后归零。
   * 详见 concurrency-escalation.ts 的「触发式累计」说明。
   */
  overshootMs: integer("overshoot_ms").notNull().default(0),
  notifiedAt: text("notified_at"),
  disabledUntil: text("disabled_until"),
  /**
   * 会员自助解冻的「申请时刻」：在门户点开解冻弹窗时写入，服务端按它校验强制等待时长
   * （只看前端倒计时等于没等，改接口就能绕过）。冻结/解冻后一律清空。
   */
  unfreezeRequestedAt: text("unfreeze_requested_at"),
  updatedAt: text("updated_at").notNull(),
});

/**
 * 会员自助解冻流水（每成功一次一行）：每月次数上限按自然月统计，
 * 同时是「谁在冻结期内自己放了行」的留痕（审计日志还有一条 member.self_unfreeze）。
 */
export const memberUnfreezeEvents = sqliteTable(
  "member_unfreeze_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    memberId: integer("member_id").notNull(),
    email: text("email").notNull(),
    /** 自然月键（YYYY-MM，服务器本地时区）：次数上限按它统计。 */
    month: text("month").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [index("member_unfreeze_events_member_month_idx").on(table.memberId, table.month)],
);

// task_notification_recipients / global_notification_recipients 两张收件人表随
// 「任务更新通知」整条链删除（2026-09）：那条邮件链已经没有发送方，谁也不会再读它们
// （与站内通知中心不同——那不是"留表不读写"，而是整条链连发送方一起没了）。
// 老库里的表由 reconcile.ts 丢掉，见那里的 DROP TABLE。
export const taskRuns = sqliteTable("task_runs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  taskId: integer("task_id")
    .notNull()
    .references(() => mediaTasks.id),
  workerId: text("worker_id"),
  phase: text("phase").notNull(),
  startedAt: text("started_at").notNull(),
  finishedAt: text("finished_at"),
  summary: text("summary"),
  error: text("error"),
  beforeStatus: text("before_status", { enum: taskStatuses }),
  afterStatus: text("after_status", { enum: taskStatuses }),
});

export const mediaRoots = sqliteTable("media_roots", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull().unique(),
  mediaType: text("media_type", { enum: rootMediaTypes }).notNull(),
  containerPath: text("container_path").notNull().unique(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  lastScanStatus: text("last_scan_status"),
  lastScannedAt: text("last_scanned_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const libraryItems = sqliteTable(
  "library_items",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    mediaRootId: integer("media_root_id")
      .notNull()
      .references(() => mediaRoots.id),
    mediaItemId: integer("media_item_id").references(() => mediaItems.id),
    relativePath: text("relative_path").notNull(),
    /**
     * Emby 条目 Id（媒体库改由 Emby 驱动后的**真正身份**）。
     * relativePath 是合成出来的展示字段：作品改名、Emby 重新整理后它会变，
     * 用路径认条目会导致"同一部作品被当成新条目 + 旧行被删"。
     */
    embyItemId: text("emby_item_id"),
    sourceTitle: text("source_title").notNull().default(""),
    sourceYear: integer("source_year"),
    posterPath: text("poster_path"),
    /** 题材（Emby 直接提供；STRM 时代来自 TMDB 匹配结果）。 */
    genres: text("genres_json", { mode: "json" })
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'`),
    tags: text("tags_json", { mode: "json" })
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'`),
    /** 片源质量（1080P/4K 等）。 */
    quality: text("quality"),
    /** 片源提供方（网盘/Emby/共享/其他）。 */
    sourceProvider: text("source_provider"),
    /** 字幕语言列表。 */
    subtitleLangs: text("subtitle_langs_json", { mode: "json" })
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'`),
    /** 本地海报缓存路径（外链失效兜底）。 */
    posterCachePath: text("poster_cache_path"),
    confidence: real("confidence"),
    recognitionStatus: text("recognition_status").notNull().default("unresolved"),
    fileModifiedAt: text("file_modified_at"),
    scanWarning: text("scan_warning"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("library_items_path_idx").on(table.mediaRootId, table.relativePath),
    index("library_items_media_item_idx").on(table.mediaItemId),
  ],
);

export const libraryEpisodes = sqliteTable(
  "library_episodes",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    libraryItemId: integer("library_item_id")
      .notNull()
      .references(() => libraryItems.id),
    physicalSeason: integer("physical_season"),
    parsedSeason: integer("parsed_season"),
    episodeNumber: integer("episode_number"),
    absoluteEpisodeNumber: integer("absolute_episode_number"),
    numberingMode: text("numbering_mode").notNull().default("unresolved"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("library_episodes_identity_idx").on(
      table.libraryItemId,
      table.parsedSeason,
      table.episodeNumber,
      table.absoluteEpisodeNumber,
    ),
  ],
);

/** 缺集快照里的一集（集名/上映日来自 TMDB；是否已入库由逐集比对算出）。 */
export interface MissingEpisodeEntry {
  episodeNumber: number;
  name: string | null;
  airDate: string | null;
}

/** 缺集快照里的一季：缺了哪几集、该季已播/已存多少。 */
export interface MissingEpisodeSeasonSnapshot {
  seasonNumber: number;
  aired: number;
  stored: number;
  episodes: MissingEpisodeEntry[];
}

/**
 * 已播出、但仍在"等待入库"宽限期内、**暂不计缺集**的季（默认=今日更新的那一集）。
 *
 * 为什么要单独一档：TMDB 的 air_date 只有日期没有时刻，当天 18 点更新的集从 00:00 起就算"已播"，
 * 而片源要到晚上才入库；按旧口径白天就会报缺集（实测 8 点看到"缺集"是误报）。
 * 这些集推到宽限期结束（默认次日 0 点）仍没入库，就会自动落进 missing。
 */
export interface MissingEpisodePendingSeason {
  seasonNumber: number;
  /** 该季在宽限期内、暂不计缺集的集（含集名与播出日，页面直接展示）。 */
  episodes: MissingEpisodeEntry[];
}

/** 季号对不上、未纳入缺集比对的季（与任务看板同一口径）。 */
export interface MissingEpisodeUnmatchedSeason {
  seasonNumber: number;
  airedEpisodes: number;
}

/**
 * 编号体系疑似不一致、未判定缺集的季。
 *
 * 典型：TVDB/Emby 把半集合并成一条（库内每季 20 集），TMDB 按分段列两倍（41 集），
 * 直接相减会把后一半全算成缺集。这种季只提示、不报缺集，由用户人工判断。
 */
export interface MissingEpisodeSuspectSeason {
  seasonNumber: number;
  aired: number;
  stored: number;
}

/** TMDB 季/集缓存项（缺集比对与集名展示共用；跨重启复用，避免每次重扫都打 TMDB）。 */
export interface TmdbSeasonEpisodesCache {
  seasonNumber: number;
  episodes: MissingEpisodeEntry[];
  /** 单季最后成功时间；旧缓存缺此字段时回落整剧 fetchedAt。 */
  fetchedAt?: string | null;
  refreshFailedAt?: string;
  retryAt?: string;
  refreshError?: "tmdb_unavailable" | "tmdb_season_unavailable";
  /** 这一季从未拿到可用分集，空数组不得解释为已齐。 */
  unavailable?: boolean;
}

/** Emby 季条目引用：缺集总览「在 Emby 查看」按季跳转需要（季号 → Emby 季 Id）。 */
export interface EmbySeasonRef {
  seasonNumber: number;
  id: string;
}

/**
 * 全库缺集快照（缺集总览）：每部已入库剧集一行，由后台扫描器定时更新。
 *
 * - `tmdbSeasons` 缓存 TMDB 的季/集列表（含集名与上映日）：只要它没到刷新期，每小时重算缺集
 *   只用本地数据，不必再打 TMDB；
 * - `missing` 是按"当前库内已存集号"算出的缺集明细，页面直接读它。
 */
export const missingEpisodeSnapshots = sqliteTable("missing_episode_snapshots", {
  mediaItemId: integer("media_item_id")
    .primaryKey()
    .references(() => mediaItems.id),
  tmdbId: integer("tmdb_id"),
  title: text("title").notNull(),
  /** 这部剧在 Emby 的剧集条目 Id（跳转用；同名多个条目时取第一个）。 */
  embySeriesId: text("emby_series_id"),
  /** Emby 条目实际登记的 TMDB Id：与本地记录的 TMDB id 不一致时（emby_tmdb_mismatch）展示用。 */
  embyTmdbId: integer("emby_tmdb_id"),
  /** 季号 → Emby 季条目 Id（缺集总览「在 Emby 查看」按季跳转用）。 */
  embySeasons: text("emby_seasons_json", { mode: "json" })
    .$type<EmbySeasonRef[]>()
    .notNull()
    .default(sql`'[]'`),
  tmdbSeasons: text("tmdb_seasons_json", { mode: "json" })
    .$type<TmdbSeasonEpisodesCache[]>()
    .notNull()
    .default(sql`'[]'`),
  fetchedAt: text("fetched_at"),
  missing: text("missing_json", { mode: "json" })
    .$type<MissingEpisodeSeasonSnapshot[]>()
    .notNull()
    .default(sql`'[]'`),
  unmatchedSeasons: text("unmatched_seasons_json", { mode: "json" })
    .$type<MissingEpisodeUnmatchedSeason[]>()
    .notNull()
    .default(sql`'[]'`),
  /** 编号体系疑似不一致、未判定缺集的季（例如 TVDB 半集合并 vs TMDB 分段）。 */
  suspectSeasons: text("suspect_seasons_json", { mode: "json" })
    .$type<MissingEpisodeSuspectSeason[]>()
    .notNull()
    .default(sql`'[]'`),
  /** 已播出、仍在宽限期内（默认=今日更新）还没入库的集：暂不计缺集，页面单独标「今日更新」。 */
  pendingSeasons: text("pending_seasons_json", { mode: "json" })
    .$type<MissingEpisodePendingSeason[]>()
    .notNull()
    .default(sql`'[]'`),
  airedCount: integer("aired_count").notNull().default(0),
  storedCount: integer("stored_count").notNull().default(0),
  missingCount: integer("missing_count").notNull().default(0),
  error: text("error"),
  scannedAt: text("scanned_at").notNull(),
});

export const libraryScanRuns = sqliteTable("library_scan_runs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  mediaRootId: integer("media_root_id")
    .notNull()
    .references(() => mediaRoots.id),
  startedAt: text("started_at").notNull(),
  finishedAt: text("finished_at"),
  discoveredCount: integer("discovered_count").notNull().default(0),
  unresolvedCount: integer("unresolved_count").notNull().default(0),
  warnings: text("warnings_json", { mode: "json" })
    .$type<string[]>()
    .notNull()
    .default(sql`'[]'`),
  error: text("error"),
});

export const logs = sqliteTable(
  "logs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    level: text("level", { enum: logLevels }).notNull(),
    source: text("source", { enum: logSources }).notNull(),
    message: text("message").notNull(),
    method: text("method"),
    path: text("path"),
    status: integer("status"),
    durationMs: integer("duration_ms"),
    detail: text("detail"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("logs_created_at_idx").on(table.createdAt),
    index("logs_level_id_idx").on(table.level, table.id),
    index("logs_source_id_idx").on(table.source, table.id),
    check("logs_level_check", sql`${table.level} IN ('info', 'warn', 'error')`),
    check("logs_source_check", sql`${table.source} IN ('server', 'web', 'mcp')`),
  ],
);

const submissionStatuses = ["pending", "converted", "rejected", "duplicate"] as const;

/** 投稿/会员用户：允许投稿的邮箱 + 会员到期时间 + 可选 Emby 用户（自动开户/到期停用）。 */
export const submissionUsers = sqliteTable("submission_users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  email: text("email").notNull().unique(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  /** 会员到期时间（ISO）；null 表示长期有效。 */
  subscriptionExpiresAt: text("subscription_expires_at"),
  /** 对应 Emby 用户名（兼容旧数据：仅用于提示，不自动调 Emby）。 */
  embyUsername: text("emby_username"),
  /** Emby 用户 Id（自动开户/到期停用/改密码的直接依据）。 */
  embyUserId: text("emby_user_id"),
  /** 该用户的 Emby 同时在线（并行播放）上限；null=不限制。 */
  embyMaxStreams: integer("emby_max_streams"),
  /** 每日自动入库额度（默认 2）。 */
  processPerDay: integer("process_per_day").notNull().default(2),
  /** 首次（首批）自动入库额度（默认 10）。 */
  processFirstBatch: integer("process_first_batch").notNull().default(10),
  /** 今日已用入库额度。 */
  processUsedToday: integer("process_used_today").notNull().default(0),
  /** 今日自然日（YYYY-MM-DD），跨天重置 processUsedToday。 */
  processLastDate: text("process_last_date"),
  /** 首批 10 个是否已用完；用完则后续每日按 processPerDay。 */
  processFirstBatchUsed: integer("process_first_batch_used", { mode: "boolean" }).notNull().default(false),
  note: text("note"),
  /**
   * 当前这份有效期的「到期时间名称」（由带 expiry_label 的自定义卡密写入）。
   *
   * 为什么冗余在会员行上而不是反查卡密：卡密可以被管理员删掉，反查会当场失效；
   * 而"用户应该看到哪个到期口径"是开通那一刻就定下的事实。
   * 用户侧所有页面与提醒邮件都优先显示它，为空才回落真实日期（见 docs/card-keys.md）。
   */
  membershipExpiryLabel: text("membership_expiry_label"),
  /** 会员到期提醒状态（'expiring'|'expired'），用于只提醒一次（续费后重置）。 */
  membershipReminderState: text("membership_reminder_state", { enum: ["expiring", "expired"] }),
  membershipRemindedAt: text("membership_reminded_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

const cardKinds = ["trial", "month", "year", "custom"] as const;
const cardStatuses = ["unused", "used", "copied"] as const;

/**
 * 卡密：管理后台创建，用户兑换后开通对应有效期会员，并可自动创建 Emby 用户。
 *
 * 两种有效期口径并存（向后兼容）：
 *  - `expiresAt` 有值（新卡，固定到期日）：兑换后会员**统一到期于该日期**，
 *    "国庆卡密"= 谁什么时候兑换都到国庆后那一天；已有会员取"原到期"与"卡到期"中较晚者。
 *  - `expiresAt` 为空（老卡）：沿用历史语义 "base + days 天"。
 */
export const cardKeys = sqliteTable(
  "card_keys",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    code: text("code").notNull().unique(),
    kind: text("kind", { enum: cardKinds }).notNull(),
    /** 兑换后增加的有效天数。固定到期日的卡存"生成日→到期日"的天数，仅作挂牌展示与兜底。 */
    days: integer("days").notNull(),
    /** 卡密名称（管理员 DIY），如"国庆节卡密""生日快乐卡密"；空则回落类型标签。 */
    name: text("name"),
    /** 固定到期日（ISO）。null = 老卡，走 "base + days" 语义。 */
    expiresAt: text("expires_at"),
    /** 到期时间名称（管理员 DIY），如"2027 年春节结束到期"；有值时用户侧优先显示它。 */
    expiryLabel: text("expiry_label"),
    /** 彩蛋祝福文案：用户点"验证卡密"成功时弹窗展示；空则不弹窗（不用通用话术糊弄）。 */
    blessing: text("blessing"),
    status: text("status", { enum: cardStatuses }).notNull().default("unused"),
    usedByEmail: text("used_by_email"),
    usedAt: text("used_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    check("card_keys_kind_check", sql`${table.kind} IN ('trial', 'month', 'year', 'custom')`),
    check("card_keys_status_check", sql`${table.status} IN ('unused', 'used', 'copied')`),
  ],
);

/** 邮箱验证码（一次性，用于新用户开通/老用户登录）。 */
export const verificationCodes = sqliteTable("verification_codes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  email: text("email").notNull(),
  code: text("code").notNull(),
  expiresAt: text("expires_at").notNull(),
  consumed: integer("consumed", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at").notNull(),
});

/** 用户投稿请求：匿名邮箱识别 + 管理员审批转为任务。 */
export const movieSubmissions = sqliteTable(
  "movie_submissions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    submitterEmail: text("submitter_email").notNull(),
    title: text("title").notNull(),
    releaseYear: integer("release_year"),
    mediaType: text("media_type", { enum: ["movie", "tv"] }).notNull(),
    contentKind: text("content_kind", { enum: ["series", "variety"] }),
    tmdbId: integer("tmdb_id"),
    tmdbPayload: text("tmdb_payload_json", { mode: "json" })
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'`),
    /** 用户指定要入库的剧集分季（数字数组，空=全部季）。 */
    requestedSeasons: text("requested_seasons_json", { mode: "json" })
      .$type<number[]>()
      .notNull()
      .default(sql`'[]'`),
    /** 用户选择的自动入库任务类型：追更(follow) 已下线（2026-09），只剩完结入库(ingest)。 */
    taskType: text("task_type", { enum: ["ingest"] }),
    /** 来源平台（腾讯视频/爱奇艺/优酷/哔哩哔哩/其他），可空。 */
    platform: text("platform"),
    /** 期望画质（1080P/4K 等），可空。 */
    expectedQuality: text("expected_quality"),
    /** 求片队列优先级：数值越小越先处理（用户手动排序）。 */
    priority: integer("priority").notNull().default(0),
    note: text("note"),
    status: text("status", { enum: submissionStatuses }).notNull().default("pending"),
    convertedTaskId: integer("converted_task_id"),
    ip: text("ip"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    /** 入库完成邮件已发送时间（去重，每个投稿只提醒一次）。 */
    inLibraryNotifiedAt: text("in_library_notified_at"),
    // ── PanSou 投稿→自动入库：所选资源与入库状态（链接/口令仅服务端保存）──────────
    selectedUrl: text("selected_url"),
    selectedPassword: text("selected_password"),
    selectedPlatform: text("selected_platform"),
    selectedNote: text("selected_note"),
    selectedSource: text("selected_source"),
    selectedDisplayType: text("selected_display_type"),
    resourceId: text("resource_id"),
    /** 入库状态：pending→submitting→ingesting→processing→success/failed。 */
    ingestStatus: text("ingest_status"),
    ingestError: text("ingest_error"),
    /** 入库完成（Emby 已确认）后是否已发过完成邮件（一次性，避免重复）。 */
    ingestNotified: integer("ingest_notified", { mode: "boolean" }).notNull().default(false),
    /** 入库状态机阶段：submitted→saving→organizing→waiting_emby→success/failed。 */
    ingestStage: text("ingest_stage"),
    /** 阶段进入时间（ISO）。 */
    ingestStageAt: text("ingest_stage_at"),
  },
  (table) => [
    check("movie_submissions_status_check", sql`${table.status} IN ('pending', 'converted', 'rejected', 'duplicate')`),
  ],
);

/** PanSou 网盘/磁力启用开关（管理后台可调；未启用平台不显示、不参与回退）。 */
export const pansouPlatformSettings = sqliteTable("pansou_platform_settings", {
  platform: text("platform").primaryKey(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  sort: integer("sort").notNull().default(0),
  updatedAt: text("updated_at").notNull(),
});

/** 热点榜单来源配置（每 source 一行）：是否启用、缓存时长（分钟）、后台刷新间隔（分钟）。 */
export const trendingSourceConfigs = sqliteTable("trending_source_configs", {
  source: text("source").primaryKey(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  ttlMinutes: integer("ttl_minutes").notNull().default(60),
  refreshMinutes: integer("refresh_minutes").notNull().default(30),
  updatedAt: text("updated_at").notNull(),
});

/** 热点榜单快照（source+section_key 唯一）：持久化抓取结果，重启/降级时兜底。 */
export const trendingSnapshots = sqliteTable(
  "trending_snapshots",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    source: text("source").notNull(),
    sectionKey: text("section_key").notNull(),
    payload: text("payload").notNull(),
    fetchedAt: text("fetched_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [uniqueIndex("trending_snapshot_source_section_idx").on(table.source, table.sectionKey)],
);
export type TrendingSnapshotRow = typeof trendingSnapshots.$inferSelect;

/** 平台字典（腾讯/爱奇艺/优酷/B站/其他；门户「平台须知」与后续内容源对接用）。 */
export const platforms = sqliteTable("platforms", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  code: text("code").notNull().unique(),
  name: text("name").notNull(),
  logoUrl: text("logo_url"),
  homepage: text("homepage"),
  sort: integer("sort").notNull().default(0),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/** 投稿状态时间线：谁在何时把什么从 A 状态改到 B 状态。 */
export const submissionTimeline = sqliteTable("submission_timeline", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  submissionId: integer("submission_id").notNull(),
  fromStatus: text("from_status"),
  toStatus: text("to_status").notNull(),
  operator: text("operator").notNull().default("system"),
  note: text("note"),
  createdAt: text("created_at").notNull(),
});

/** 会员投稿额度流水：每次消耗/回填/管理员调整均可追溯。 */
export const quotaLedger = sqliteTable("quota_ledger", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  email: text("email").notNull(),
  type: text("type", { enum: ["submission", "reward", "rollback", "admin"] }).notNull(),
  amount: integer("amount").notNull(),
  submissionId: integer("submission_id"),
  note: text("note"),
  createdAt: text("created_at").notNull(),
});

/** 内容别名表：用于任务标题/来源名→媒体库匹配（可查询、可加权）。 */
export const mediaAliases = sqliteTable(
  "media_aliases",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    itemId: integer("item_id").notNull(),
    name: text("name").notNull(),
    lang: text("lang").notNull().default("zh"),
    /** 来源：auto=TMDB / manual=手动 / source=文件标题。 */
    source: text("source").notNull().default("auto"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [uniqueIndex("media_aliases_item_name_idx").on(table.itemId, table.name)],
);

/** 站内通知中心：投稿/追更/入库/临期均可查历史、标记已读。 */
export const userNotifications = sqliteTable(
  "user_notifications",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    email: text("email").notNull(),
    type: text("type").notNull(),
    title: text("title").notNull(),
    body: text("body"),
    link: text("link"),
    readAt: text("read_at"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [index("user_notifications_email_idx").on(table.email, table.id)],
);

/** 任务分季跟踪：一个任务可登记多季（完结入库任务按季看缺集）。 */
export const taskSeasons = sqliteTable(
  "task_seasons",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    taskId: integer("task_id").notNull(),
    seasonNumber: integer("season_number").notNull(),
    status: text("status", { enum: ["tracking", "finished"] })
      .notNull()
      .default("tracking"),
    airProgress: integer("air_progress"),
    /**
     * 已播出、但仍在"等待入库"宽限期内（默认口径 = 当天播出、次日 0 点前）的集数。
     *
     * 这些集**不算缺集**（当天 18 点更新、20 点才入库，白天看到"缺集"是误报），看板标「今日更新」。
     * 宽限期见设置项 `library.missingGraceHours`，判定见 apps/server/src/tmdb/client.ts 的 isEpisodeAiredEnough。
     */
    airPendingProgress: integer("air_pending_progress"),
    storedProgress: integer("stored_progress"),
    lastCheckAt: text("last_check_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [uniqueIndex("task_seasons_task_season_idx").on(table.taskId, table.seasonNumber)],
);

/** 站内通知保留期设置（单行）：提示类 / 重要类 / 其他（天）。 */
export const notifyRetentionSettings = sqliteTable("notify_retention_settings", {
  id: integer("id").primaryKey(),
  shortDays: integer("short_days").notNull().default(30),
  importantDays: integer("important_days").notNull().default(180),
  defaultDays: integer("default_days").notNull().default(120),
  updatedAt: text("updated_at").notNull(),
});

/** 平台说明/规范文章（管理端可编辑；用户端展示）。 */
export const contentArticles = sqliteTable("content_articles", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  code: text("code").notNull().unique(),
  title: text("title").notNull(),
  content: text("content").notNull().default(""),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  sort: integer("sort").notNull().default(0),
  /** 公告弹窗强制阅读秒数（0=可立即点击）。 */
  forceSeconds: integer("force_seconds").notNull().default(3),
  updatedAt: text("updated_at").notNull(),
});

/** 邮件默认发送设置（管理员全局默认；用户可按类型覆盖）。 */
export const mailDefaultSettings = sqliteTable("mail_default_settings", {
  id: integer("id").primaryKey(),
  submissionReceipt: integer("submission_receipt", { mode: "boolean" }).notNull().default(true),
  submissionConverted: integer("submission_converted", { mode: "boolean" }).notNull().default(true),
  submissionRejected: integer("submission_rejected", { mode: "boolean" }).notNull().default(true),
  submissionDuplicate: integer("submission_duplicate", { mode: "boolean" }).notNull().default(true),
  submissionInlibrary: integer("submission_inlibrary", { mode: "boolean" }).notNull().default(true),
  membershipReminder: integer("membership_reminder", { mode: "boolean" }).notNull().default(true),
  taskUpdate: integer("task_update", { mode: "boolean" }).notNull().default(true),
  updatedAt: text("updated_at").notNull(),
});

/** 投稿审核设置（单行）：新上映影片可投稿前的缓冲天数。 */
export const submissionSettings = sqliteTable("submission_settings", {
  id: integer("id").primaryKey(),
  releaseBlockDays: integer("release_block_days").notNull().default(90),
  updatedAt: text("updated_at").notNull(),
});

/**
 * 应用设置（P1 配置后台化）：env → 数据库的唯一落点。
 * 值的类型/默认值/是否密钥由 apps/server/src/settings/registry.ts 定义（单一真源），
 * 这里只做通用键值存储：value 统一 JSON 编码，is_secret 仅用于接口掩码与日志脱敏。
 */
export const appSettings = sqliteTable("app_settings", {
  key: text("key").primaryKey(),
  value: text("value"),
  isSecret: integer("is_secret", { mode: "boolean" }).notNull().default(false),
  updatedAt: text("updated_at").notNull(),
  /** 来源标记：admin / env-seed / generated / default。 */
  updatedBy: text("updated_by"),
});

/** 用户邮件偏好覆盖（null=跟随管理员默认；表内只存显式设置）。 */
export const userMailPreferences = sqliteTable(
  "user_mail_preferences",
  {
    email: text("email").notNull(),
    mailType: text("mail_type").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [uniqueIndex("user_mail_preferences_email_type_idx").on(table.email, table.mailType)],
);

/** 管理操作审计。 */
export const auditLogs = sqliteTable(
  "audit_logs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    operator: text("operator").notNull().default("system"),
    action: text("action").notNull(),
    targetType: text("target_type").notNull(),
    targetId: integer("target_id"),
    before: text("before_json"),
    after: text("after_json"),
    note: text("note"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [index("audit_logs_created_idx").on(table.createdAt)],
);

/** 内容提供方（TMDB/豆瓣/猫眼/B站/腾讯…统一适配）。 */
export const contentProviders = sqliteTable("content_providers", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  code: text("code").notNull().unique(),
  name: text("name").notNull(),
  adapter: text("adapter").notNull(),
  config: text("config_json", { mode: "json" })
    .$type<Record<string, unknown>>()
    .notNull()
    .default(sql`'{}'`),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  priority: integer("priority").notNull().default(0),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/** 提供方内容索引：源侧条目（后续平台对接/去重/可用性）。 */
export const providerItems = sqliteTable(
  "provider_items",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    providerId: integer("provider_id")
      .notNull()
      .references(() => contentProviders.id),
    externalId: text("external_id").notNull(),
    itemId: integer("item_id").references(() => mediaItems.id),
    externalTitle: text("external_title"),
    quality: text("quality"),
    available: integer("available", { mode: "boolean" }).notNull().default(true),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [uniqueIndex("provider_items_provider_external_idx").on(table.providerId, table.externalId)],
);

/** 使用记录：一次「登录」或一次「播放」事件的流水（采样器 + Emby 活动日志回填都写这里）。 */
export const memberUsageEvents = sqliteTable(
  "member_usage_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** Emby 用户 Id（会话里就有；活动日志回填时按 UserId 取）。 */
    embyUserId: text("emby_user_id"),
    /** 会员邮箱（能对上会员时才有；仅 Emby 账号为空）。 */
    memberEmail: text("member_email"),
    /** Emby 里的用户名快照（会员改名/删号后仍能看出是谁）。 */
    userName: text("user_name"),
    /** login=登录/客户端连上；play_start=开始播放；play_stop=结束播放；session_end=断开连接；other=其它 Emby 活动。 */
    kind: text("kind", { enum: usageEventKinds }).notNull(),
    /** sampler=应用自己采样得到；activity_log=Emby 活动日志回填。 */
    source: text("source", { enum: usageEventSources }).notNull(),
    /** 去重键：Emby 活动日志条目的 Id（采样事件为空）。 */
    externalId: text("external_id"),
    itemId: text("item_id"),
    /** 作品名（剧集为剧名；电影为片名）。 */
    itemTitle: text("item_title"),
    /** 剧集标题（"第 4 季 第 4 集"，电影为空）。 */
    episodeTitle: text("episode_title"),
    seasonNumber: integer("season_number"),
    episodeNumber: integer("episode_number"),
    deviceId: text("device_id"),
    deviceName: text("device_name"),
    client: text("client"),
    appVersion: text("app_version"),
    remoteAddress: text("remote_address"),
    positionTicks: integer("position_ticks"),
    runTimeTicks: integer("run_time_ticks"),
    /** 原始文案（Emby 活动日志的 Name/ShortOverview），用于识别不了的条目也能看。 */
    detail: text("detail"),
    /** 事件发生时间（Emby 给的时间或采样时刻）。 */
    occurredAt: text("occurred_at").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("member_usage_events_occurred_idx").on(table.occurredAt),
    index("member_usage_events_email_idx").on(table.memberEmail, table.occurredAt),
    index("member_usage_events_user_idx").on(table.embyUserId, table.occurredAt),
    // 活动日志回填可反复跑：同一条 Emby 记录只落一行。
    uniqueIndex("member_usage_events_source_external_idx").on(table.source, table.externalId),
  ],
);

/**
 * 使用记录：一段连续的「在用」区间（按时段统计的依据）。
 *
 * 为什么是区间而不是事件：时段统计要问"某会员一天里哪几个钟头在用"，只有开始/结束两个点
 * 是算不出来的（服务重启、客户端崩溃都会丢结束点）。采样器每隔一段时间看一次 Emby 会话，
 * 用 last_seen_at 延长这段区间；会话消失或换片就封口（ended_at）。
 */
export const memberUsageSegments = sqliteTable(
  "member_usage_segments",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** Emby 会话 Id：同一台设备的连接。 */
    sessionId: text("session_id").notNull(),
    embyUserId: text("emby_user_id"),
    memberEmail: text("member_email"),
    userName: text("user_name"),
    /** play=正在播放；idle=客户端连着但没在播（挂着也算在用）。 */
    kind: text("kind", { enum: usageSegmentKinds }).notNull(),
    /** 播放的对象：同一次会话换片就开新的一段。 */
    itemId: text("item_id").notNull().default(""),
    itemTitle: text("item_title"),
    episodeTitle: text("episode_title"),
    seasonNumber: integer("season_number"),
    episodeNumber: integer("episode_number"),
    deviceId: text("device_id"),
    deviceName: text("device_name"),
    client: text("client"),
    appVersion: text("app_version"),
    remoteAddress: text("remote_address"),
    playMethod: text("play_method"),
    /** 最后一次看到的播放进度/总时长（看"看到哪儿了"）。 */
    positionTicks: integer("position_ticks"),
    runTimeTicks: integer("run_time_ticks"),
    /** 采样到的播放地址（DirectPlay 时的源地址/文件，可空）。 */
    mediaSourceName: text("media_source_name"),
    /** 这一段第一次被看到的时间。 */
    startedAt: text("started_at").notNull(),
    /** 最近一次采样仍在用（还没封口）的时间。 */
    lastSeenAt: text("last_seen_at").notNull(),
    /** 封口时间：非空表示这一段已经结束。 */
    endedAt: text("ended_at"),
  },
  (table) => [
    // 一段会话+一种状态+一个片源只允许有一条未封口记录：采样器据此 upsert 而不是刷屏。
    uniqueIndex("member_usage_segments_open_idx")
      .on(table.sessionId, table.kind, table.itemId)
      .where(sql`ended_at IS NULL`),
    index("member_usage_segments_started_idx").on(table.startedAt),
    index("member_usage_segments_email_idx").on(table.memberEmail, table.startedAt),
  ],
);

export const schema = {
  virtualLibraryPosters,
  virtualLibraries,
  virtualLibraryItems,
  cardKeys,
  memberUsageEvents,
  memberUsageSegments,
  libraryEpisodes,
  libraryItems,
  libraryScanRuns,
  logs,
  mediaItems,
  mediaRoots,
  mediaTasks,
  movieSubmissions,
  concurrencyPolicySettings,
  concurrencyEscalationState,
  memberUnfreezeEvents,
  submissionUsers,
  taskRuns,
  trendingSnapshots,
  platforms,
  submissionTimeline,
  quotaLedger,
  mediaAliases,
  userNotifications,
  taskSeasons,
  auditLogs,
  contentProviders,
  providerItems,
  notifyRetentionSettings,
  mailDefaultSettings,
  submissionSettings,
  userMailPreferences,
  contentArticles,
  trendingSourceConfigs,
  verificationCodes,
  appSettings,
};

export type MediaItemRow = typeof mediaItems.$inferSelect;
export type MediaTaskRow = typeof mediaTasks.$inferSelect;
export type TaskRunRow = typeof taskRuns.$inferSelect;
export type LogRow = typeof logs.$inferSelect;
