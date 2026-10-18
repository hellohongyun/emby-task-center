import { fetchJsonWithTimeout, fetchWithTimeout } from "./request-timeout";

/** Task writes belong to a login identity, independently of list refreshes. */
export function createTaskActionRequests(fetchImpl: typeof fetch, requireAuth: () => void, load: () => Promise<void>) {
  let epoch = 0;
  let stopped = false;
  const pending = new Set<AbortController>();
  function invalidate() {
    epoch += 1;
    for (const controller of pending) controller.abort();
    pending.clear();
  }
  function stop() {
    stopped = true;
    invalidate();
  }
  async function request<T>(
    url: string,
    init: RequestInit = {},
    options: { refresh?: boolean; timeoutMs?: number; readBody?: boolean; readErrorBody?: boolean } = {},
  ): Promise<{ response: Response; body: T | undefined }> {
    const identity = epoch;
    const active = () => !stopped && identity === epoch;
    const check = () => {
      if (!active()) throw new DOMException("Request aborted", "AbortError");
    };
    check();
    const controller = new AbortController();
    pending.add(controller);
    let unauthorized = false;
    try {
      const input = { ...init, credentials: "include" as const, signal: controller.signal };
      const result =
        options.readBody === false
          ? { response: await fetchWithTimeout(fetchImpl, url, input, options.timeoutMs), body: undefined }
          : await fetchJsonWithTimeout<T>(fetchImpl, url, input, options.timeoutMs, options.readErrorBody);
      check();
      if (result.response.status === 401) {
        unauthorized = true;
        requireAuth();
        throw new Error("unauthorized");
      }
      if (result.response.ok && options.refresh) {
        await load();
        check();
      }
      return result;
    } catch (error) {
      if (unauthorized) throw error;
      check();
      if (
        error &&
        typeof error === "object" &&
        "name" in error &&
        error.name === "AbortError" &&
        !controller.signal.aborted
      )
        throw Object.assign(new Error("请求超时，操作结果尚未确认，请刷新检查后再重试。"), { cause: error });
      throw error;
    } finally {
      pending.delete(controller);
    }
  }
  return { request, invalidate, stop };
}
