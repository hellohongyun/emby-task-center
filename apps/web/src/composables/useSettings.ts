import { computed, getCurrentScope, onScopeDispose, ref } from "vue";

import type { PublicSettingEntry, SettingsGroup, SettingsPayload } from "../types";
import { fetchJsonWithTimeout } from "./request-timeout";

/**
 * 后台配置（P1.3）：读写 /api/settings。
 *
 * 约定：
 *  - 密钥项接口只回掩码；保存时只有"用户真的改了"才提交，避免把 "****" 写回数据库。
 *  - 保存成功后用响应里的最新快照直接刷新，不再二次请求。
 */
export function useSettings(requireAuth?: (() => void) | undefined, fetchImpl: typeof fetch = fetch) {
  const groups = ref<SettingsGroup[]>([]);
  const admin = ref<SettingsPayload["admin"]>({
    username: "admin",
    hasPassword: false,
    mustChangePassword: false,
  });
  const warnings = ref<string[]>([]);
  const loading = ref(false);
  const saving = ref(false);
  const loaded = ref(false);
  const error = ref("");
  const message = ref("");
  /** 本次保存里"需要重启应用才生效"的键（会话密钥、Redis 连接等启动时读取的配置）。 */
  const restartRequired = ref<string[]>([]);
  let stopped = false;
  let revision = 0;
  let loadController: AbortController | undefined;
  let writeController: AbortController | undefined;

  function cancelLoad() {
    revision += 1;
    loadController?.abort();
    loading.value = false;
  }
  function stop() {
    stopped = true;
    cancelLoad();
    writeController?.abort();
    saving.value = false;
  }
  if (getCurrentScope()) onScopeDispose(stop);

  const entries = computed<PublicSettingEntry[]>(() => groups.value.flatMap((section) => section.settings));

  async function request<T>(url: string, controller: AbortController, init?: RequestInit): Promise<T> {
    const { response, body } = await fetchJsonWithTimeout<T & { error?: string }>(
      fetchImpl,
      url,
      { credentials: "include", ...init, signal: controller.signal },
      init?.method === "PATCH" ? 90_000 : 15_000,
      true,
    );
    if (stopped || controller.signal.aborted) throw new Error("request_cancelled");
    if (response.status === 401) {
      requireAuth?.();
      throw new Error("unauthorized");
    }
    if (!response.ok) {
      throw new Error(body?.error ?? "request_failed");
    }
    if (!body) throw new Error("request_failed");
    return body;
  }

  function applyPayload(payload: SettingsPayload) {
    groups.value = payload.groups;
    admin.value = payload.admin;
    warnings.value = payload.warnings;
  }

  async function load() {
    if (stopped || saving.value) return false;
    cancelLoad();
    const current = revision;
    const controller = (loadController = new AbortController());
    const active = () => !stopped && current === revision;
    loading.value = true;
    error.value = "";
    try {
      const payload = await request<SettingsPayload>("/api/settings", controller);
      if (!active()) return false;
      applyPayload(payload);
      return true;
    } catch (caught) {
      if (active() && (caught as Error).message !== "unauthorized") error.value = "无法读取系统配置。";
      return false;
    } finally {
      if (active()) {
        loading.value = false;
        loaded.value = true;
      }
    }
  }

  /** 保存若干项；返回被后端拒绝的键（含原因），空数组表示全部成功。 */
  async function save(values: Record<string, unknown>): Promise<Array<{ key: string; error: string }>> {
    if (Object.keys(values).length === 0) return [];
    if (stopped || saving.value) return Object.keys(values).map((key) => ({ key, error: "request_pending" }));
    cancelLoad();
    const controller = (writeController = new AbortController());
    saving.value = true;
    error.value = "";
    message.value = "";
    restartRequired.value = [];
    try {
      const payload = await request<
        SettingsPayload & {
          updated?: string[];
          rejected?: Array<{ key: string; error: string }>;
          restartRequired?: string[];
        }
      >("/api/settings", controller, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ values }),
      });
      if (stopped) return Object.keys(values).map((key) => ({ key, error: "request_cancelled" }));
      applyPayload(payload);
      const rejected = payload.rejected ?? [];
      restartRequired.value = payload.restartRequired ?? [];
      message.value =
        rejected.length > 0
          ? "部分配置未保存，请检查提示。"
          : restartRequired.value.length > 0
            ? `已保存 ${payload.updated?.length ?? 0} 项配置，其中 ${restartRequired.value.length} 项需要重启应用后生效。`
            : `已保存 ${payload.updated?.length ?? 0} 项配置。`;
      return rejected;
    } catch (caught) {
      if (!stopped && (caught as Error).message !== "unauthorized") error.value = "保存失败，请稍后重试。";
      return Object.keys(values).map((key) => ({ key, error: "request_failed" }));
    } finally {
      if (!stopped) saving.value = false;
    }
  }

  /** 修改管理员口令；失败返回错误码，成功返回 null。 */
  async function changePassword(currentPassword: string, newPassword: string): Promise<string | null> {
    if (stopped || saving.value) return "request_pending";
    cancelLoad();
    const controller = (writeController = new AbortController());
    saving.value = true;
    error.value = "";
    message.value = "";
    try {
      const payload = await request<{ status: string; admin: SettingsPayload["admin"] }>(
        "/api/settings/admin-password",
        controller,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ currentPassword, newPassword }),
        },
      );
      if (stopped) return "request_cancelled";
      admin.value = payload.admin;
      message.value = "管理员口令已更新。";
      return null;
    } catch (caught) {
      const code = (caught as Error).message;
      if (stopped) return "request_cancelled";
      if (code === "unauthorized") return null;
      error.value =
        code === "invalid_current_password"
          ? "当前口令不正确。"
          : code === "password_too_short"
            ? "新口令至少 8 位。"
            : "口令更新失败，请稍后重试。";
      return code;
    } finally {
      if (!stopped) saving.value = false;
    }
  }

  return {
    groups,
    entries,
    admin,
    warnings,
    loading,
    saving,
    loaded,
    error,
    message,
    restartRequired,
    load,
    save,
    changePassword,
    stop,
  };
}

/** 把接口返回的任意值渲染成表单里的文本（数组用逗号连接）。 */
export function settingToInput(entry: PublicSettingEntry): string {
  const value = entry.value;
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.join(",");
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

/** 表单文本还原成提交值：按注册表类型（这里由调用方给出）解析。 */
export function parseSettingInput(entry: PublicSettingEntry, raw: string | number): unknown {
  // <input type="number"> 的 v-model 会给出 number，统一按文本处理。
  const text = typeof raw === "number" ? String(raw) : raw;
  const trimmed = text.trim();
  if (Array.isArray(entry.value)) {
    return trimmed
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  if (typeof entry.value === "boolean") return trimmed === "true" || trimmed === "1";
  if (typeof entry.value === "number") {
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : text;
  }
  return text;
}
