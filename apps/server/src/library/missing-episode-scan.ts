import { eq, notInArray } from "drizzle-orm";

import type { AppDatabase } from "@emby-task-center/database/client";
import {
  missingEpisodeSnapshots,
  type EmbySeasonRef,
  type MissingEpisodeEntry,
  type MissingEpisodePendingSeason,
  type MissingEpisodeSeasonSnapshot,
  type MissingEpisodeSuspectSeason,
  type MissingEpisodeUnmatchedSeason,
  type TmdbSeasonEpisodesCache,
} from "@emby-task-center/database/schema";
import type { EmbyClient } from "../integrations/emby-client";
import { isEpisodeAiredEnough, type TmdbClient } from "../tmdb/client";
import { mapWithLimit } from "../util/concurrency";
import { readMissingGraceHours } from "./missing-grace";
import { createMissingTmdbLoader, type MissingMetadataIssue } from "./missing-tmdb-cache";
import { createMissingMetadataStore } from "./missing-metadata-store";
import { createMissingScanContext } from "./missing-scan-context";
/** 并发上限：首次全量会打几千个 TMDB 请求，4 路并发既快又不容易触发限流。 */
const SCAN_CONCURRENCY = 4;

export type MissingEpisodeScanTrigger = "startup" | "interval" | "manual";

export interface MissingEpisodeScanStatus {
  running: boolean;
  trigger: MissingEpisodeScanTrigger | null;
  startedAt: string | null;
  finishedAt: string | null;
  /** 本轮要检测的剧集总数与已处理数（首次全量为进度条用）。 */
  total: number;
  processed: number;
  missingShows: number;
  missingEpisodes: number;
  /** 宽限期内（默认=今日更新）还没入库、暂不计缺集的剧数与集数（提示用）。 */
  pendingShows: number;
  pendingEpisodes: number;
  /** 疑似编号体系不一致、未判定缺集的季数（按剧去重计数）。 */
  suspectShows: number;
  /** TMDB 标识与 Emby 实际不一致、被剔除的剧数。 */
  mismatches: number;
  failed: number;
  error: string | null;
  /** 包含首次无完整快照的失败条目，不能把它们解释为已齐。 */
  metadataIssues?: MissingMetadataIssue[];
}

export interface MissingEpisodeScanner {
  status(): MissingEpisodeScanStatus;
  /** 跑一轮全库检测；已有轮次在跑时直接返回（不排队、不并发）。 */
  run(trigger: MissingEpisodeScanTrigger): Promise<void>;
}

function emptyStatus(): MissingEpisodeScanStatus {
  return {
    running: false,
    trigger: null,
    startedAt: null,
    finishedAt: null,
    total: 0,
    processed: 0,
    missingShows: 0,
    missingEpisodes: 0,
    pendingShows: 0,
    pendingEpisodes: 0,
    suspectShows: 0,
    mismatches: 0,
    failed: 0,
    error: null,
    metadataIssues: [],
  };
}

function localIsoDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** 集名归一化：统一大小写/全半角、去空白与常见标点，用于"编号变了但名字还在"的兜底比对。 */
export function normalizeEpisodeName(name: string | null): string {
  if (!name) return "";
  return name
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[\s\u3000]+/g, "")
    .replace(/[·・\-—–_【】[\]()（）"“”'‘’,，。.!！?？:：/\\]+/g, "");
}

/** "第 11 集 / 第十一集 / E11" 这类占位名没有区分度，不参与名字兜底。 */
function isGenericEpisodeName(name: string | null): boolean {
  const normalized = normalizeEpisodeName(name);
  if (normalized.length < 2) return true;
  return (
    /^第?[0-9一二三四五六七八九十百零〇两]+[集话話]$/.test(normalized) ||
    /^episode[0-9]+$/.test(normalized) ||
    /^e[0-9]+$/.test(normalized) ||
    /^[0-9]+$/.test(normalized)
  );
}

/**
 * 集名兜底：被判缺集的集，如果名字已经在 Emby 里存在（只是编号不同——两边季切分点不一样的典型
 * 症状，例如螺丝钉 TMDB S1 的 53–60 集其实是 Emby S2 的前 8 集），整季降级为"疑似编号不一致"，
 * 不再报缺集。只有非占位名参与比对，且要求过半命中，避免同名巧合吞掉真缺集。
 */
export function applyNameGuard(
  missing: readonly MissingEpisodeSeasonSnapshot[],
  embyNames: Set<string> | null | undefined,
): {
  missing: MissingEpisodeSeasonSnapshot[];
  guarded: MissingEpisodeSuspectSeason[];
  removedAired: number;
  removedStored: number;
} {
  if (!embyNames?.size) return { missing: [...missing], guarded: [], removedAired: 0, removedStored: 0 };
  const kept: MissingEpisodeSeasonSnapshot[] = [];
  const guarded: MissingEpisodeSuspectSeason[] = [];
  let removedAired = 0;
  let removedStored = 0;
  for (const season of missing) {
    const named = season.episodes.filter((episode) => !isGenericEpisodeName(episode.name));
    const matched = named.filter((episode) => embyNames.has(normalizeEpisodeName(episode.name)));
    if (named.length >= 2 && matched.length >= 2 && matched.length / named.length >= 0.5) {
      guarded.push({ seasonNumber: season.seasonNumber, aired: season.aired, stored: season.stored });
      removedAired += season.aired;
      removedStored += season.stored;
      continue;
    }
    kept.push(season);
  }
  return { missing: kept, guarded, removedAired, removedStored };
}

/**
 * 判断库内编号是不是"全剧连续绝对编号"（TVDB 风格）：每一季的集号都接在上一季之后。
 * 例：S1 1–25、S2 26–37、S3 38–49；而逐季从 1 编号（S1 1–20、S2 1–20）不算。
 */
function usesContinuousNumbering(storedBySeason: Map<number, Set<number>>): boolean {
  const seasons = [...storedBySeason.entries()]
    .filter(([season, numbers]) => season > 0 && numbers.size > 0)
    .sort((left, right) => left[0] - right[0]);
  if (seasons.length < 2) return false;
  for (let index = 1; index < seasons.length; index += 1) {
    const previousMax = Math.max(...seasons[index - 1]![1]);
    const currentMin = Math.min(...seasons[index]![1]);
    if (currentMin <= previousMax) return false;
  }
  return true;
}

export interface MissingEpisodeComputation {
  missing: MissingEpisodeSeasonSnapshot[];
  /** 宽限期内（默认=今日更新）的集：暂不计缺集，页面单独标出。 */
  pending: MissingEpisodePendingSeason[];
  unmatched: MissingEpisodeUnmatchedSeason[];
  suspects: MissingEpisodeSuspectSeason[];
  airedCount: number;
  storedCount: number;
  missingCount: number;
  pendingCount: number;
}

/**
 * 逐集比对：TMDB 已播（airDate <= 今天）但库内没有的集号就是缺集。
 *
 * 三种编号现实都要照顾（2026-09-19 用真实库全量对账后确定）：
 * 1. 常规逐季编号 → 同季逐集比对；
 * 2. TVDB/Emby 全剧连续绝对编号（进击的巨人、妖神记、死神）→ 按"TMDB 全剧绝对位置"比对；
 *    整段绝对范围都在库内最大集号之后（续篇是另一个 Emby 条目）→ 列未比对；
 * 3. TVDB 半集合并 vs TMDB 分段（海绵宝宝）→ 连续前缀 + 缺失恰为后缀且比例异常时列"疑似编号
 *    体系不一致"，不报缺集（宁可少报，也不给出会导致误删的假缺集）。
 *
 * 库内没有这一季的记录 → 不臆造缺集，列未比对（斗破苍穹式季号错位）。
 */
export function computeMissingEpisodes(
  tmdbSeasons: readonly TmdbSeasonEpisodesCache[],
  storedBySeason: Map<number, Set<number>>,
  now: Date,
  graceHours = 0,
): MissingEpisodeComputation {
  const today = localIsoDate(now);
  // 已播出且"播够了"（过了入库宽限期）→ 参与缺集比对；仍在宽限期内（默认=今日更新）的单独归类。
  const airedOf = (season: TmdbSeasonEpisodesCache) =>
    season.episodes.filter(
      (episode) =>
        episode.airDate !== null &&
        episode.airDate !== "" &&
        episode.airDate <= today &&
        isEpisodeAiredEnough(episode.airDate, now, graceHours),
    );
  const pendingRawOf = (season: TmdbSeasonEpisodesCache) =>
    season.episodes.filter(
      (episode) =>
        episode.airDate !== null &&
        episode.airDate !== "" &&
        episode.airDate <= today &&
        !isEpisodeAiredEnough(episode.airDate, now, graceHours),
    );
  const missing: MissingEpisodeSeasonSnapshot[] = [];
  const pending: MissingEpisodePendingSeason[] = [];
  const unmatched: MissingEpisodeUnmatchedSeason[] = [];
  const suspects: MissingEpisodeSuspectSeason[] = [];
  let airedCount = 0;
  let storedCount = 0;
  let missingCount = 0;
  let pendingCount = 0;
  /** 宽限期内、但已经入库的集数：计入「已播」口径，保证"已播 − 今日更新"仍是真实已播。 */
  let pendingStoredCount = 0;

  /**
   * 收「今日更新」（宽限期内）的集：只提示、不算缺集；已经入库的集也不再提示"待入库"。
   * display/altStored 用来兼容"TMDB 全剧连续编号 vs 每季从 1"的两套编号（同一集可能有两种号）。
   */
  const collectPending = (
    season: TmdbSeasonEpisodesCache,
    display: (episodeNumber: number) => number,
    altStored: (episodeNumber: number) => number[],
  ): void => {
    const raw = pendingRawOf(season);
    if (!raw.length) return;
    const stored = storedBySeason.get(season.seasonNumber);
    const episodes: MissingEpisodeEntry[] = [];
    for (const episode of raw) {
      const shown = { ...episode, episodeNumber: display(episode.episodeNumber) };
      const candidates = [shown.episodeNumber, ...altStored(episode.episodeNumber)];
      if (stored && candidates.some((number) => stored.has(number))) {
        pendingStoredCount += 1;
        continue;
      }
      episodes.push(shown);
    }
    if (!episodes.length) return;
    pending.push({ seasonNumber: season.seasonNumber, episodes });
    pendingCount += episodes.length;
  };

  // ── 连续绝对编号：按 TMDB 全剧绝对位置比对（TMDB 季内集号 + 前面各季总集数） ──
  if (usesContinuousNumbering(storedBySeason)) {
    const localAbsolute = new Set<number>();
    for (const [season, numbers] of storedBySeason) {
      if (season <= 0 || numbers.size === 0) continue;
      for (const number of numbers) localAbsolute.add(number);
    }
    const localMax = Math.max(...localAbsolute);
    let offset = 0;
    for (const season of [...tmdbSeasons].sort((left, right) => left.seasonNumber - right.seasonNumber)) {
      const aired = airedOf(season);
      // 「今日更新」按 TMDB 全剧绝对位置判"是否已入库"（与下面的缺集比对同一套绝对号）。
      collectPending(
        season,
        (number) => number,
        (number) => [offset + number],
      );
      if (aired.length) {
        const absoluteNumbers = aired.map((episode) => offset + episode.episodeNumber);
        // 整季都在库内最大集号之后：多半是续篇（库内是另一个 Emby 条目），列未比对而不是缺集。
        if (Math.min(...absoluteNumbers) > localMax) {
          unmatched.push({ seasonNumber: season.seasonNumber, airedEpisodes: aired.length });
        } else {
          const missingEpisodes = aired.filter((_, index) => !localAbsolute.has(absoluteNumbers[index]!));
          const storedInSeason = aired.length - missingEpisodes.length;
          airedCount += aired.length;
          storedCount += storedInSeason;
          missingCount += missingEpisodes.length;
          if (missingEpisodes.length) {
            missing.push({
              seasonNumber: season.seasonNumber,
              aired: aired.length,
              stored: storedInSeason,
              episodes: missingEpisodes,
            });
          }
        }
      }
      offset += season.episodes.length;
    }
    return {
      missing,
      pending,
      unmatched,
      suspects,
      // 已播口径仍是 TMDB 的"已播出"（含今日更新）；已存口径仍是库里这一季的集数
      //（与任务看板一致，可能大于已播——例如库里还有 TMDB 未播的集）。
      airedCount: airedCount + pendingCount + pendingStoredCount,
      storedCount,
      missingCount,
      pendingCount,
    };
  }

  // ── 常规逐季编号 ──
  // TMDB 也有"全剧连续编号"的现实（侠岚：S2 是 27–52、S3 是 53–78，而 Emby/TVDB 每季从 1 编号）。
  // 先统计每个 TMDB 赛季的起始号是否正好接在前几季总集数之后，连续季 >= 2 才启用归一化，
  // 把这些季的集号换算成"每季相对集号"再比对（显示也用相对集号，和 Emby 里看到的一致）。
  const orderedSeasons = [...tmdbSeasons].sort((left, right) => left.seasonNumber - right.seasonNumber);
  const seasonOffsets = new Map<number, number>();
  let tmdbContinuousCount = 0;
  {
    let offset = 0;
    for (const season of orderedSeasons) {
      const numbers = season.episodes.map((episode) => episode.episodeNumber);
      const firstNumber = numbers.length ? Math.min(...numbers) : null;
      if (offset > 0 && firstNumber === offset + 1) tmdbContinuousCount += 1;
      seasonOffsets.set(season.seasonNumber, offset);
      offset += season.episodes.length;
    }
  }
  const tmdbContinuous = tmdbContinuousCount >= 2;
  const normalizeSeason = (season: TmdbSeasonEpisodesCache, firstNumber: number | null) => {
    const offset = seasonOffsets.get(season.seasonNumber) ?? 0;
    return tmdbContinuous && offset > 0 && firstNumber === offset + 1 ? offset : 0;
  };

  interface SeasonStat {
    season: TmdbSeasonEpisodesCache;
    aired: ReturnType<typeof airedOf>;
    stored: Set<number>;
    missingEpisodes: ReturnType<typeof airedOf>;
    storedIsPrefix: boolean;
    missingIsSuffix: boolean;
  }
  const stats: SeasonStat[] = [];
  for (const season of tmdbSeasons) {
    const allNumbers = season.episodes.map((episode) => episode.episodeNumber);
    const firstNumber = allNumbers.length ? Math.min(...allNumbers) : null;
    const offset = normalizeSeason(season, firstNumber);
    const airedRaw = airedOf(season);
    const aired = airedRaw.map((episode) =>
      offset ? { ...episode, episodeNumber: episode.episodeNumber - offset } : episode,
    );
    // 今日更新必须在 `aired.length === 0` 时也算（当天首播那一集）：所以放在 continue 之前。
    collectPending(
      season,
      (number) => (offset ? number - offset : number),
      (number) => (offset > 0 ? [number] : []),
    );
    if (!aired.length) continue;
    const stored = storedBySeason.get(season.seasonNumber);
    if (!stored) {
      unmatched.push({ seasonNumber: season.seasonNumber, airedEpisodes: aired.length });
      continue;
    }
    // 归一化季：相对集号或 TMDB 原集号任一在库内都算已存（库里可能两套编号只存了一套）。
    const missingEpisodes = aired.filter((episode, index) => {
      if (stored.has(episode.episodeNumber)) return false;
      return !(offset > 0 && stored.has(airedRaw[index]!.episodeNumber));
    });
    const storedMax = missingEpisodes.length ? Math.max(...stored) : 0;
    const storedIsPrefix = stored.size >= 1 && storedMax >= 1 && Math.min(...stored) === 1 && storedMax === stored.size;
    const missingIsSuffix =
      missingEpisodes.length > 0 &&
      missingEpisodes.every((episode, index) => episode.episodeNumber === storedMax + 1 + index);
    stats.push({ season, aired, stored, missingEpisodes, storedIsPrefix, missingIsSuffix });
  }
  // 单季的"连续前缀 + 整段后缀"且缺失占比高（0.35 以上）→ 强疑似；
  // 整部剧已有 3 个以上强疑似时，其余的"前缀+后缀"季（S12 这种比例偏低的）也是同一编号体系问题 → 弱疑似。
  const strongSuspect = (stat: SeasonStat) =>
    stat.storedIsPrefix &&
    stat.missingIsSuffix &&
    stat.stored.size >= 10 &&
    stat.missingEpisodes.length >= 5 &&
    stat.missingEpisodes.length >= 0.35 * stat.aired.length;
  const strongSuspectCount = stats.filter(strongSuspect).length;
  const weakSuspect = (stat: SeasonStat) =>
    strongSuspectCount >= 3 &&
    stat.storedIsPrefix &&
    stat.missingIsSuffix &&
    stat.stored.size >= 10 &&
    stat.missingEpisodes.length >= 3;
  for (const stat of stats) {
    if (strongSuspect(stat) || weakSuspect(stat)) {
      suspects.push({ seasonNumber: stat.season.seasonNumber, aired: stat.aired.length, stored: stat.stored.size });
      continue;
    }
    airedCount += stat.aired.length;
    storedCount += stat.stored.size;
    missingCount += stat.missingEpisodes.length;
    if (stat.missingEpisodes.length) {
      missing.push({
        seasonNumber: stat.season.seasonNumber,
        aired: stat.aired.length,
        stored: stat.stored.size,
        episodes: stat.missingEpisodes,
      });
    }
  }
  return {
    missing,
    pending,
    unmatched,
    suspects,
    airedCount: airedCount + pendingCount + pendingStoredCount,
    storedCount,
    missingCount,
    pendingCount,
  };
}

/**
 * 全库缺集检测器。
 *
 * 每小时跑一轮：库内已存来自本地扫描（Emby 驱动），"应有集"来自 TMDB；
 * TMDB 季/集列表按 12 小时缓存，缓存期内重算缺集只用本地数据。首次全量（约 3000 部剧）
 * 会打几千个 TMDB 请求，状态里给出进度。
 *
 * 出缺集的条目还会用 Emby 校验一次 TMDB ProviderId：库里同名但 TMDB id 对不上的条目
 * （会引发成百上千的假缺集）标记为 `emby_tmdb_mismatch` 并从缺集清单剔除。
 */
export function createMissingEpisodeScanner(options: {
  database: AppDatabase;
  tmdb: TmdbClient;
  emby?: EmbyClient | undefined;
}): MissingEpisodeScanner {
  const { database, tmdb, emby } = options;
  const tmdbCache = createMissingTmdbLoader(tmdb);
  const metadataStore = createMissingMetadataStore(database);
  let state = { ...emptyStatus(), metadataIssues: metadataStore.issues() };

  interface EmbyVerification {
    exists: boolean;
    names: Set<string> | null;
    seriesId: string | null;
    /** Emby 条目实际登记的 TMDB Id（标识不一致时用于"单独展示"）。 */
    embyTmdbId: number | null;
    /** 季号 → Emby 季条目 Id（「在 Emby 查看」按季跳转用）。 */
    seasons: EmbySeasonRef[];
  }

  async function verifyAgainstEmby(tmdbId: number, sourceTitle: string | null): Promise<EmbyVerification> {
    if (!emby?.configured || typeof emby.searchItems !== "function") {
      return { exists: true, names: null, seriesId: null, embyTmdbId: null, seasons: [] };
    }
    try {
      const matches = (await emby.searchItems({ tmdbId, mediaType: "tv" })).filter(
        (candidate) => candidate.type === "tv" && candidate.tmdbId === tmdbId,
      );
      if (!matches.length) {
        // 库里同名但 TMDB 标识对不上：记下 Emby 实际的条目 Id 与 TMDB Id，页面单独展示。
        const titleMatches = sourceTitle
          ? (await emby.searchItems({ title: sourceTitle, mediaType: "tv" })).filter(
              (candidate) => candidate.type === "tv",
            )
          : [];
        const actual = titleMatches.find((candidate) => candidate.tmdbId != null) ?? titleMatches[0] ?? null;
        return {
          exists: false,
          names: null,
          seriesId: actual?.id ?? null,
          embyTmdbId: actual?.tmdbId ?? null,
          seasons: [],
        };
      }
      const names = new Set<string>();
      const seasonById = new Map<number, string>();
      for (const match of matches) {
        if (typeof emby.listItemEpisodes === "function") {
          const episodes = await emby.listItemEpisodes(match.id);
          for (const episode of episodes) {
            if (isGenericEpisodeName(episode.name)) continue;
            const normalized = normalizeEpisodeName(episode.name);
            if (normalized) names.add(normalized);
          }
        }
        if (typeof emby.listSeasons === "function") {
          try {
            for (const season of await emby.listSeasons(match.id)) {
              if (season.seasonNumber != null && !seasonById.has(season.seasonNumber)) {
                seasonById.set(season.seasonNumber, season.id);
              }
            }
          } catch {
            // 季列表拿不到不影响缺集判定，只是跳转链接退化到剧集页。
          }
        }
      }
      return {
        exists: true,
        names,
        seriesId: matches[0]!.id,
        embyTmdbId: tmdbId,
        seasons: [...seasonById].map(([seasonNumber, id]) => ({ seasonNumber, id })),
      };
    } catch {
      // Emby 查询失败不阻断：保留按本地数据算出的结果，下轮再校验。
      return { exists: true, names: null, seriesId: null, embyTmdbId: null, seasons: [] };
    }
  }

  async function run(trigger: MissingEpisodeScanTrigger): Promise<void> {
    if (state.running) return;
    state = { ...emptyStatus(), metadataIssues: [], running: true, trigger, startedAt: new Date().toISOString() };
    let context: Awaited<ReturnType<typeof createMissingScanContext>> | undefined;
    try {
      context = await createMissingScanContext(database);
      const activeContext = context;
      const { candidates } = context;
      state.total = candidates.length;
      const now = new Date();
      const today = localIsoDate(now);
      // 「今日更新」宽限期：设置项 library.missingGraceHours，默认 24 小时（次日 0 点起算）。
      const graceHours = readMissingGraceHours(database);
      let missingShows = 0;
      let missingEpisodes = 0;
      let pendingShows = 0;
      let pendingEpisodes = 0;
      let suspectShows = 0;
      let mismatches = 0;
      let failed = 0;
      let contextError: unknown;

      await mapWithLimit(candidates, SCAN_CONCURRENCY, async (item) => {
        if (contextError) return;
        const tmdbId = item.tmdbId!;
        let loaded: Awaited<ReturnType<typeof activeContext.read>>;
        try {
          loaded = await activeContext.read(item.id);
        } catch (error) {
          contextError = error instanceof Error ? error : new Error(String(error));
          return;
        }
        if (contextError) return;
        const { stored, previous: old, sourceTitle } = loaded;
        const previous = old?.tmdbId === tmdbId ? old : undefined;
        const persistedFailure = metadataStore.get(item.id);
        const metadata = await tmdbCache.load(
          tmdbId,
          today,
          now,
          persistedFailure?.issue.tmdbId === tmdbId ? persistedFailure : previous,
        );
        const tmdbSeasons = metadata.seasons;
        const fetchedAt = metadata.fetchedAt;
        let error: string | null = null;
        if (metadata.health) {
          failed += 1;
          const issue = { ...metadata.health, mediaItemId: item.id, tmdbId, title: item.title };
          state.metadataIssues.push(issue);
          // Persist diagnostics even before a complete display snapshot exists.
          metadataStore.save(item.id, { issue, tmdbSeasons, fetchedAt, health: metadata.health });
          if (previous) {
            // 单季失败也保留完整的上一轮展示，避免季缺失改变绝对编号偏移或制造假 0 缺集。
            // 成功的新季缓存可留下，失败季沿用旧数据，fetchedAt/scannedAt 不冒充完整刷新。
            database
              .update(missingEpisodeSnapshots)
              .set({
                tmdbSeasons,
                fetchedAt,
                error: previous.error === "emby_tmdb_mismatch" ? previous.error : metadata.health.error,
              })
              .where(eq(missingEpisodeSnapshots.mediaItemId, item.id))
              .run();
            if (previous.missingCount > 0) {
              missingShows += 1;
              missingEpisodes += previous.missingCount;
            }
            if (previous.pendingSeasons.length) {
              pendingShows += 1;
              pendingEpisodes += previous.pendingSeasons.reduce((sum, season) => sum + season.episodes.length, 0);
            }
            if (previous.suspectSeasons.length) suspectShows += 1;
            if (previous.error === "emby_tmdb_mismatch") mismatches += 1;
          }
          // 首次没有完整快照时只在 metadataIssues 报告失败，不发布假已齐快照。
          state.processed += 1;
          return;
        }
        metadataStore.clear(item.id);
        const computed = computeMissingEpisodes(tmdbSeasons, stored, now, graceHours);
        let missing = computed.missing;
        let pendingSeasons = computed.pending;
        let suspects = computed.suspects;
        let missingCount = computed.missingCount;
        let airedCount = computed.airedCount;
        let storedCount = computed.storedCount;
        // Emby 跳转用的条目 Id：本轮没校验时沿用上一轮的结果。
        let embySeriesId = previous?.embySeriesId ?? null;
        let embySeasons = previous?.embySeasons ?? [];
        let embyTmdbId = previous?.embyTmdbId ?? null;
        // 有"缺集/疑似"、或上一轮被判标识不一致（要补记 Emby 实际信息）时才打 Emby 校验。
        const needsVerify =
          missingCount > 0 ||
          suspects.length > 0 ||
          (previous?.error === "emby_tmdb_mismatch" &&
            Boolean(emby?.configured && typeof emby.searchItems === "function"));
        if (needsVerify) {
          const verification = await verifyAgainstEmby(tmdbId, sourceTitle ?? item.title);
          if (!verification.exists) {
            error = "emby_tmdb_mismatch";
            missing = [];
            pendingSeasons = [];
            suspects = [];
            missingCount = 0;
            airedCount = 0;
            storedCount = 0;
            embySeriesId = verification.seriesId ?? null;
            embyTmdbId = verification.embyTmdbId ?? null;
            embySeasons = [];
            mismatches += 1;
          } else {
            embySeriesId = verification.seriesId ?? embySeriesId;
            embyTmdbId = verification.embyTmdbId ?? embyTmdbId;
            if (verification.seasons.length) embySeasons = verification.seasons;
            if (verification.names?.size) {
              // 集名兜底：名字已在库内、只是编号不同（季切分点不同）→ 整季降级疑似，不报缺集。
              const guarded = applyNameGuard(missing, verification.names);
              if (guarded.guarded.length) {
                missing = guarded.missing;
                suspects = [...suspects, ...guarded.guarded];
                missingCount = missing.reduce((sum, season) => sum + season.episodes.length, 0);
                airedCount -= guarded.removedAired;
                storedCount -= guarded.removedStored;
              }
            }
          }
        }
        database
          .insert(missingEpisodeSnapshots)
          .values({
            mediaItemId: item.id,
            tmdbId,
            title: item.title,
            embySeriesId,
            embyTmdbId,
            embySeasons,
            tmdbSeasons,
            fetchedAt,
            missing,
            pendingSeasons,
            unmatchedSeasons: computed.unmatched,
            suspectSeasons: suspects,
            airedCount,
            storedCount,
            missingCount,
            error,
            scannedAt: new Date().toISOString(),
          })
          .onConflictDoUpdate({
            target: missingEpisodeSnapshots.mediaItemId,
            set: {
              tmdbId,
              title: item.title,
              embySeriesId,
              embyTmdbId,
              embySeasons,
              tmdbSeasons,
              fetchedAt,
              missing,
              pendingSeasons,
              unmatchedSeasons: computed.unmatched,
              suspectSeasons: suspects,
              airedCount,
              storedCount,
              missingCount,
              error,
              scannedAt: new Date().toISOString(),
            },
          })
          .run();
        if (missingCount > 0) {
          missingShows += 1;
          missingEpisodes += missingCount;
        }
        if (pendingSeasons.length > 0) {
          pendingShows += 1;
          pendingEpisodes += pendingSeasons.reduce((sum, season) => sum + season.episodes.length, 0);
        }
        if (suspects.length > 0) suspectShows += 1;
        state.processed += 1;
      });

      // A worker read failure must not end this run while another show's TMDB request can still write.
      if (contextError) throw contextError;
      // 不再出现在库里（被删除/取消匹配）的剧：快照行一并清掉。
      const candidateIds = candidates.map((item) => item.id);
      const currentIds = new Set(candidateIds);
      for (const issue of metadataStore.issues()) {
        if (!currentIds.has(issue.mediaItemId)) metadataStore.clear(issue.mediaItemId);
      }
      if (candidateIds.length) {
        database
          .delete(missingEpisodeSnapshots)
          .where(notInArray(missingEpisodeSnapshots.mediaItemId, candidateIds))
          .run();
      } else {
        database.delete(missingEpisodeSnapshots).run();
      }

      state.missingShows = missingShows;
      state.missingEpisodes = missingEpisodes;
      state.pendingShows = pendingShows;
      state.pendingEpisodes = pendingEpisodes;
      state.suspectShows = suspectShows;
      state.mismatches = mismatches;
      state.failed = failed;
    } catch (caught) {
      state.error = caught instanceof Error ? caught.message : "scan_failed";
    } finally {
      await context?.close();
      state.running = false;
      state.finishedAt = new Date().toISOString();
    }
  }

  return {
    status: () => ({ ...state, metadataIssues: [...(state.metadataIssues ?? [])] }),
    run,
  };
}
