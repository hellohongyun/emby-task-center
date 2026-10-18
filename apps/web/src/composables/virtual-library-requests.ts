import { getCurrentScope, onScopeDispose, ref, type Ref } from "vue";
import { fetchJsonWithTimeout } from "./request-timeout";

/** Each lane cancels superseded reads; disposal and expired auth cancel every lane. */
export function virtualLibraryRequests(requireAuth: () => void) {
  const error = ref("");
  const controllers = new Map<string, AbortController>();
  const busyOwners = new WeakMap<Ref<boolean>, AbortController>();
  let stopped = false;
  function cancel() {
    stopped = true;
    for (const controller of controllers.values()) controller.abort();
    controllers.clear();
  }
  if (getCurrentScope()) onScopeDispose(cancel);

  async function run<T>(lane: string, busy: Ref<boolean>, path: string, init: RequestInit = {}): Promise<T | null> {
    if (stopped) return null;
    controllers.get(lane)?.abort();
    const controller = new AbortController();
    controllers.set(lane, controller);
    busyOwners.set(busy, controller);
    busy.value = true;
    error.value = "";
    try {
      const { body } = await fetchJsonWithTimeout<T>(
        async (url, options) => {
          const response = await fetch(url, options);
          if (options?.signal?.aborted || stopped) throw new DOMException("Request aborted", "AbortError");
          if (response.status === 401) {
            cancel();
            requireAuth();
            throw new Error("登录已过期，请重新登录");
          }
          if (!response.ok) {
            const failure = (await response.json().catch(() => ({}))) as { message?: string; error?: string };
            throw new Error(failure.message || failure.error || "请求失败，请重试");
          }
          return response.status === 204 ? new Response("{}") : response;
        },
        `/api/virtual-libraries${path}`,
        {
          credentials: "include",
          ...init,
          signal: controller.signal,
          headers: { "Content-Type": "application/json", ...init.headers },
        },
      );
      return controller.signal.aborted || stopped ? null : (body as T);
    } catch (caught) {
      if (!controller.signal.aborted && !stopped)
        error.value = caught instanceof Error && caught.name !== "AbortError" ? caught.message : "请求超时，请重试";
      return null;
    } finally {
      if (busyOwners.get(busy) === controller) busy.value = false;
    }
  }
  return { run, error, cancel };
}
