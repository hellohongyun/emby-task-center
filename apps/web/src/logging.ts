export interface WebLogInput {
  level: "info" | "warn" | "error";
  source: "web";
  message: string;
  method?: string;
  path?: string;
  status?: number;
  durationMs?: number;
  detail?: string;
}

import { fetchWithTimeout } from "./composables/request-timeout";

const INSTALL_FLAG = "__embyFetchLoggingInstalled__";
const QUEUE_LIMIT = 10;
const MAX_QUEUED_LOGS = 200;
const FLUSH_INTERVAL_MS = 5000;

let originalFetch: typeof fetch | null = null;
let queue: WebLogInput[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let flushing = false;
let retryDelayMs = 0;
let generation = 0;

function toPath(input: RequestInfo | URL): string {
  try {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (raw.startsWith("/")) return raw;
    const parsed = new URL(raw, "http://localhost");
    return parsed.pathname + parsed.search;
  } catch {
    return String(input);
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function ensureTimer(delayMs = FLUSH_INTERVAL_MS) {
  if (queue.length === 0 || timer !== null || !originalFetch) return;
  timer = setTimeout(() => {
    timer = null;
    void flush();
  }, delayMs);
}

function record(entry: WebLogInput) {
  queue.push({
    ...entry,
    message: entry.message.slice(0, 500),
    path: entry.path?.slice(0, 500),
    detail: entry.detail?.slice(0, 2000),
  });
  if (queue.length > MAX_QUEUED_LOGS) queue.splice(0, queue.length - MAX_QUEUED_LOGS);
  if (retryDelayMs > 0) {
    ensureTimer(retryDelayMs);
    return;
  }
  if (queue.length >= QUEUE_LIMIT) {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    void flush();
  } else {
    ensureTimer();
  }
}

async function flush() {
  if (!originalFetch) return;
  if (flushing) {
    ensureTimer();
    return;
  }
  const batch = queue.splice(0, QUEUE_LIMIT);
  if (batch.length === 0) return;
  flushing = true;
  const current = generation;
  let failed = false;
  try {
    const response = await fetchWithTimeout(originalFetch, "/api/logs", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ logs: batch }),
    });
    if (response.status >= 500 || response.status === 429 || response.status === 408)
      throw new Error("log_service_unavailable");
  } catch {
    // 仅网络失败保留重试；后端拒绝（如未登录）时静默丢弃，避免无限重试。
    failed = true;
    if (current === generation) queue = batch.concat(queue).slice(-MAX_QUEUED_LOGS);
  } finally {
    if (current === generation) {
      flushing = false;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      retryDelayMs = failed ? Math.min(retryDelayMs ? retryDelayMs * 2 : FLUSH_INTERVAL_MS, 60_000) : 0;
      if (failed) ensureTimer(retryDelayMs);
      else if (queue.length >= QUEUE_LIMIT) void flush();
      else ensureTimer();
    }
  }
}

function flushOnUnload() {
  if (queue.length === 0 || !originalFetch) return;
  const batch = queue.slice(-QUEUE_LIMIT);
  queue = [];
  try {
    void originalFetch("/api/logs", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ logs: batch }),
      keepalive: true,
    }).catch(() => undefined);
  } catch {
    // 页面卸载时尽力补发，失败忽略。
  }
}

export function installFetchLogging(): void {
  if ((globalThis as Record<string, unknown>)[INSTALL_FLAG] || originalFetch !== null) return;
  const base = globalThis.fetch;
  if (typeof base !== "function") return;
  originalFetch = base.bind(globalThis);
  const fetchFn = originalFetch;
  const wrapped: typeof fetch = (input, init) => {
    let method = "GET";
    let path = "";
    try {
      method = (
        init?.method ?? (typeof input === "string" || input instanceof URL ? "GET" : (input.method ?? "GET"))
      ).toUpperCase();
      path = toPath(input);
    } catch {
      // 解析失败仍放行请求本身。
    }
    if (path.startsWith("/api/logs")) return fetchFn(input, init);
    const started = Date.now();
    let promise: Promise<Response>;
    try {
      promise = fetchFn(input, init);
    } catch (error) {
      record({
        level: "error",
        source: "web",
        message: `${method} ${path} 请求失败`,
        method,
        path,
        durationMs: Date.now() - started,
        detail: describeError(error),
      });
      throw error;
    }
    promise.then(
      (response) => {
        try {
          record({
            level: response.status >= 400 ? "error" : "info",
            source: "web",
            message: `${method} ${path}`,
            method,
            path,
            status: response.status,
            durationMs: Date.now() - started,
          });
        } catch {
          // 日志逻辑绝不抛错影响业务。
        }
      },
      (error) => {
        try {
          record({
            level: "error",
            source: "web",
            message: `${method} ${path} 请求失败`,
            method,
            path,
            durationMs: Date.now() - started,
            detail: describeError(error),
          });
        } catch {
          // 日志逻辑绝不抛错影响业务。
        }
      },
    );
    return promise;
  };
  globalThis.fetch = wrapped;
  (globalThis as Record<string, unknown>)[INSTALL_FLAG] = true;
  if (typeof globalThis.addEventListener === "function") {
    globalThis.addEventListener("pagehide", flushOnUnload);
  }
}

export function resetLogging(): void {
  generation += 1;
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  queue = [];
  flushing = false;
  retryDelayMs = 0;
  if (typeof globalThis.removeEventListener === "function") {
    globalThis.removeEventListener("pagehide", flushOnUnload);
  }
  originalFetch = null;
  delete (globalThis as Record<string, unknown>)[INSTALL_FLAG];
}
