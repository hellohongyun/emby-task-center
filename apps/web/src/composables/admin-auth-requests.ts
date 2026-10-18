import type { Ref } from "vue";
import { fetchJsonWithTimeout, fetchWithTimeout } from "./request-timeout";

interface AuthState {
  authRequired: Ref<boolean>;
  lockRemaining: Ref<number>;
  lockChecking: Ref<boolean>;
  error: Ref<string>;
}

/** Local identity guards protect state; cancellation cannot undo a server-issued cookie. */
export function createAdminAuthRequests(
  fetchImpl: typeof fetch,
  state: AuthState,
  onLogout: () => void,
  load: () => Promise<void>,
) {
  let epoch = 0;
  let stopped = false;
  let loginController: AbortController | undefined;
  let lockController: AbortController | undefined;
  let logoutPending: Promise<void> | undefined;
  let logoutEpoch = 0;
  let lockRevision = 0;

  function invalidate() {
    epoch += 1;
    loginController?.abort();
    lockController?.abort();
    lockRevision += 1;
    state.lockChecking.value = false;
  }

  async function login(password: string, username?: string) {
    if (stopped) return false;
    invalidate();
    const current = epoch;
    const controller = (loginController = new AbortController());
    const active = () => !stopped && current === epoch;
    state.error.value = "";
    try {
      // The login gate is visible immediately on logout. Wait for its cookie-clearing
      // request to settle before issuing the new cookie-setting request.
      await logoutPending;
      if (!active()) return false;
      const response = await fetchWithTimeout(fetchImpl, "/api/auth/login", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(username ? { username, password } : { password }),
        signal: controller.signal,
      });
      if (!active()) return false;
      if (response.status === 429) {
        const retryAfter = Number(response.headers.get("retry-after"));
        state.lockRemaining.value = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.ceil(retryAfter) : 60;
        state.authRequired.value = true;
        return false;
      }
      if (!response.ok) {
        state.authRequired.value = true;
        state.error.value = response.status === 401 ? "管理员口令不正确。" : "登录服务暂时不可用，请稍后重试。";
        return false;
      }
      state.lockRemaining.value = 0;
      state.authRequired.value = false;
      await load();
      return active() && !state.authRequired.value;
    } catch {
      if (active()) {
        state.authRequired.value = true;
        state.error.value = "暂时无法连接登录服务，请稍后重试。";
      }
      return false;
    }
  }

  async function refreshLockStatus() {
    if (stopped) return;
    lockController?.abort();
    const controller = (lockController = new AbortController());
    const current = ++lockRevision;
    const identity = epoch;
    const active = () => !stopped && current === lockRevision && identity === epoch;
    state.lockChecking.value = true;
    try {
      const { response, body } = await fetchJsonWithTimeout<{ locked?: boolean; retryAfterSeconds?: number }>(
        fetchImpl,
        "/api/auth/lock-status",
        { credentials: "include", signal: controller.signal },
      );
      if (!active()) return;
      if (!response.ok || !body || typeof body.locked !== "boolean") throw new Error("invalid lock status");
      const remaining = Number(body.retryAfterSeconds);
      state.lockRemaining.value = body.locked && Number.isFinite(remaining) && remaining > 0 ? Math.ceil(remaining) : 0;
    } catch {
      if (active()) state.error.value = "暂时无法读取登录锁定状态，请稍后重试。";
    } finally {
      if (active()) state.lockChecking.value = false;
    }
  }

  function logout(): Promise<void> {
    if (stopped) return Promise.resolve();
    invalidate();
    logoutEpoch = epoch;
    onLogout();
    state.authRequired.value = true;
    state.lockRemaining.value = 0;
    state.error.value = "";
    if (logoutPending) return logoutPending;
    const pending = fetchWithTimeout(fetchImpl, "/api/auth/logout", { method: "POST", credentials: "include" })
      .then((response) => {
        if (!response.ok) throw new Error("logout failed");
      })
      .catch(() => {
        if (!stopped && logoutEpoch === epoch) state.error.value = "退出请求未完成，请重试；刷新页面可能仍保持登录。";
      })
      .finally(() => {
        if (logoutPending === pending) logoutPending = undefined;
      });
    logoutPending = pending;
    return pending;
  }

  function stop() {
    stopped = true;
    invalidate();
  }
  return { login, refreshLockStatus, logout, invalidate, stop };
}
