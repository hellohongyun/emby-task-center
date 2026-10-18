import { getCurrentScope, onMounted, onScopeDispose, ref } from "vue";

import type { MissingEpisodesDeleteResult, MissingEpisodesPayload } from "../types";
import { fetchJsonWithTimeout } from "./request-timeout";

interface Options {
  fetchImpl?: typeof fetch;
  requireAuth?: () => void;
  autoLoad?: boolean;
}

/**
 * 缺集总览（全库）的数据源：
 * - GET /api/missing-episodes 读后台扫描器写入的快照；
 * - POST /api/missing-episodes/scan 手动触发一轮检测（后台跑，进入快轮询看进度）；
 * - POST /api/missing-episodes/delete 批量调 Emby 删除接口删剧。
 */
export function useMissingEpisodes(options: Options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const payload = ref<MissingEpisodesPayload | null>(null);
  const selectedRootId = ref("");
  const loading = ref(false);
  const deleting = ref(false);
  const scanStarting = ref(false);
  const error = ref("");
  const actionMessage = ref("");
  let refreshTimer: ReturnType<typeof setInterval> | undefined;
  let scanPollTimer: ReturnType<typeof setInterval> | undefined;
  const controllers = new Map<string, AbortController>();
  let stopped = false;
  let pollRevision = 0;

  const active = (lane: string, controller: AbortController) =>
    !stopped && !controller.signal.aborted && controllers.get(lane) === controller;

  function begin(lane: string) {
    controllers.get(lane)?.abort();
    const controller = new AbortController();
    controllers.set(lane, controller);
    return controller;
  }

  /** A disposed page or expired session must never be revived by an in-flight response. */
  function cancel() {
    stopped = true;
    stopAutoRefresh();
    stopScanPolling();
    for (const controller of controllers.values()) controller.abort();
    controllers.clear();
    loading.value = deleting.value = scanStarting.value = false;
  }
  if (getCurrentScope()) onScopeDispose(cancel);

  async function request<T>(lane: string, controller: AbortController, path = "", init: RequestInit = {}) {
    const { response, body } = await fetchJsonWithTimeout<T>(
      fetchImpl,
      `/api/missing-episodes${path}`,
      { ...init, credentials: "include", signal: controller.signal },
      lane === "delete" ? 180_000 : 15_000,
    );
    if (!active(lane, controller)) return null;
    if (response.status === 401) {
      cancel();
      payload.value = null;
      options.requireAuth?.();
      return null;
    }
    if (!response.ok) throw new Error("failed");
    return body as T;
  }

  function stopAutoRefresh() {
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = undefined;
    }
  }

  function startAutoRefresh(intervalMs = 60_000) {
    if (stopped) return;
    stopAutoRefresh();
    refreshTimer = setInterval(() => {
      if (!loading.value) void load();
    }, intervalMs);
  }

  function stopScanPolling() {
    pollRevision += 1;
    if (scanPollTimer) {
      clearInterval(scanPollTimer);
      scanPollTimer = undefined;
    }
  }

  /** 检测期间快轮询：进度与结果几分钟内就能看到；检测结束后回到常规 60 秒刷新。 */
  function startScanPolling(intervalMs = 5_000) {
    if (stopped) return;
    stopScanPolling();
    stopAutoRefresh();
    const revision = pollRevision;
    scanPollTimer = setInterval(() => {
      if (loading.value) return;
      void (async () => {
        await load();
        if (stopped || revision !== pollRevision) return;
        if (error.value || !payload.value?.scanning) {
          stopScanPolling();
          startAutoRefresh();
        }
      })();
    }, intervalMs);
  }

  async function load(rootId?: string) {
    if (stopped) return;
    if (rootId !== undefined && rootId !== selectedRootId.value) {
      selectedRootId.value = rootId;
      payload.value = null;
      actionMessage.value = "";
    }
    const controller = begin("load");
    loading.value = true;
    error.value = "";
    try {
      const query = selectedRootId.value ? `?${new URLSearchParams({ rootId: selectedRootId.value })}` : "";
      const body = await request<MissingEpisodesPayload>("load", controller, query);
      if (!body || !active("load", controller)) return;
      if (!Array.isArray(body.shows)) throw new Error("invalid");
      payload.value = body;
      if ("rootId" in body)
        selectedRootId.value = (body as MissingEpisodesPayload & { rootId?: string | null }).rootId ?? "";
      // Opening a page during an existing scan also receives the fast progress updates.
      if (body.scanning && refreshTimer && !scanPollTimer) startScanPolling();
    } catch {
      if (active("load", controller)) error.value = "缺集清单暂时不可用，请稍后重试。";
    } finally {
      if (active("load", controller)) {
        loading.value = false;
        controllers.delete("load");
      }
    }
  }

  async function triggerScan(): Promise<void> {
    if (stopped || scanStarting.value) return;
    const controller = begin("scan");
    scanStarting.value = true;
    actionMessage.value = "";
    try {
      const result = await request("scan", controller, "/scan", { method: "POST" });
      if (!result || !active("scan", controller)) return;
      actionMessage.value = "已开始全库检测：首次全量需要几分钟，进度会自动刷新。";
      await load();
      if (active("scan", controller) && payload.value?.scanning && !error.value) startScanPolling();
    } catch {
      if (active("scan", controller)) actionMessage.value = "无法启动检测，请稍后重试。";
    } finally {
      if (active("scan", controller)) {
        scanStarting.value = false;
        controllers.delete("scan");
      }
    }
  }

  async function deleteShows(mediaItemIds: number[], rootId: string): Promise<MissingEpisodesDeleteResult | null> {
    if (stopped || deleting.value || !mediaItemIds.length || !rootId.trim()) return null;
    const controller = begin("delete");
    const selectedAtStart = selectedRootId.value;
    deleting.value = true;
    actionMessage.value = "";
    try {
      const body = await request<MissingEpisodesDeleteResult>("delete", controller, "/delete", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mediaItemIds, rootId }),
      });
      if (!body || !active("delete", controller) || selectedRootId.value !== selectedAtStart) return null;
      if (!Array.isArray(body.results)) throw new Error("invalid");
      const failed = body.results.filter((result) => !result.ok);
      const reasons: Record<string, string> = {
        no_missing_episodes: "当前库已无实际缺集，已跳过",
        missing_metadata_incomplete: "分集元数据不完整，未删除",
        emby_episode_read_failed: "无法完整读取分集，未删除",
        outside_media_root: "已不属于当前库，未删除",
        media_root_changed: "媒体库配置已变化，请刷新",
        emby_connection_changed: "Emby 连接已变化，请刷新",
        media_item_changed: "作品关联已变化，请刷新",
      };
      actionMessage.value = failed.length
        ? `已删除 ${body.deleted} 部；${failed.length} 部失败（${failed
            .slice(0, 3)
            .map(
              (result) =>
                `${result.title || `#${result.mediaItemId}`}${result.error && reasons[result.error] ? `：${reasons[result.error]}` : ""}`,
            )
            .join("、")}${failed.length > 3 ? " 等" : ""}）。`
        : `已从 Emby 删除 ${body.deleted} 部剧。`;
      await load();
      return active("delete", controller) ? body : null;
    } catch {
      if (active("delete", controller) && selectedRootId.value === selectedAtStart)
        actionMessage.value = "删除请求未完成，请刷新核对结果后再重试。";
      return null;
    } finally {
      if (active("delete", controller)) {
        deleting.value = false;
        controllers.delete("delete");
      }
    }
  }

  if (options.autoLoad !== false) onMounted(() => void load());
  return {
    payload,
    selectedRootId,
    loading,
    deleting,
    scanStarting,
    error,
    actionMessage,
    load,
    deleteShows,
    triggerScan,
    startAutoRefresh,
    stopAutoRefresh,
    stopScanPolling,
    cancel,
  };
}
