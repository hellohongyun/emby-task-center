import type { EmailScene } from "@emby-task-center/contracts/email-scenes";
import { getCurrentScope, onScopeDispose, ref } from "vue";
import { fetchJsonWithTimeout } from "./request-timeout";

export interface EmailPreview {
  subject: string;
  text: string;
  html: string;
}

const emailPreviewPath = "/api/integrations/email/preview";

export function useIntegrations(requireAuth: () => void, fetchImpl: typeof fetch = fetch) {
  // emailMissing：未配置时后端列出还缺哪些设置项（按注册表标签），前端直接展示，不再让用户猜。
  const status = ref({ embyConfigured: false, emailConfigured: false, emailMissing: [] as string[] });
  const loading = ref(false);
  const loaded = ref(false);
  const error = ref("");
  const requests = new Map<string, AbortController>();
  const pendingTests = new Map<string, Promise<unknown>>();
  let stopped = false;
  function cancel() {
    for (const controller of requests.values()) controller.abort();
    requests.clear();
    pendingTests.clear();
    loading.value = false;
  }
  if (getCurrentScope())
    onScopeDispose(() => {
      stopped = true;
      cancel();
    });
  function begin(key: string) {
    if (stopped) throw new DOMException("Request aborted", "AbortError");
    requests.get(key)?.abort();
    const controller = new AbortController();
    requests.set(key, controller);
    return controller;
  }
  const active = (key: string, controller: AbortController) => !stopped && requests.get(key) === controller;

  async function request<T>(
    url: string,
    controller: AbortController,
    init?: RequestInit,
    timeoutMs = 15_000,
    requestKey = url,
  ): Promise<T> {
    const { response, body } = await fetchJsonWithTimeout<T & { error?: string }>(
      fetchImpl,
      url,
      { credentials: "include", ...init, signal: controller.signal },
      timeoutMs,
      true,
    ).catch((caught: unknown) => {
      if (active(requestKey, controller) && !controller.signal.aborted && (caught as Error).name === "AbortError") {
        throw new Error(
          url.endsWith("/email/test") ? "请求超时；测试邮件可能已发送，请先检查收件箱。" : "请求超时，请稍后重试。",
        );
      }
      throw caught;
    });
    if (!active(requestKey, controller)) throw new DOMException("Request aborted", "AbortError");
    if (response.status === 401) {
      requireAuth();
      throw new Error("unauthorized");
    }
    if (!response.ok) {
      throw new Error(body?.error ?? "request_failed");
    }
    return body as T;
  }

  async function load() {
    if (stopped) return;
    const url = "/api/integrations/status";
    const controller = begin(url);
    loading.value = true;
    error.value = "";
    try {
      const state = await request<typeof status.value>(url, controller);
      if (!active(url, controller)) return;
      status.value = {
        embyConfigured: state.embyConfigured,
        emailConfigured: state.emailConfigured,
        // 兼容没有该字段的旧后端/测试桩。
        emailMissing: state.emailMissing ?? [],
      };
    } catch (caught) {
      if (active(url, controller) && (caught as Error).message !== "unauthorized")
        error.value = "无法读取外部集成配置。";
    } finally {
      if (active(url, controller)) {
        requests.delete(url);
        loading.value = false;
        loaded.value = true;
      }
    }
  }

  function test<T>(url: string, init: RequestInit, timeoutMs: number): Promise<T> {
    const pending = pendingTests.get(url);
    if (pending) return pending as Promise<T>;
    if (stopped) return Promise.reject(new DOMException("Request aborted", "AbortError"));
    const controller = begin(url);
    // A cancelled wait cannot undo a POST already handled by the server.
    const operation = request<T>(url, controller, init, timeoutMs).finally(() => {
      if (active(url, controller)) requests.delete(url);
      if (pendingTests.get(url) === operation) pendingTests.delete(url);
    });
    pendingTests.set(url, operation);
    return operation;
  }
  const testEmby = () =>
    test<{ ok: boolean; serverName: string; version: string }>(
      "/api/integrations/emby/test",
      { method: "POST" },
      30_000,
    );
  const testEmail = (email: string, scene?: EmailScene) =>
    test<{ ok: boolean }>(
      "/api/integrations/email/test",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, scene }),
      },
      90_000,
    );

  function cancelEmailPreview() {
    requests.get(emailPreviewPath)?.abort();
    requests.delete(emailPreviewPath);
  }

  async function previewEmail(scene: EmailScene): Promise<EmailPreview> {
    const controller = begin(emailPreviewPath);
    try {
      const url = emailPreviewPath + "?" + new URLSearchParams({ scene });
      const preview = await request<EmailPreview>(url, controller, undefined, 15_000, emailPreviewPath);
      if (
        !preview ||
        typeof preview.subject !== "string" ||
        typeof preview.text !== "string" ||
        typeof preview.html !== "string"
      ) {
        throw new Error("invalid_email_preview");
      }
      return preview;
    } finally {
      if (active(emailPreviewPath, controller)) requests.delete(emailPreviewPath);
    }
  }

  return {
    status,
    loading,
    loaded,
    error,
    load,
    testEmby,
    testEmail,
    previewEmail,
    cancelEmailPreview,
    cancel,
  };
}
