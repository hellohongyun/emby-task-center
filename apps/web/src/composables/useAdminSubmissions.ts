import { ref } from "vue";

import type { SubmissionUser } from "../types";

export function useAdminSubmissions(requireAuth: () => void) {
  const users = ref<SubmissionUser[]>([]);
  const loading = ref(false);
  const error = ref("");

  async function request<T>(url: string, init?: RequestInit): Promise<T> {
    const response = await fetch(url, { credentials: "include", ...init });
    if (response.status === 401) {
      requireAuth();
      throw new Error("unauthorized");
    }
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? "request_failed");
    }
    return response.status === 204 ? (undefined as T) : (response.json() as Promise<T>);
  }

  async function load(): Promise<void> {
    loading.value = true;
    error.value = "";
    try {
      const body = await request<{ users: SubmissionUser[] }>("/api/submission-users");
      users.value = body.users;
    } catch (caught) {
      if ((caught as Error).message !== "unauthorized") error.value = "无法读取会员配置。";
    } finally {
      loading.value = false;
    }
  }

  async function addUser(input: {
    email: string;
    subscriptionExpiresAt?: string | null;
    embyUsername?: string | null;
    embyMaxStreams?: number | null;
    note?: string | null;
    password?: string;
    processPerDay?: number;
    processFirstBatch?: number;
  }): Promise<boolean> {
    try {
      await request<{ user: SubmissionUser }>("/api/submission-users", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      await load();
      return true;
    } catch (caught) {
      error.value = caught instanceof Error ? caught.message : "添加失败";
      return false;
    }
  }

  async function updateUser(
    id: number,
    input: {
      subscriptionExpiresAt?: string | null;
      embyUsername?: string | null;
      embyMaxStreams?: number | null;
      note?: string | null;
      enabled?: boolean;
      processPerDay?: number;
      processFirstBatch?: number;
    },
  ): Promise<boolean> {
    try {
      await request<{ user: SubmissionUser }>(`/api/submission-users/${id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      await load();
      return true;
    } catch (caught) {
      error.value = caught instanceof Error ? caught.message : "更新失败";
      return false;
    }
  }

  /** 单用户额度：每日 / 首批。空值回退为该用户已有值。 */
  async function setUserQuota(
    id: number,
    processPerDay: number | null,
    processFirstBatch: number | null,
  ): Promise<boolean> {
    return updateUser(id, {
      ...(processPerDay != null ? { processPerDay } : {}),
      ...(processFirstBatch != null ? { processFirstBatch } : {}),
    });
  }

  async function deleteUser(id: number): Promise<boolean> {
    try {
      await request(`/api/submission-users/${id}`, { method: "DELETE" });
      await load();
      return true;
    } catch (caught) {
      error.value = caught instanceof Error ? caught.message : "删除失败";
      return false;
    }
  }

  async function remind(userId: number): Promise<boolean> {
    try {
      const body = await request<{ sent: boolean }>(`/api/submission-users/${userId}/remind`, { method: "POST" });
      return body.sent;
    } catch {
      return false;
    }
  }

  // 与后端 MAIL_TYPES 一一对应。「任务更新通知」随那条邮件链（没有发送方）一起下线（2026-09）。
  const mailDefaultOptions = [
    { key: "membership_reminder", label: "会员临期/到期提醒", desc: "会员到期前/到期时的提醒" },
  ];
  const mailDefaults = ref<Record<string, boolean>>({});

  async function loadMailDefaults(): Promise<void> {
    try {
      const body = await request<{ defaults?: Record<string, boolean> }>("/api/settings/mail-defaults");
      if (body.defaults) mailDefaults.value = body.defaults;
    } catch {
      /* 不阻塞 */
    }
  }

  async function saveMailDefaults(): Promise<boolean> {
    try {
      await request<{ ok: boolean }>("/api/settings/mail-defaults", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(mailDefaults.value),
      });
      return true;
    } catch (caught) {
      error.value = caught instanceof Error ? caught.message : "保存失败";
      return false;
    }
  }

  const userMail = ref<{
    mailTypes: Array<{ key: string; label: string }>;
    effective: Record<string, boolean>;
    userPrefs: Record<string, boolean | null>;
  } | null>(null);
  async function loadAdminUserMail(email: string): Promise<boolean> {
    try {
      const body = await request<{
        mailTypes: Array<{ key: string; label: string }>;
        effective: Record<string, boolean>;
        userPrefs: Record<string, boolean | null>;
      }>(`/api/admin/mail-preferences/user?email=${encodeURIComponent(email)}`);
      userMail.value = body;
      return true;
    } catch (caught) {
      error.value = caught instanceof Error ? caught.message : "加载失败";
      return false;
    }
  }
  async function setAdminUserMail(email: string, mailType: string, enabled: boolean | null): Promise<boolean> {
    try {
      await request<{ ok: boolean }>("/api/admin/mail-preferences/user", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, mailType, enabled }),
      });
      await loadAdminUserMail(email);
      return true;
    } catch (caught) {
      error.value = caught instanceof Error ? caught.message : "保存失败";
      return false;
    }
  }

  /**
   * 手动同步：把 Emby 里还没绑定的账号收编成会员（用户名即邮箱，默认 15 天）。
   * 服务端启动时 + 每 10 分钟也会自动跑一次，这里用于"刚在 Emby 建完号想立刻看到"。
   */
  async function syncEmbyAccounts(): Promise<{ linked: number; adopted: number; skipped: number } | null> {
    try {
      const body = await request<{
        linked?: unknown[];
        adopted?: unknown[];
        skipped?: unknown[];
      }>("/api/submission-users/sync-emby", { method: "POST" });
      await load();
      return {
        linked: body.linked?.length ?? 0,
        adopted: body.adopted?.length ?? 0,
        skipped: body.skipped?.length ?? 0,
      };
    } catch (caught) {
      error.value = caught instanceof Error ? caught.message : "同步失败";
      return null;
    }
  }

  async function restoreUser(id: number): Promise<boolean> {
    try {
      await request<{ user: SubmissionUser }>(`/api/submission-users/${id}/restore`, { method: "POST" });
      await load();
      return true;
    } catch (caught) {
      error.value = caught instanceof Error ? caught.message : "恢复失败";
      return false;
    }
  }

  const adminArticles = ref<
    Array<{ code: string; title: string; content: string; enabled: boolean; sort: number; forceSeconds?: number }>
  >([]);
  async function loadAdminArticles(): Promise<void> {
    try {
      const body = await request<{ articles?: typeof adminArticles.value }>("/api/articles");
      if (Array.isArray(body.articles)) adminArticles.value = body.articles;
    } catch {
      /* 不阻塞 */
    }
  }
  async function saveAdminArticle(
    code: string,
    patch: { title?: string; content?: string; enabled?: boolean; sort?: number; forceSeconds?: number },
  ): Promise<boolean> {
    try {
      await request<{ ok: boolean }>(`/api/articles/${encodeURIComponent(code)}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
      await loadAdminArticles();
      return true;
    } catch (caught) {
      error.value = caught instanceof Error ? caught.message : "保存失败";
      return false;
    }
  }

  return {
    users,
    mailDefaults,
    mailDefaultOptions,
    userMail,
    adminArticles,
    loading,
    error,
    load,
    loadMailDefaults,
    saveMailDefaults,
    loadAdminUserMail,
    setAdminUserMail,
    loadAdminArticles,
    saveAdminArticle,
    setUserQuota,
    addUser,
    updateUser,
    deleteUser,
    remind,
    restoreUser,
    syncEmbyAccounts,
  };
}
