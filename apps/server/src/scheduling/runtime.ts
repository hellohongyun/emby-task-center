/**
 * 后台定时任务运行时（P3：从 index.ts 抽出）。
 *
 * index.ts 只负责"装配依赖 + 监听端口"，所有周期性工作集中到这里，
 * 由 startRuntime() 统一启动、返回 stop() 供优雅退出调用。
 *
 * 依赖全部显式传入（不再从进程环境或模块级单例取），因此可以直接在测试里驱动单个任务。
 */
import type { AppDatabase } from "@emby-task-center/database/client";
import {
  applyScheduledAirProgress,
  listTasks,
  sweepExpiredCompletedIngestTasks,
} from "@emby-task-center/task-domain/task-service";

import type { EmbyClient } from "../integrations/emby-client";
import type { EmailNotifier } from "../notifications/email-service";
import { refreshTvTaskAirProgress } from "../library/air-progress";
import type { MissingEpisodeScanner } from "../library/missing-episode-scan";
import { createScanCoordinator, type ScanCoordinator } from "../library/scan-coordinator";
import { createScanScheduler } from "../library/scan-scheduler";
import { createScanRetryGate } from "../library/scan-retry";
import type { LibraryService } from "../library/service";
import { cleanupOrphanMediaItems, enrichMediaMetadata, matchUnresolvedToTmdb } from "../library/tmdb-enrichment";
import type { Logger } from "../logging/logger";
import { safeError } from "../logging/safe-error";
import { runProgressScanCycle } from "../scheduling/progress-scan-cycle";
import { createConcurrencyEscalationRunner } from "./concurrency-escalation-runner";
import { createSingleRoundRunner } from "./single-round-runner";
import type { SettingsSnapshot } from "../settings/registry";
import { getRuntimeSettings } from "../settings/runtime";
import { ESCALATION_TICK_MS, enforceConcurrencyEscalation } from "../subscriptions/concurrency-escalation";
import { getConcurrencyPolicy } from "../integrations/concurrency-policy-config";
import { enforceStreamLimits } from "../subscriptions/stream-guard";
import { StreamLimitResolver } from "../subscriptions/stream-limits";
import { syncAllStreamLimits } from "../subscriptions/emby-account";
import { runMembershipReminders } from "../subscriptions/reminders";
import { linkOrphanEmbyUsers } from "../subscriptions/emby-member-sync";
import { syncEmbyActivityLog } from "../usage/activity-log";
import { pruneUsageHistory } from "../usage/usage-store";
import { DEFAULT_SAMPLE_INTERVAL_MS, sampleMemberSessions } from "../usage/session-sampler";
import type { TmdbClient } from "../tmdb/client";
import type { TrendingService } from "../trending/service";

export interface RuntimeDeps {
  database: AppDatabase;
  logger: Logger;
  settings: SettingsSnapshot;
  library: LibraryService;
  tmdb: TmdbClient;
  emby: EmbyClient;
  email: EmailNotifier;
  embyEnabled: boolean;
  movieTaskRetentionHours: number;
  trending: TrendingService;
  /** 全库缺集检测器：定时全量比对 TMDB 已播与库内已存（结果供「缺集总览」读取）。 */
  missingEpisodeScanner: MissingEpisodeScanner;
  /** 优雅退出时要一起收尾的资源（Telegram 传输层等）。 */
  onShutdown?: Array<() => void | Promise<void>>;
}

export interface RuntimeHandle {
  runLibraryScan(trigger: "startup" | "interval" | "automation"): Promise<void>;
  runTmdbEnrichment(trigger: "startup" | "interval" | "automation" | "manual"): Promise<void>;
  runMissingEpisodeScan(trigger: "startup" | "interval" | "manual"): Promise<void>;
  stop(): void;
}

const TMDB_ENRICHMENT_INTERVAL_MS = 5 * 60_000;
const TMDB_ENRICHMENT_BATCH_SIZE = 100;
const TMDB_ENRICHMENT_MAX_BATCHES = 5;
const TMDB_ENRICHMENT_BATCH_DELAY_MS = 1_500;

