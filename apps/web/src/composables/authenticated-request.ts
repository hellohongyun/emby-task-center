import { getCurrentScope, onScopeDispose, ref } from "vue";
import { guardedPortalFetch, portalIdentityRevision } from "./portal-access";
import { fetchJsonWithTimeout } from "./request-timeout";

/** Each mounted page owns its requests; late responses cannot cross identities. */
export function useAuthenticatedRequest(
  messages: Readonly<Record<string, string>>,
  admin = false,
  requireAuth: () => void = () => {},
) {
  const error = ref("");
  const busy = ref<Record<string, boolean>>({});
  const pending = new Map<string, AbortController>();
  let stopped = false;
  function cancel(key?: string) {
    for (const [name, controller] of pending) {
      if (key !== undefined && name !== key) continue;
      controller.abort();
      pending.delete(name);
      busy.value[name] = false;
    }
  }
  if (getCurrentScope())
    onScopeDispose(() => {
      stopped = true;
      cancel();
    });

  async function run<T>(key: string, url: string, init: RequestInit = {}): Promise<T | null> {
    if (stopped) return null;
    cancel(key);
    const controller = new AbortController();
    const identity = portalIdentityRevision();
    pending.set(key, controller);
    busy.value[key] = true;
    error.value = "";
    const current = () =>
      !stopped &&
      pending.get(key) === controller &&
      !controller.signal.aborted &&
      (admin || identity === portalIdentityRevision());
    try {
      const { response, body } = await fetchJsonWithTimeout<T & { error?: string; message?: string }>(
        (input, options) => (admin ? fetch(input, options) : guardedPortalFetch(input, options, current)),
        url,
        { credentials: "include", ...init, signal: controller.signal },
        15_000,
        true,
      );
      if (!current()) return null;
      if (response.status === 401 && admin) requireAuth();
      if (!response.ok) throw new Error(messages[body?.error ?? ""] ?? body?.message ?? "操作失败，请稍后重试。");
      return body as T;
    } catch (caught) {
      if (current())
        error.value =
          caught instanceof Error && caught.name !== "AbortError"
            ? caught.message
            : init.method && init.method !== "GET"
              ? "等待超时，提交结果尚未确认，请刷新记录核对后再操作。"
              : "请求超时，请重试。";
      return null;
    } finally {
      if (pending.get(key) === controller) {
        pending.delete(key);
        busy.value[key] = false;
      }
    }
  }
  return { run, cancel, error, busy };
}
