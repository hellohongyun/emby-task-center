import { getCurrentScope, onScopeDispose, ref } from "vue";
import { fetchJsonWithTimeout } from "./request-timeout";

import type { UsageMemberDetail, UsageOverview, UsageRefreshResult } from "../types";

/**
 * 会员使用记录（登录 / 播放 / 时段）。
 *
 * 后端数据是"应用自己攒的观察记录"：每 30 秒采样一次 Emby 会话 + 回填 Emby 活动日志，
 * 所以这里只有两种动作：读汇总、点一下"立刻刷新"。
 */
export function useMemberUsage(requireAuth?: () => void) {
  const overview = ref<UsageOverview | null>(null);
  const detail = ref<UsageMemberDetail | null>(null);
  const loading = ref(false);
  const detailLoading = ref(false);
  const refreshing = ref(false);
  const error = ref("");
  let overviewController: AbortController | undefined;
  let detailController: AbortController | undefined;
  let refreshController: AbortController | undefined;
  let disposed = false;
  if (getCurrentScope())
    onScopeDispose(() => {
      disposed = true;
      overviewController?.abort();
      detailController?.abort();
      refreshController?.abort();
      loading.value = detailLoading.value = refreshing.value = false;
    });

  async function request<T>(url: string, init?: RequestInit): Promise<T> {
    const { body } = await fetchJsonWithTimeout<T>(
      async (input, options) => {
        const response = await fetch(input, options);
        if (options?.signal?.aborted) throw new DOMException("Request aborted", "AbortError");
        if (response.status === 401) {
          requireAuth?.();
          throw new Error("unauthorized");
        }
        if (!response.ok) {
          const failure = (await response.json().catch(() => ({}))) as { error?: string };
          throw new Error(failure.error ?? "request_failed");
        }
        return response;
      },
      url,
      { credentials: "include", ...init },
    );
    return body as T;
  }

  async function load(days: number, silent = false): Promise<void> {
    overviewController?.abort();
    const controller = (overviewController = new AbortController());
    loading.value = !silent;
    error.value = "";
    try {
      const body = await request<UsageOverview>(`/api/member-usage/overview?days=${days}`, {
        signal: controller.signal,
      });
      if (!controller.signal.aborted && !disposed) overview.value = body;
    } catch (caught) {
      if (!controller.signal.aborted && !disposed)
        error.value = caught instanceof Error ? caught.message : "无法加载使用记录";
    } finally {
      if (overviewController === controller) loading.value = false;
    }
  }

  async function loadDetail(key: string, days: number): Promise<void> {
    closeDetail();
    const controller = (detailController = new AbortController());
    detailLoading.value = true;
    error.value = "";
    detail.value = null;
    try {
      const body = await request<UsageMemberDetail>(
        `/api/member-usage/member?key=${encodeURIComponent(key)}&days=${days}`,
        { signal: controller.signal },
      );
      if (!controller.signal.aborted && !disposed) detail.value = body;
    } catch (caught) {
      if (!controller.signal.aborted && !disposed)
        error.value = caught instanceof Error ? caught.message : "无法加载该会员的使用记录";
    } finally {
      if (detailController === controller) detailLoading.value = false;
    }
  }

  function closeDetail(): void {
    detailController?.abort();
    detailLoading.value = false;
    detail.value = null;
  }

  /** 立刻去 Emby 采一次 + 回填活动日志，然后刷新汇总（首屏就有数据，不用等定时任务）。 */
  async function refreshNow(days: number): Promise<UsageRefreshResult | null> {
    if (refreshing.value || disposed) return null;
    const controller = (refreshController = new AbortController());
    const overviewAtStart = overviewController;
    refreshing.value = true;
    error.value = "";
    try {
      const result = await request<UsageRefreshResult>("/api/member-usage/refresh", {
        method: "POST",
        signal: controller.signal,
      });
      if (controller.signal.aborted || disposed) return null;
      if (overviewController === overviewAtStart) await load(days, true);
      return result;
    } catch (caught) {
      if (!controller.signal.aborted && !disposed) error.value = caught instanceof Error ? caught.message : "刷新失败";
      return null;
    } finally {
      refreshing.value = false;
    }
  }

  return { overview, detail, loading, detailLoading, refreshing, error, load, loadDetail, closeDetail, refreshNow };
}
