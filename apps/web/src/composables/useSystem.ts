import { getCurrentScope, onScopeDispose, ref } from "vue";
import { fetchJsonWithTimeout } from "./request-timeout";

export interface SystemStatus {
  rootCount: number;
  lastScanAt: string | null;
  serverTime: string;
  serverTimezone?: string;
}
export interface ActivityItem {
  id: number;
  taskId: number;
  title: string;
  phase: string;
  workerId: string | null;
  startedAt: string;
  finishedAt: string | null;
  summary: string | null;
  error: string | null;
}

export function useSystem(requireAuth: () => void, fetchImpl: typeof fetch = fetch) {
  const status = ref<SystemStatus | null>(null);
  const activity = ref<ActivityItem[]>([]);
  const loading = ref(false);
  const error = ref("");
  let controller: AbortController | undefined;
  let stopped = false;
  function cancel() {
    controller?.abort();
    controller = undefined;
    loading.value = false;
  }
  if (getCurrentScope())
    onScopeDispose(() => {
      stopped = true;
      cancel();
    });
  async function get<T>(url: string, current: AbortController): Promise<T> {
    const { response, body } = await fetchJsonWithTimeout<T>(fetchImpl, url, {
      credentials: "include",
      signal: current.signal,
    });
    if (stopped || controller !== current) throw new DOMException("Request aborted", "AbortError");
    if (response.status === 401) {
      requireAuth();
      throw new Error("unauthorized");
    }
    if (!response.ok) throw new Error("failed");
    return body as T;
  }
  async function load() {
    if (stopped) return;
    cancel();
    const current = (controller = new AbortController());
    const active = () => !stopped && controller === current;
    loading.value = true;
    error.value = "";
    try {
      const [statusBody, activityBody] = await Promise.all([
        get<SystemStatus>("/api/system/status", current),
        get<{ activity: ActivityItem[] }>("/api/activity", current),
      ]);
      if (!active()) return;
      status.value = statusBody;
      activity.value = activityBody.activity ?? [];
    } catch (caught) {
      if (active() && (caught as Error).message !== "unauthorized") error.value = "无法读取系统状态，请稍后重试。";
    } finally {
      if (active()) {
        current.abort();
        controller = undefined;
        loading.value = false;
      }
    }
  }
  return { status, activity, loading, error, load, cancel };
}
