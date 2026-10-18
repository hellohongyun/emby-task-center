import { getCurrentScope, onScopeDispose, ref } from "vue";
import { fetchJsonWithTimeout } from "./request-timeout";
import type { EmbySessionRow, EmbyUserRow } from "../types";

export type { EmbySessionRow, EmbyUserRow };

export function useEmbyUsers(requireAuth?: () => void, fetchImpl: typeof fetch = fetch) {
  const users = ref<EmbyUserRow[]>([]);
  const sessions = ref<EmbySessionRow[]>([]);
  const loading = ref(false);
  const error = ref("");
  const busy = ref(false);
  const reads = new Map<string, AbortController>();
  let stopped = false;
  const writes = new Map<string, AbortController>();
  const pendingUsers = ref(new Set<string>());
  const active = (controller: AbortController) => !stopped && !controller.signal.aborted;
  const currentRead = (key: string, controller: AbortController) => active(controller) && reads.get(key) === controller;

  function cancelRead(key: string) {
    reads.get(key)?.abort();
    reads.delete(key);
    if (key === "users") loading.value = false;
  }
  function stop() {
    stopped = true;
    for (const key of reads.keys()) cancelRead(key);
    for (const controller of writes.values()) controller.abort();
    writes.clear();
    pendingUsers.value = new Set();
    busy.value = false;
  }
  if (getCurrentScope()) onScopeDispose(stop);

  async function request<T>(url: string, controller: AbortController, init: RequestInit = {}): Promise<T> {
    try {
      const { response, body } = await fetchJsonWithTimeout<T & { error?: string }>(
        fetchImpl,
        url,
        { credentials: "include", ...init, signal: controller.signal },
        init.method ? 90_000 : url.endsWith("/sessions") ? 30_000 : 15_000,
        true,
      );
      if (!active(controller)) throw new DOMException("Request aborted", "AbortError");
      if (response.status === 401) {
        requireAuth?.();
        stop();
        throw new Error("unauthorized");
      }
      if (!response.ok) throw new Error(body?.error ?? "request_failed");
      return body as T;
    } catch (caught) {
      if (active(controller) && (caught as Error).name === "AbortError")
        throw Object.assign(
          new Error(init.method ? "操作等待超时，结果可能已生效，请刷新核实后再重试。" : "读取超时，请稍后重试。"),
          { cause: caught },
        );
      throw caught;
    }
  }

  async function read(key: string, silent: boolean, apply: (controller: AbortController) => Promise<void>) {
    if (stopped) return;
    cancelRead(key);
    const controller = new AbortController();
    reads.set(key, controller);
    if (key === "users") loading.value = !silent;
    error.value = "";
    try {
      await apply(controller);
    } catch (caught) {
      if (currentRead(key, controller)) error.value = caught instanceof Error ? caught.message : "读取失败";
    } finally {
      if (currentRead(key, controller)) {
        reads.delete(key);
        if (key === "users") loading.value = false;
      }
    }
  }
  const load = (silent = false) =>
    read("users", silent, async (controller) => {
      const body = await request<{ users: EmbyUserRow[] }>("/api/emby/users", controller);
      if (currentRead("users", controller)) users.value = body.users;
    });
  const loadSessions = () =>
    read("sessions", true, async (controller) => {
      const body = await request<{ sessions: EmbySessionRow[] }>("/api/emby/sessions", controller);
      if (currentRead("sessions", controller)) sessions.value = body.sessions;
    });

  async function write(url: string, init: RequestInit, apply: () => void | Promise<void>, readKey = "users") {
    // Aborting an issued write cannot undo server changes; do not replace pending writes.
    const key = url.split("/").slice(0, 5).join("/");
    if (stopped || writes.has(key)) return false;
    const controller = new AbortController();
    writes.set(key, controller);
    pendingUsers.value = new Set(writes.keys());
    busy.value = true;
    cancelRead(readKey);
    error.value = "";
    try {
      await request(url, controller, init);
      if (!active(controller)) return false;
      cancelRead(readKey); // A refresh issued during the write may still contain the old state.
      await apply();
      return active(controller);
    } catch (caught) {
      if (active(controller)) error.value = caught instanceof Error ? caught.message : "操作失败";
      return false;
    } finally {
      if (writes.get(key) === controller) writes.delete(key);
      if (!stopped) pendingUsers.value = new Set(writes.keys());
      if (!stopped) busy.value = writes.size > 0;
    }
  }
  const json = (body: unknown): RequestInit => ({
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const createUser = (input: { name: string; password?: string; isAdmin?: boolean }) =>
    write("/api/emby/users", json(input), () => load());
  const setPassword = (userId: string, password: string) =>
    write(`/api/emby/users/${encodeURIComponent(userId)}/password`, json({ password }), () => undefined);
  async function setDisabled(userId: string, disabled: boolean): Promise<void> {
    await write(
      `/api/emby/users/${encodeURIComponent(userId)}/${disabled ? "disable" : "enable"}`,
      { method: "POST" },
      () => {
        const target = users.value.find((user) => user.id === userId);
        if (target) target.isDisabled = disabled;
      },
    );
  }
  async function removeUser(userId: string): Promise<void> {
    await write(`/api/emby/users/${encodeURIComponent(userId)}`, { method: "DELETE" }, () => {
      users.value = users.value.filter((user) => user.id !== userId);
    });
  }
  async function endSession(sessionId: string): Promise<void> {
    await write(
      `/api/emby/sessions/${encodeURIComponent(sessionId)}/end`,
      { method: "POST" },
      loadSessions,
      "sessions",
    );
  }

  const isUserBusy = (userId: string) => pendingUsers.value.has(`/api/emby/users/${encodeURIComponent(userId)}`);
  return {
    users,
    sessions,
    loading,
    error,
    busy,
    isUserBusy,
    load,
    loadSessions,
    createUser,
    setDisabled,
    setPassword,
    removeUser,
    endSession,
    stop,
  };
}
