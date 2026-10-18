import { onUnmounted, ref } from "vue";

import type { LogEntry } from "../types";

export interface UseLogsOptions {
  fetchImpl?: typeof fetch;
  autoRefreshMs?: number;
}

const PAGE_LIMIT = 100;

export function useLogs(requireAuth: () => void, options: UseLogsOptions = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const autoRefreshMs = options.autoRefreshMs ?? 0;
  const logs = ref<LogEntry[]>([]);
  const loading = ref(false);
  const error = ref("");
  const level = ref("");
  const source = ref("");
  const query = ref("");
  const hasMore = ref(false);
  let timer: ReturnType<typeof setInterval> | null = null;

  async function get<T>(url: string): Promise<T> {
    const response = await fetchImpl(url, { credentials: "include" });
    if (response.status === 401) {
      requireAuth();
      throw new Error("unauthorized");
    }
    if (!response.ok) throw new Error("failed");
    return response.json() as Promise<T>;
  }

  function buildUrl(cursor?: number): string {
    const params = new URLSearchParams();
    params.set("limit", String(PAGE_LIMIT));
    if (level.value) params.set("level", level.value);
    if (source.value) params.set("source", source.value);
    if (query.value.trim()) params.set("q", query.value.trim());
    if (cursor != null) params.set("before", String(cursor));
    const qs = params.toString();
    return `/api/logs${qs ? `?${qs}` : ""}`;
  }

  async function load() {
    loading.value = true;
    error.value = "";
    try {
      const body = await get<{ logs: LogEntry[] }>(buildUrl());
      const items = Array.isArray(body.logs) ? body.logs : [];
      logs.value = items;
      hasMore.value = items.length >= PAGE_LIMIT;
    } catch (caught) {
      if ((caught as Error).message !== "unauthorized") error.value = "无法读取日志，请稍后重试。";
    } finally {
      loading.value = false;
    }
  }

  async function loadMore() {
    if (loading.value || logs.value.length === 0) return;
    const cursor = logs.value[logs.value.length - 1]?.id;
    if (cursor == null) return;
    loading.value = true;
    error.value = "";
    try {
      const body = await get<{ logs: LogEntry[] }>(buildUrl(cursor));
      const items = Array.isArray(body.logs) ? body.logs : [];
      const seen = new Set(logs.value.map((entry) => entry.id));
      logs.value = logs.value.concat(items.filter((entry) => !seen.has(entry.id)));
      hasMore.value = items.length >= PAGE_LIMIT;
    } catch (caught) {
      if ((caught as Error).message !== "unauthorized") error.value = "无法加载更多日志，请稍后重试。";
    } finally {
      loading.value = false;
    }
  }

  function setLevel(next: string) {
    level.value = next;
    void load();
  }

  function setSource(next: string) {
    source.value = next;
    void load();
  }

  function setQuery(next: string) {
    query.value = next;
    void load();
  }

  if (autoRefreshMs > 0) {
    timer = setInterval(() => {
      void load();
    }, autoRefreshMs);
  }
  onUnmounted(() => {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  });

  return { logs, loading, error, level, source, query, hasMore, setLevel, setSource, setQuery, load, loadMore };
}
