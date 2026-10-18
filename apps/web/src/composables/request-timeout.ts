/** Abort stalled requests and settle even when a fetch mock/transport ignores abort. */
export async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  url: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs = 15_000,
): Promise<Response> {
  return timedRequest(fetchImpl, url, init, timeoutMs, async (response) => response);
}

/** Keep the deadline through the response body, not just receipt of headers. */
export function fetchJsonWithTimeout<T>(
  fetchImpl: typeof fetch,
  url: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs = 15_000,
  readErrorBody = false,
): Promise<{ response: Response; body: T | undefined }> {
  return timedRequest(fetchImpl, url, init, timeoutMs, async (response) => ({
    response,
    body: response.ok
      ? ((await response.json()) as T)
      : readErrorBody
        ? ((await response.json().catch(() => undefined)) as T | undefined)
        : undefined,
  }));
}

async function timedRequest<T>(
  fetchImpl: typeof fetch,
  url: RequestInfo | URL,
  init: RequestInit,
  timeoutMs: number,
  consume: (response: Response) => Promise<T>,
): Promise<T> {
  if (init.signal?.aborted) throw new DOMException("Request aborted", "AbortError");
  const controller = new AbortController();
  let rejectAbort: (reason: Error) => void = () => undefined;
  const cancelled = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const cancel = () => {
    controller.abort();
    rejectAbort(new DOMException("Request aborted", "AbortError"));
  };
  init.signal?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(cancel, timeoutMs);
  try {
    return await Promise.race([fetchImpl(url, { ...init, signal: controller.signal }).then(consume), cancelled]);
  } finally {
    clearTimeout(timer);
    init.signal?.removeEventListener("abort", cancel);
  }
}
