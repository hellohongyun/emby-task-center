import { onMounted, onUnmounted, ref } from "vue";

import type { LogEntry } from "../types";
import { fetchJsonWithTimeout } from "./request-timeout";

export interface UseLogsOptions {
  fetchImpl?: typeof fetch;
  autoRefreshMs?: number;
}

interface LogsPage {
  logs: LogEntry[];
  hasMore?: boolean;
  nextAfter?: number;
}

type LoadMode = "initial" | "newer" | "older";
const pageLimit = 100;
const maxVisibleLogs = 1_200;

export function useLogs(requireAuth: () => void, options: UseLogsOptions = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const refreshMs = options.autoRefreshMs ?? 1_000;
  const logs = ref<LogEntry[]>([]);
  const loading = ref(false);
  const error = ref("");
  const paused = ref(false);
  const following = ref(true);
  const hasMore = ref(false);
  const level = ref("");
  const source = ref("");
  const module = ref("");
  const query = ref("");
  const runId = ref("");
  let latest: number | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active: { controller: AbortController; mode: LoadMode } | undefined;
  let disposed = false;
  let authorized = true;

  function filterParams() {
    const params = new URLSearchParams();
    for (const [name, filter] of Object.entries({ level, source, module, runId, q: query })) {
      if (filter.value.trim()) params.set(name, filter.value.trim());
    }
    return params;
  }

  function downloadUrl() {
    const params = filterParams().toString();
    return "/api/logs/download" + (params ? "?" + params : "");
  }

  function clearTimer() {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  }

  function schedule(delay = refreshMs) {
    clearTimer();
    if (!authorized || disposed || paused.value || refreshMs <= 0 || document.hidden) return;
    if (!following.value && logs.value.length >= maxVisibleLogs) return;
    timer = setTimeout(() => {
      timer = undefined;
      void refresh();
    }, delay);
  }

  function cancelActive() {
    const current = active;
    active = undefined;
    current?.controller.abort();
    loading.value = false;
  }

  async function load(mode: LoadMode) {
    if (active || !authorized || disposed) return;
    const oldest = logs.value[0]?.id;
    if (mode === "older" && (!oldest || logs.value.length >= maxVisibleLogs)) return;
    const requestedAfter = latest;
    const params = filterParams();
    params.set("limit", String(pageLimit));
    if (mode === "older") params.set("before", String(oldest));
    if (mode === "newer") params.set("after", String(requestedAfter ?? 0));

    clearTimer();
    const current = { controller: new AbortController(), mode };
    active = current;
    loading.value = mode !== "newer";
    let moreNewer = false;
    try {
      const { response, body } = await fetchJsonWithTimeout<LogsPage>(
        fetchImpl,
        "/api/logs?" + params.toString(),
        { credentials: "include", signal: current.controller.signal },
        10_000,
        true,
      );
      if (active !== current || disposed) return;
      if (response.status === 401) {
        authorized = false;
        requireAuth();
        return;
      }
      if (!response.ok || !body || !Array.isArray(body.logs)) throw new Error("logs_request_failed");
      error.value = "";
      if (mode === "newer" && body.nextAfter != null && requestedAfter != null && body.nextAfter < requestedAfter) {
        reset();
        return;
      }

      const items = [...body.logs].sort((a, b) => a.id - b.id);
      if (mode !== "older") {
        latest = body.nextAfter ?? Math.max(mode === "initial" ? 0 : (latest ?? 0), items[items.length - 1]?.id ?? 0);
      }
      if (mode === "initial") {
        logs.value = items;
        hasMore.value = body.hasMore ?? items.length >= pageLimit;
      } else {
        const seen = new Set(logs.value.map((entry) => entry.id));
        const incoming = items.filter((entry) => !seen.has(entry.id));
        if (mode === "older") {
          if (incoming.length) logs.value = [...incoming, ...logs.value];
          hasMore.value = body.hasMore ?? items.length >= pageLimit;
        } else {
          if (incoming.length) {
            const combined = [...logs.value, ...incoming];
            if (following.value && combined.length > maxVisibleLogs) {
              logs.value = combined.slice(-maxVisibleLogs);
              hasMore.value = true;
            } else logs.value = combined;
          }
          moreNewer = body.hasMore === true && latest !== requestedAfter;
        }
      }
    } catch {
      if (active === current && !disposed) {
        error.value = mode === "older" ? "无法加载更多日志，请稍后重试。" : "无法读取日志，请稍后重试。";
      }
    } finally {
      if (active === current) {
        active = undefined;
        loading.value = false;
        schedule(moreNewer ? 0 : refreshMs);
      }
    }
  }

  function refresh() {
    return load(latest === undefined ? "initial" : "newer");
  }

  function reset() {
    cancelActive();
    latest = undefined;
    error.value = "";
    logs.value = [];
    hasMore.value = false;
    following.value = true;
    void refresh();
  }

  function togglePause() {
    paused.value = !paused.value;
    if (paused.value) {
      clearTimer();
      if (active?.mode === "newer") cancelActive();
    } else if (!document.hidden) void refresh();
  }

  function setFollowing(value: boolean) {
    if (following.value === value) return;
    following.value = value;
    if (!active) schedule(value ? 0 : refreshMs);
  }

  function visibilityChanged() {
    if (document.hidden) {
      clearTimer();
      if (active?.mode === "newer") cancelActive();
    } else if (!paused.value) void refresh();
  }

  onMounted(() => {
    document.addEventListener("visibilitychange", visibilityChanged);
    void refresh();
  });
  onUnmounted(() => {
    disposed = true;
    clearTimer();
    cancelActive();
    document.removeEventListener("visibilitychange", visibilityChanged);
  });

  return {
    logs,
    loading,
    error,
    paused,
    following,
    hasMore,
    maxVisibleLogs,
    level,
    source,
    module,
    runId,
    query,
    reset,
    refresh,
    downloadUrl,
    togglePause,
    setFollowing,
    loadMore: () => load("older"),
  };
}
