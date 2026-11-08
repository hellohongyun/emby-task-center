import { and, asc, eq, isNotNull } from "drizzle-orm";
import type { AppDatabase } from "@emby-task-center/database/client";
import { submissionUsers } from "@emby-task-center/database/schema";
import type { EmbyClient } from "../integrations/emby-client";
import { workflowLog, type WorkflowLogger } from "../logging/workflow-log";
import { syncMemberQqAvatar, type AvatarRefreshOutcome } from "./member-qq-avatar";

const oneHour = 60 * 60_000;

export function startQqAvatarRefresh(options: {
  database: AppDatabase;
  emby: EmbyClient;
  logger: WorkflowLogger;
  intervalMs?: number;
  enabled?: () => boolean;
}) {
  const { database, emby, logger } = options;
  const controller = new AbortController();
  let running: Promise<void> | undefined;

  async function sweep() {
    if (!emby.configured || options.enabled?.() === false) return;
    const members = database
      .select({ id: submissionUsers.id })
      .from(submissionUsers)
      .where(
        and(
          eq(submissionUsers.enabled, true),
          isNotNull(submissionUsers.qqNumber),
          isNotNull(submissionUsers.qqAvatarSyncedTag),
          eq(submissionUsers.qqAvatarSyncedEmbyUserId, submissionUsers.embyUserId),
        ),
      )
      .orderBy(asc(submissionUsers.id))
      .all();
    if (!members.length) return;

    const log = workflowLog(logger, "qq-avatar");
    const started = Date.now();
    const totals: Record<AvatarRefreshOutcome, number> = {
      updated: 0,
      unchanged: 0,
      preserved: 0,
      unavailable: 0,
      failed: 0,
      skipped: 0,
    };
    log.write("info", "avatar_refresh_started", `开始定时检查 QQ 头像，本轮 ${members.length} 位会员`, {
      total: members.length,
    });
    let checked = 0;
    for (const { id } of members) {
      if (controller.signal.aborted || options.enabled?.() === false) break;
      try {
        const outcome = await syncMemberQqAvatar(database, emby, id, {
          managedOnly: true,
          signal: controller.signal,
          log,
        });
        totals[outcome]++;
      } catch {
        totals.failed++;
        log.write("warn", "avatar_refresh_member_failed", `会员 #${id} 的头像检查失败`, { memberId: id });
      }
      checked++;
      if (checked % 25 === 0 && checked < members.length) {
        log.write("info", "avatar_refresh_progress", `已检查 ${checked} / ${members.length} 位会员`, { checked });
      }
    }
    const stopped = controller.signal.aborted || options.enabled?.() === false;
    log.write(
      totals.failed ? "warn" : "info",
      stopped ? "avatar_refresh_stopped" : "avatar_refresh_finished",
      `${stopped ? "检查已停止" : "检查完成"}，已检查 ${checked} 位，更新 ${totals.updated} 位，无变化 ${totals.unchanged} 位，失败 ${totals.failed} 位`,
      { checked, ...totals },
      Date.now() - started,
    );
  }

  function run() {
    if (controller.signal.aborted) return Promise.resolve();
    if (!running) {
      running = sweep()
        .catch(() => {
          workflowLog(logger, "qq-avatar").write("error", "avatar_refresh_failed", "读取定时头像检查名单失败");
        })
        .finally(() => {
          running = undefined;
        });
    }
    return running;
  }

  const timer = setInterval(() => {
    void run();
  }, options.intervalMs ?? oneHour);
  timer.unref();
  function stop() {
    clearInterval(timer);
    controller.abort();
  }
  return {
    run,
    stop,
    async close() {
      stop();
      await running;
    },
  };
}