export function startRuntime(deps: RuntimeDeps): RuntimeHandle {
  const { database, logger, settings, library, tmdb, emby, email } = deps;
  const timers: Array<ReturnType<typeof setInterval>> = [];
  /** 需要单独清理的定时器（看门狗用 setTimeout 自适应排期，句柄只有一个）。 */
  const guardTimers: Array<() => void> = [];
  let stopped = false;

  const scanRetry = createScanRetryGate();
  let scanTrigger: "startup" | "interval" | "automation" = "startup";
  const scanCoordinator: ScanCoordinator = createScanCoordinator({
    // 库根刷新也在协调器内，避免每个定时调用各自请求 Emby / 修改库根。
    scan: () => scanLibraryRoots(scanTrigger),
    recordScan: () => {
      scanRetry.succeeded();
      recordScheduledScan();
    },
    recordFailure: () => scanRetry.failed(),
  });

  let tmdbEnrichmentRunning = false;
  let lastTmdbEnrichmentAt = 0;

  async function runTmdbEnrichment(trigger: "startup" | "interval" | "automation" | "manual"): Promise<void> {
    if (tmdbEnrichmentRunning) return;
    const now = Date.now();
    if (trigger !== "manual" && now - lastTmdbEnrichmentAt < TMDB_ENRICHMENT_INTERVAL_MS) return;
    tmdbEnrichmentRunning = true;
    lastTmdbEnrichmentAt = now;
    try {
      let searched = 0;
      let matchedGroups = 0;
      let createdMediaItems = 0;
      let linkedLibraryItems = 0;
      let failedGroups = 0;
      for (let batch = 0; batch < TMDB_ENRICHMENT_MAX_BATCHES; batch += 1) {
        const result = await matchUnresolvedToTmdb(database, tmdb, { limit: TMDB_ENRICHMENT_BATCH_SIZE });
        searched += result.searched;
        matchedGroups += result.matchedGroups;
        createdMediaItems += result.createdMediaItems;
        linkedLibraryItems += result.linkedLibraryItems;
        failedGroups += result.failedGroups;
        if (result.matchedGroups === 0 || result.searched === 0) break;
        if (batch < TMDB_ENRICHMENT_MAX_BATCHES - 1) {
          await new Promise((resolve) => setTimeout(resolve, TMDB_ENRICHMENT_BATCH_DELAY_MS));
        }
      }
      let metadataUpdated = 0;
      let metadataFailed = 0;
      for (let batch = 0; batch < TMDB_ENRICHMENT_MAX_BATCHES; batch += 1) {
        const result = await enrichMediaMetadata(database, tmdb, { limit: 100 });
        metadataUpdated += result.updated;
        metadataFailed += result.failed;
        if (result.updated === 0) break;
        if (batch < TMDB_ENRICHMENT_MAX_BATCHES - 1) {
          await new Promise((resolve) => setTimeout(resolve, TMDB_ENRICHMENT_BATCH_DELAY_MS));
        }
      }
      const cleaned = cleanupOrphanMediaItems(database, { limit: 500 });
      // 这一轮改了 library_items（匹配结果 / 海报 / 题材），库存缓存必须作废
      library.invalidateInventory();
      logger.info({
        event: "tmdb_enrichment_completed",
        message: "未匹配元数据补齐完成",
        detail: JSON.stringify({
          trigger,
          batches: Math.ceil(searched / TMDB_ENRICHMENT_BATCH_SIZE),
          searched,
          matchedGroups,
          createdMediaItems,
          linkedLibraryItems,
          failedGroups,
          metadataUpdated,
          metadataFailed,
          cleaned,
        }),
      });
    } catch (error) {
      logger.error({
        event: "tmdb_enrichment_failed",
        message: "未匹配元数据补齐失败",
        detail: JSON.stringify({ trigger, error: safeError(error) }),
      });
    } finally {
      tmdbEnrichmentRunning = false;
    }
  }

  async function scanLibraryRoots(trigger: "startup" | "interval" | "automation"): Promise<void> {
    // 每次扫描前先同步库根（Emby 侧的库可能已增删改名）。
    // 拉取失败时 refreshRoots 会保留现有库根，所以"扫描照常"是安全的：不会因一次失败清空库存。
    const refresh = await deps.library.refreshRoots?.();
    if (refresh?.error) {
      logger.warn({
        event: "library_roots_refresh_failed",
        message: "库根同步失败，沿用现有库根",
        detail: JSON.stringify({ trigger, error: safeError(refresh.error) }),
      });
    } else if (refresh && (refresh.plan.added.length || refresh.plan.updated.length || refresh.plan.removed.length)) {
      logger.info({
        event: "library_roots_synced",
        message: "库根已同步",
        detail: JSON.stringify({ trigger, ...refresh.plan }),
      });
    }
    await library.scanEnabledRoots();
  }

  async function runLibraryScan(trigger: "startup" | "interval" | "automation"): Promise<void> {
    // 自动轮询遵守失败退避；显式 automation 可立即尝试，并合并为至多一轮后续扫描。
    if (trigger === "interval" && !scanRetry.canAttempt()) return;
    scanTrigger = trigger;
    try {
      await scanCoordinator.run(trigger === "automation");
      await runTmdbEnrichment(trigger);
      logger.info({ event: "library_scan_completed", message: "媒体库扫描完成", detail: JSON.stringify({ trigger }) });
    } catch (error) {
      logger.error({
        event: "library_scan_failed",
        message: "媒体库扫描失败",
        detail: JSON.stringify({ trigger, error: safeError(error) }),
      });
      throw error;
    }
  }

  const scanIntervalMinutes = settings["library.scanIntervalMinutes"];
  const scanScheduler = createScanScheduler({
    mode: settings["library.scanMode"],
    activeIntervalMinutes: scanIntervalMinutes || 30,
    fixedIntervalMinutes: scanIntervalMinutes || 30,
    idleFallbackMinutes: settings["library.idleScanIntervalMinutes"],
    episodeDelayHours: 3,
  });

  function readScanScheduleTasks() {
    return listTasks(database).map((task) => ({
      id: task.id,
      missingCount: task.missingEpisodes.length,
      releaseDays: task.releaseDays,
      releaseTime: task.releaseTime,
    }));
  }

  function recordScheduledScan(): void {
    // 先观察扫描后的任务状态，再记录扫描时间，避免启动后把已有缺集误判为尚未扫描的新缺集。
    scanScheduler.decide(readScanScheduleTasks());
    scanScheduler.recordScan();
  }

  async function runScheduledLibraryScan(): Promise<void> {
    if (scanIntervalMinutes === 0 || scanCoordinator.isRunning() || !scanRetry.canAttempt()) return;
    const decision = scanScheduler.decide(readScanScheduleTasks());
    if (!decision.shouldScan) return;
    await runLibraryScan("interval");
  }

  if (scanIntervalMinutes > 0) {
    timers.push(
      setInterval(
        () =>
          void runScheduledLibraryScan().catch((error) => {
            logger.error({
              event: "scheduled_library_scan_failed",
              message: "定时媒体库扫描失败",
              detail: JSON.stringify({ error: safeError(error) }),
            });
          }),
        60_000,
      ),
    );
  }

  // 邮件重试：每 5 分钟
  timers.push(
    setInterval(
      () =>
        void email.retryPending(database).catch((error) => {
          logger.error({
            event: "email_retry_failed",
            message: "邮件重试失败",
            detail: JSON.stringify({ error: safeError(error) }),
          });
        }),
      5 * 60_000,
    ),
  );

  let airProgressRefreshing = false;
  async function runAirProgressRefresh(): Promise<void> {
    if (airProgressRefreshing) return;
    airProgressRefreshing = true;
    try {
      await runProgressScanCycle({
        scanEnabled: scanIntervalMinutes > 0,
        refreshProgress: () => refreshTvTaskAirProgress(database, tmdb),
        scanIfDue: runScheduledLibraryScan,
        notifyPending: async () => undefined,
      });
      logger.info({ event: "air_progress_refreshed", message: "已播进度已刷新" });
    } catch (error) {
      logger.error({
        event: "air_progress_refresh_failed",
        message: "已播进度刷新失败",
        detail: JSON.stringify({ error: safeError(error) }),
      });
    } finally {
      airProgressRefreshing = false;
    }
  }

  async function runScheduledAirProgress(): Promise<void> {
    try {
      const updated = applyScheduledAirProgress(database);
      if (updated > 0) {
        await runProgressScanCycle({
          scanEnabled: scanIntervalMinutes > 0,
          refreshProgress: async () => undefined,
          scanIfDue: runScheduledLibraryScan,
          notifyPending: async () => undefined,
        });
        logger.info({ event: "scheduled_air_progress_applied", message: `已按排期更新 ${updated} 个任务已播数` });
      }
    } catch (error) {
      logger.error({
        event: "scheduled_air_progress_failed",
        message: "排期已播数更新失败",
        detail: JSON.stringify({ error: safeError(error) }),
      });
    }
  }

  const airProgressIntervalMinutes = settings["library.airProgressRefreshMinutes"];
  if (airProgressIntervalMinutes > 0) {
    timers.push(setInterval(() => void runAirProgressRefresh(), airProgressIntervalMinutes * 60_000));
  }
  void runAirProgressRefresh();
  timers.push(setInterval(() => void runScheduledAirProgress(), 60_000));
  void runScheduledAirProgress();

  // 全库缺集检测（缺集总览的数据来源）：默认每小时一轮，启动后先跑一次把快照建起来。
  // 检测器自带"跑着一轮就不再排队"的保护，这里再加一层避免日志重复。
  let missingEpisodeScanning = false;
  async function runMissingEpisodeScan(trigger: "startup" | "interval" | "manual"): Promise<void> {
    if (missingEpisodeScanning) return;
    missingEpisodeScanning = true;
    try {
      await deps.missingEpisodeScanner.run(trigger);
      const status = deps.missingEpisodeScanner.status();
      logger.info({
        event: "missing_episode_scan_completed",
        message:
          `全库缺集检测完成：${status.missingShows} 部缺 ${status.missingEpisodes} 集` +
          `（另有 ${status.pendingShows} 部今日更新 ${status.pendingEpisodes} 集待入库，不计缺集）`,
        detail: JSON.stringify({
          trigger,
          total: status.total,
          missingShows: status.missingShows,
          missingEpisodes: status.missingEpisodes,
          pendingShows: status.pendingShows,
          pendingEpisodes: status.pendingEpisodes,
          suspectShows: status.suspectShows,
          mismatches: status.mismatches,
          failed: status.failed,
        }),
      });
    } catch (error) {
      logger.error({
        event: "missing_episode_scan_failed",
        message: "全库缺集检测失败",
        detail: JSON.stringify({ trigger, error: safeError(error) }),
      });
    } finally {
      missingEpisodeScanning = false;
    }
  }
  const missingEpisodeScanIntervalMinutes = settings["library.missingEpisodeScanIntervalMinutes"];
  if (missingEpisodeScanIntervalMinutes > 0) {
    timers.push(setInterval(() => void runMissingEpisodeScan("interval"), missingEpisodeScanIntervalMinutes * 60_000));
    void runMissingEpisodeScan("startup");
  }

  // 已入库电影任务到期自动清理：完成后 retentionHours（默认 24，0 关闭）小时销毁任务
  async function runTaskRetentionSweep(): Promise<void> {
    const removed = sweepExpiredCompletedIngestTasks(database, deps.movieTaskRetentionHours);
    if (removed > 0) {
      logger.info({
        event: "completed_movie_tasks_swept",
        message: "已清理到期的已完成电影任务",
        detail: JSON.stringify({ count: removed }),
      });
    }
  }
  if (deps.movieTaskRetentionHours > 0) {
    timers.push(
      setInterval(
        () =>
          void runTaskRetentionSweep().catch((error) => {
            logger.error({
              event: "task_retention_sweep_failed",
              message: "已入库电影自动清理失败",
              detail: JSON.stringify({ error: safeError(error) }),
            });
          }),
        30 * 60_000,
      ),
    );
  }
  void runTaskRetentionSweep();

  // 会员临期/到期提醒：每 6 小时检查一次，每个状态只提醒一次（到期前 3 天 + 到期各一封）
  async function runMembershipReminderSweep(): Promise<void> {
    try {
      const count = await runMembershipReminders(database, email, new Date(), emby);
      if (count > 0) {
        logger.info({
          event: "membership_reminders_sent",
          message: "会员临期/到期提醒已处理",
          detail: JSON.stringify({ count }),
        });
      }
    } catch (error) {
      logger.error({ event: "membership_reminders_failed", message: "会员提醒处理失败", detail: safeError(error) });
    }
  }

  if (deps.embyEnabled) {
    timers.push(setInterval(() => void runMembershipReminderSweep(), 6 * 60 * 60_000));
    void runMembershipReminderSweep();

    // ── 会员使用记录 ─────────────────────────────────────────────────────────
    // 采样：每隔 sampleSeconds 看一次"谁在播什么"，延长/封口使用区间并补登录、开播事件。
    // 这是"一天里哪个时段在用"的唯一数据来源，服务没跑的时候就是空档（不会凭空补数据）。
    const sampleIntervalMs = Math.max(10_000, settings["usage.sampleSeconds"] * 1_000 || DEFAULT_SAMPLE_INTERVAL_MS);
    let usageSampling = false;
    const runUsageSample = async (): Promise<void> => {
      if (usageSampling) return;
      usageSampling = true;
      try {
        const sessions = (await emby.listSessions?.()) ?? [];
        sampleMemberSessions(database, sessions, new Date(), { intervalMs: sampleIntervalMs });
      } catch (error) {
        logger.warn({
          event: "member_usage_sample_failed",
          message: "会员使用记录采样失败",
          detail: JSON.stringify({ error: safeError(error) }),
        });
      } finally {
        usageSampling = false;
      }
    };
    timers.push(setInterval(() => void runUsageSample(), sampleIntervalMs));
    // 启动先补一次"太久没见到的区间"（上次进程被杀留下的悬空记录）。
    void runUsageSample();

    // 活动日志回填：Emby 自己记的登录/播放历史，补上"装上之前"和"服务没跑"的空档。
    // 认不出接口（老版本/权限不足）时只记一次警告，之后不再刷屏。
    let activityLogUnsupported = false;
    const activitySync = createSingleRoundRunner(async (): Promise<void> => {
      if (activityLogUnsupported) return;
      try {
        const outcome = await syncEmbyActivityLog(database, emby, { limit: 100 });
        if (outcome.unsupported) {
          activityLogUnsupported = true;
          logger.warn({
            event: "member_usage_activity_log_unsupported",
            message: "当前 Emby 不支持活动日志接口，使用记录只能靠采样累积",
          });
          return;
        }
        if (outcome.inserted > 0) {
          logger.info({
            event: "member_usage_activity_synced",
            message: `已从 Emby 活动日志补录 ${outcome.inserted} 条会员使用记录`,
            detail: JSON.stringify({ fetched: outcome.fetched, inserted: outcome.inserted, unknown: outcome.unknown }),
          });
        }
      } catch (error) {
        logger.warn({
          event: "member_usage_activity_sync_failed",
          message: "Emby 活动日志同步失败",
          detail: JSON.stringify({ error: safeError(error) }),
        });
      }
    });
    guardTimers.push(() => activitySync.stop());
    timers.push(setInterval(() => void activitySync.run(), 10 * 60_000));
    void activitySync.run();

    // Emby 账号 → 会员 的强制自动绑定：启动时先跑一次（把已有孤儿账号立刻收编），
    // 之后每 10 分钟一轮——Emby 后台新加的号最多 10 分钟就会出现在会员表里（可用邮箱验证码登录）。
    // 放在 syncAllStreamLimits 之前：新绑定的会员会被这一轮的上限同步一起覆盖。
    const embyMemberLink = createSingleRoundRunner(async (): Promise<void> => {
      const outcome = await linkOrphanEmbyUsers(database, emby);
      if (!outcome.linked.length && !outcome.adopted.length) return;
      logger.info({
        event: "emby_member_autolink",
        message: "已把 Emby 账号自动绑定为会员",
        detail: JSON.stringify({
          linked: outcome.linked.map((item) => ({ email: item.email, expiresAt: item.expiresAt })),
          adopted: outcome.adopted.map((item) => item.email),
          skipped: outcome.skipped.length,
        }),
      });
    });
    guardTimers.push(() => embyMemberLink.stop());
    timers.push(setInterval(() => void embyMemberLink.run().catch(() => undefined), 10 * 60_000));
    void embyMemberLink.run().catch(() => undefined);

    // 并发上限说明：此 Emby 服务既不执行用户级 SimultaneousStreamLimit，也不因停用账号拦截"已登录设备"的播放，
    // 所以限制只能由 App 侧执行：看门狗实时中断（限内兜底），超限升级到点直接冻结（冻结同时断会话 + 踢设备）。
    void syncAllStreamLimits(database, emby).catch(() => undefined);
    // 并发超限升级：每 10 秒检查一次；上一轮未结束时跳过，不排队。冻结期间持续断流，到期自动恢复。
    const escalation = createConcurrencyEscalationRunner(
      () => enforceConcurrencyEscalation(database, emby, email),
      logger,
    );
    guardTimers.push(() => escalation.stop());
    timers.push(setInterval(() => void escalation.run().catch(() => undefined), ESCALATION_TICK_MS));
    void escalation.run().catch(() => undefined);
    // 并发看门狗：查 Emby 会话，同一个账号真出现第二路播放就把它掐掉（先到先得，中断后来者）。
    // 这是并发限制**唯一**的执行点：不在请求层猜意图（客户端浏览时也会问
    // PlaybackInfo，按请求判断必然误伤）；看门狗只看结果，客户端走哪条路进来都能兜住。
    //
    // 节奏是**自适应**的：没人在播时 5 秒一次（省开销）；一旦检测到有人在播就每秒盯一次，
    // 这样"第二路刚起来"最多 1 秒就会被处理掉（用户明确要求：有播放时每秒监听）。
    // 只保留一个句柄（每秒一跳，句柄不能往 timers 里堆）；停止时统一清掉。
    let guardTimer: ReturnType<typeof setTimeout> | undefined;
    let guardRunning = false;
    const guardResolver = new StreamLimitResolver(database, emby);
    const scheduleGuard = (delayMs: number) => {
      if (stopped) return;
      if (guardTimer) clearTimeout(guardTimer);
      guardTimer = setTimeout(() => void streamGuardTick(), delayMs);
      guardTimer.unref?.();
    };
    guardTimers.push(() => {
      if (guardTimer) clearTimeout(guardTimer);
    });
    const streamGuardTick = async (): Promise<void> => {
      if (stopped) return;
      if (guardRunning) return scheduleGuard(1_000);
      guardRunning = true;
      try {
        const policy = getConcurrencyPolicy(database);
        if (!policy.interruptStreams) return scheduleGuard(5_000);
        const live = getRuntimeSettings();
        guardResolver.configure(policy.defaultStreamLimit, JSON.stringify([live.embyBaseUrl, live.embyApiKey]));
        const result = await enforceStreamLimits(database, emby, guardResolver);
        if (stopped) return;
        if (result.stopped > 0) {
          const label: Record<string, string> = { stop: "（请它停止）", logout: "（强制登出）", kick: "（踢设备）" };
          const detail = result.stoppedSessions
            .map((item) => `${item.deviceName}${label[item.action] ?? ""}`)
            .join("、");
          logger.info({
            event: "stream_guard",
            message: `并发超限：处理 ${result.stopped} 个多余会话（${result.overshootUsers} 个账号）—— 设备：${detail}`,
          });
        }
        scheduleGuard(result.playingUsers > 0 ? 1_000 : 5_000);
      } catch {
        scheduleGuard(5_000);
      } finally {
        guardRunning = false;
      }
    };
    scheduleGuard(1_000);
    // 内容回收（从 Emby 会话更新"最后播放时间/看完"）已随回收站整体删除：它只服务于回收候选列表，
    // 而回收的判定对象（入库内容）已经不存在了。
  }

  // 投稿自动入库（每 5 分钟把 pending 投稿转成任务并触发 TgtoDrive）已删除：
  // 应用不再创建任务，转任务这件事整体移出应用。
  // 「入库完成邮件」（轮询已转任务且已完成的投稿）也已随投稿功能整体删除。

  // 使用记录保留清理：每小时一次（未结束的区间不删，正在播的那段不会被抹掉）。
  const runUsageRetention = (): void => {
    try {
      const removed = pruneUsageHistory(database, {
        now: new Date(),
        retentionDays: settings["usage.retentionDays"],
      });
      if (removed > 0) {
        logger.info({
          event: "member_usage_pruned",
          message: `已清理 ${removed} 条过期的会员使用记录`,
          detail: JSON.stringify({ retentionDays: settings["usage.retentionDays"] }),
        });
      }
    } catch (error) {
      logger.warn({
        event: "member_usage_prune_failed",
        message: "会员使用记录清理失败",
        detail: JSON.stringify({ error: safeError(error) }),
      });
    }
  };
  timers.push(setInterval(runUsageRetention, 60 * 60_000));

  for (const timer of timers) timer.unref();

  return {
    runLibraryScan,
    runTmdbEnrichment,
    runMissingEpisodeScan,
    stop(): void {
      if (stopped) return;
      stopped = true;
      for (const cleanup of guardTimers) cleanup();
      for (const timer of timers) clearInterval(timer);
      deps.trending.stop();
      for (const shutdown of deps.onShutdown ?? []) void shutdown();
    },
  };
}
