import { createTaskActions } from "./task-actions";
import { getCurrentScope, onMounted, onScopeDispose, ref } from "vue";
import { demoTasks } from "../data/demoTasks";
import type { Task } from "../types";
import { createTaskPosters, PosterUnauthorizedError } from "./task-posters";
import { fetchJsonWithTimeout } from "./request-timeout";
import { createAdminAuthRequests } from "./admin-auth-requests";

interface Options {
  fetchImpl?: typeof fetch;
  autoLoad?: boolean;
}
const fallbackPosters = demoTasks.map((task) => task.posterUrl!);
class UnauthorizedError extends Error {}
class InvalidResponseError extends Error {}
export interface BatchCreateResponse {
  results: Array<{
    title: string;
    tmdbId: number;
    ok: boolean;
    created?: boolean;
    task?: { id: number; title: string };
    error?: string;
  }>;
  duplicates?: Array<{ title: string; tmdbId: number; reason: string }>;
  creatable?: Array<{ title: string; tmdbId: number }>;
}

export function useTasks(options: Options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const tasks = ref<Task[]>([]);
  const retentionHours = ref(24);
  const loading = ref(false);
  const authRequired = ref(false);
  const authChecking = ref(true);
  const lockRemaining = ref(0);
  const lockChecking = ref(false);
  const demoMode = ref(false);
  const error = ref("");
  const posters = createTaskPosters(fetchImpl);
  let generation = 0;
  let disposed = false;
  let listController: AbortController | undefined;
  function requireAuth() {
    if (disposed) return;
    invalidateActions();
    auth.invalidate();
    generation += 1;
    listController?.abort();
    authRequired.value = true;
    tasks.value = [];
    stopAutoRefresh();
  }
  let refreshTimer: ReturnType<typeof setInterval> | undefined;
  function startAutoRefresh(intervalMs = 30_000) {
    if (disposed) return;
    stopAutoRefresh();
    refreshTimer = setInterval(() => {
      if (!loading.value && (typeof document === "undefined" || !document.hidden)) void load(true);
    }, intervalMs);
  }
  function stopAutoRefresh() {
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = undefined;
    }
  }

  async function load(light = false) {
    if (disposed) return;
    const current = ++generation;
    listController?.abort();
    listController = new AbortController();
    loading.value = true;
    error.value = "";
    try {
      const { response, body } = await fetchJsonWithTimeout<{ tasks?: Task[]; retentionHours?: number }>(
        fetchImpl,
        "/api/tasks",
        {
          credentials: "include",
          signal: listController.signal,
        },
      );
      if (current !== generation) return;
      if (response.status === 401) {
        requireAuth();
        // 未登录就别再定时轮询了：否则停在登录页的标签页会每 30 秒打一次 401，
        // 日志被刷满，也掩盖真正的鉴权异常。
        stopAutoRefresh();
        tasks.value = [];
        authChecking.value = false;
        loading.value = false;
        return;
      }
      if (!response.ok) throw new Error("failed");
      if (current !== generation) return;
      if (!body || !Array.isArray(body.tasks)) throw new InvalidResponseError();
      authRequired.value = false;
      // 之前（可能因为退出登录/过期）停过轮询的话，登录成功后恢复。
      if (!refreshTimer) startAutoRefresh();
      demoMode.value = false;
      authChecking.value = false;
      if (typeof body.retentionHours === "number" && body.retentionHours >= 0)
        retentionHours.value = body.retentionHours;
      const previous = new Map(tasks.value.map((task) => [task.id, task]));
      tasks.value = body.tasks.map((task, index) => {
        const old = previous.get(task.id);
        const oldPoster = old?.tmdbId === task.tmdbId && old?.mediaType === task.mediaType ? old.posterUrl : null;
        return {
          ...task,
          posterUrl:
            task.posterUrl || posters.cached(task) || oldPoster || fallbackPosters[index % fallbackPosters.length],
        };
      });
      if (!light)
        for (const task of body.tasks) {
          if (task.posterUrl || task.tmdbId == null) continue;
          void posters
            .get(task)
            .then((posterUrl) => {
              if (!posterUrl || current !== generation) return;
              const target = tasks.value.find(
                (row) => row.id === task.id && row.tmdbId === task.tmdbId && row.mediaType === task.mediaType,
              );
              if (target) target.posterUrl = posterUrl;
            })
            .catch((caught) => {
              if (current === generation && caught instanceof PosterUnauthorizedError) requireAuth();
            });
        }
    } catch (caught) {
      if (current !== generation) return;
      tasks.value = [];
      demoMode.value = false;
      authChecking.value = false;
      if (caught instanceof UnauthorizedError) requireAuth();
      else if (caught instanceof TypeError) {
        tasks.value = demoTasks.map((task) => ({ ...task }));
        demoMode.value = true;
        error.value = "暂时无法连接服务，当前展示演示数据。";
      } else if (caught instanceof InvalidResponseError || caught instanceof SyntaxError)
        error.value = "任务服务返回了无效数据，请稍后重试。";
      else error.value = "任务服务暂时不可用，请稍后重试。";
    } finally {
      if (current === generation) loading.value = false;
    }
  }
  const auth = createAdminAuthRequests(
    fetchImpl,
    { authRequired, lockRemaining, lockChecking, error },
    () => {
      invalidateActions();
      generation += 1;
      listController?.abort();
      stopAutoRefresh();
      tasks.value = [];
      loading.value = false;
      authChecking.value = false;
      demoMode.value = false;
    },
    load,
  );
  const {
    invalidate: invalidateActions,
    stop: stopActions,
    ...taskActions
  } = createTaskActions(fetchImpl, requireAuth, load);
  const { refreshLockStatus, logout } = auth;
  function login(password: string, username?: string) {
    invalidateActions();
    return auth.login(password, username);
  }
  if (options.autoLoad !== false) onMounted(load);
  if (getCurrentScope())
    onScopeDispose(() => {
      disposed = true;
      stopActions();
      auth.stop();
      generation += 1;
      listController?.abort();
      stopAutoRefresh();
      posters.stop();
    });
  return {
    tasks,
    retentionHours,
    loading,
    authRequired,
    authChecking,
    lockRemaining,
    lockChecking,
    demoMode,
    error,
    load,
    startAutoRefresh,
    stopAutoRefresh,
    login,
    refreshLockStatus,
    logout,
    ...taskActions,
    requireAuth,
  };
}
