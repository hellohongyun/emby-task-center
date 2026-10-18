import { fetchJsonWithTimeout } from "./request-timeout";

export function createCardRequests(requireAuth?: () => void) {
  let stopped = false;
  const controllers = new Set<AbortController>();
  const active = () => !stopped;
  async function request<T>(url: string, init: RequestInit = {}, current = active, timeoutMs = 15_000): Promise<T> {
    if (!active() || !current()) throw new DOMException("Request aborted", "AbortError");
    const controller = new AbortController();
    controllers.add(controller);
    const abort = () => controller.abort();
    if (init.signal?.aborted) abort();
    init.signal?.addEventListener("abort", abort, { once: true });
    try {
      const { response, body } = await fetchJsonWithTimeout<T & { error?: string }>(
        fetch,
        url,
        { credentials: "include", ...init, signal: controller.signal },
        timeoutMs,
        true,
      );
      if (!active() || !current() || controller.signal.aborted) throw new DOMException("Request aborted", "AbortError");
      if (response.status === 401) {
        requireAuth?.();
        throw new Error("unauthorized");
      }
      if (!response.ok) throw new Error(body?.error ?? "request_failed");
      return body as T;
    } finally {
      controllers.delete(controller);
      init.signal?.removeEventListener("abort", abort);
    }
  }
  function stop() {
    stopped = true;
    controllers.forEach((controller) => controller.abort());
    controllers.clear();
  }
  return { request, active, stop };
}
