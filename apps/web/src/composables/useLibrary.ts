import { getCurrentScope, onScopeDispose, ref } from "vue";
import type { LibraryItem, LibraryRoot } from "../types";
import type { LibraryFilterValues } from "../library/filters";
import type { LibraryOverview, LibraryWorksPage } from "../library/paged-library";
import { fetchJsonWithTimeout } from "./request-timeout";

interface UseLibraryOptions {
  fetchImpl?: typeof fetch;
  requireAuth?: () => void;
}

interface MatchUnresolvedResult {
  matchedGroups: number;
  createdMediaItems: number;
  linkedLibraryItems: number;
  failedGroups: number;
  cleaned: number;
}

/** Only summaries and the selected page are loaded; episode rows are fetched on demand. */
export function useLibrary(options: UseLibraryOptions = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const roots = ref<LibraryRoot[]>([]);
  const overview = ref<LibraryOverview | null>(null);
  const worksPage = ref<LibraryWorksPage | null>(null);
  const loading = ref(false);
  const summaryLoading = ref(false);
  const scanningRootId = ref<string | null>(null);
  const error = ref("");
  const controllers = new Set<AbortController>();
  let disposed = false;
  let epoch = 0;
  let pageController: AbortController | undefined;
  let detailController: AbortController | undefined;
  let pageSequence = 0;
  let overviewRequest: Promise<void> | null = null;
  const current = (generation: number) => !disposed && generation === epoch;
  const aborted = () => new DOMException("Request aborted", "AbortError");

  async function request<T>(url: string, init?: RequestInit, timeoutMs = 15_000): Promise<T> {
    if (disposed || init?.signal?.aborted) throw aborted();
    const generation = epoch;
    const controller = new AbortController();
    const cancel = () => controller.abort();
    init?.signal?.addEventListener("abort", cancel, { once: true });
    controllers.add(controller);
    try {
      const { response, body } = await fetchJsonWithTimeout<T>(
        fetchImpl,
        url,
        { ...init, signal: controller.signal, credentials: "include" },
        timeoutMs,
      );
      if (!current(generation) || controller.signal.aborted) throw aborted();
      if (response.status === 401) {
        options.requireAuth?.();
        throw new Error("unauthorized");
      }
      if (!response.ok) throw new Error("request_failed");
      return body as T;
    } finally {
      controllers.delete(controller);
      init?.signal?.removeEventListener("abort", cancel);
    }
  }

  function loadRoots(): Promise<void> {
    if (disposed) return Promise.resolve();
    if (overviewRequest) return overviewRequest;
    const generation = epoch;
    summaryLoading.value = true;
    error.value = "";
    const pending = (async () => {
      try {
        const body = await request<LibraryOverview>("/api/library/summary");
        if (!current(generation)) return;
        roots.value = body.roots;
        overview.value = body;
      } catch (caught) {
        if (current(generation) && (caught as Error).message !== "unauthorized")
          error.value = "无法读取媒体库概览，请稍后重试。";
      } finally {
        if (current(generation)) {
          summaryLoading.value = false;
          overviewRequest = null;
        }
      }
    })();
    overviewRequest = pending;
    return pending;
  }

  async function loadWorks(rootId: string, page: number, filters: LibraryFilterValues) {
    if (disposed) return;
    const generation = epoch;
    const sequence = ++pageSequence;
    pageController?.abort();
    pageController = new AbortController();
    const signal = pageController.signal;
    const isCurrent = () => current(generation) && sequence === pageSequence && !signal.aborted;
    if (worksPage.value?.root.id !== rootId) worksPage.value = null;
    loading.value = true;
    error.value = "";
    const params = new URLSearchParams({ page: String(page), pageSize: "48" });
    for (const [key, value] of Object.entries(filters)) {
      if (value && value !== "all") params.set(key === "query" ? "q" : key, value);
    }
    try {
      const result = await request<LibraryWorksPage>(
        `/api/library/roots/${encodeURIComponent(rootId)}/works?${params}`,
        { signal },
      );
      if (isCurrent()) worksPage.value = result;
    } catch (caught) {
      if (isCurrent() && (caught as Error).message !== "unauthorized") {
        error.value = "无法读取当前媒体库，请稍后重试。";
      }
    } finally {
      if (isCurrent()) loading.value = false;
    }
  }

  function cancelPage() {
    pageSequence += 1;
    pageController?.abort();
    loading.value = false;
  }

  function cancelItems() {
    detailController?.abort();
  }

  function loadItems(rootId: string, key: string) {
    if (disposed) return Promise.reject(aborted());
    cancelItems();
    detailController = new AbortController();
    return request<{ items: LibraryItem[] }>(
      `/api/library/roots/${encodeURIComponent(rootId)}/works/items?key=${encodeURIComponent(key)}`,
      { signal: detailController.signal },
    );
  }

  async function scan(rootId: string): Promise<boolean> {
    if (disposed || scanningRootId.value) return false;
    const generation = epoch;
    scanningRootId.value = rootId;
    error.value = "";
    try {
      await request(`/api/library/roots/${encodeURIComponent(rootId)}/scan`, { method: "POST" }, 180_000);
      return current(generation);
    } catch (caught) {
      if (current(generation) && (caught as Error).message !== "unauthorized")
        error.value = "扫描失败，请检查 Emby 连接后重试。";
      return false;
    } finally {
      if (current(generation)) scanningRootId.value = null;
    }
  }

  async function matchUnresolved(limit = 200): Promise<MatchUnresolvedResult | null> {
    if (disposed) return null;
    const generation = epoch;
    try {
      const result = await request<MatchUnresolvedResult>(
        `/api/library/match-unresolved?limit=${limit}`,
        { method: "POST" },
        180_000,
      );
      return current(generation) ? result : null;
    } catch {
      return null;
    }
  }

  /** A view can leave and re-enter while the AdminShell scope remains alive. */
  function cancelRequests() {
    epoch += 1;
    for (const controller of controllers) controller.abort();
    cancelPage();
    cancelItems();
    overviewRequest = null;
    summaryLoading.value = false;
    scanningRootId.value = null;
  }

  if (getCurrentScope())
    onScopeDispose(() => {
      disposed = true;
      cancelRequests();
    });
  return {
    roots,
    overview,
    worksPage,
    loading,
    summaryLoading,
    scanningRootId,
    error,
    loadRoots,
    loadWorks,
    loadItems,
    cancelPage,
    cancelItems,
    cancelRequests,
    scan,
    matchUnresolved,
  };
}
