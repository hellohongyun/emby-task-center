import type { Task } from "../types";
import { createTaskActionRequests } from "./task-action-requests";

/** Task mutations share authentication handling and refresh the list afterwards. */
export function createTaskActions(fetchImpl: typeof fetch, requireAuth: () => void, load: () => Promise<void>) {
  const requests = createTaskActionRequests(fetchImpl, requireAuth, load);
  const json = (method: string, body: unknown): RequestInit => ({
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  async function mutate<T>(url: string, init: RequestInit) {
    const { response, body } = await requests.request<T>(url, init, { refresh: true });
    if (!response.ok) throw new Error("failed");
    return body!;
  }
  async function batchDeleteTasks(
    taskIds: number[],
  ): Promise<{ deleted: number[]; failed: Array<{ taskId: number; error: string }> }> {
    return mutate(`/api/tasks/batch-delete`, json("POST", { taskIds }));
  }
  async function updateTaskProgress(taskId: number, airProgress: number): Promise<Task> {
    return mutate(`/api/tasks/${taskId}/progress`, json("PUT", { airProgress }));
  }
  async function updateTaskSeason(taskId: number, seasonNumber: number | null): Promise<Task> {
    return mutate(`/api/tasks/${taskId}/season`, json("PUT", { seasonNumber }));
  }
  async function updateTaskSchedule(taskId: number, days: number[], time: string | null): Promise<Task> {
    return mutate(`/api/tasks/${taskId}/schedule`, json("PUT", { days, time }));
  }
  async function getTaskMapping(taskId: number): Promise<{ task: Task; folderEpisodeCount: number }> {
    const { response, body } = await requests.request<{ task: Task; folderEpisodeCount: number }>(
      `/api/tasks/${taskId}/mapping`,
    );
    if (!response.ok) throw new Error("failed");
    return body!;
  }
  async function setTaskMapping(
    taskId: number,
    rootId: string,
    folderPath: string,
    sourceMode?: "auto" | "mapped",
  ): Promise<{ task: Task; folderEpisodeCount: number }> {
    return mutate(
      `/api/tasks/${taskId}/mapping`,
      json("PUT", { rootId, folderPath, ...(sourceMode ? { sourceMode } : {}) }),
    );
  }
  async function clearTaskMapping(taskId: number): Promise<Task> {
    const body = await mutate<{ task: Task }>(`/api/tasks/${taskId}/mapping`, { method: "DELETE" });
    return body.task;
  }
  async function taskAction(taskId: number, action: "cancel" | "retry" | "delete") {
    const url = action === "delete" ? `/api/tasks/${taskId}` : `/api/tasks/${taskId}/${action}`;
    const { response } = await requests.request(
      url,
      { method: action === "delete" ? "DELETE" : "POST" },
      { refresh: true, readBody: false },
    );
    if (!response.ok) throw new Error("action_failed");
  }
  /**
   * 新建任务（完结入库）：搜 TMDB 选中片子 → 建一条 ingest 任务。
   * 追更已整体下线，前端只有这一个创建入口；同一部剧重复添加会复用已有任务（服务端按幂等键去重）。
   */
  async function createTask(input: {
    tmdbId: number;
    title: string;
    mediaType: "tv" | "movie";
  }): Promise<{ ok: boolean; error?: string; created?: boolean }> {
    const { response, body } = await requests.request<{ error?: string; created?: boolean }>(
      "/api/tasks",
      json("POST", input),
      { refresh: true, timeoutMs: 180_000, readErrorBody: true },
    );
    if (!response.ok) {
      return { ok: false, error: body?.error ?? "create_failed" };
    }
    return { ok: true, created: body?.created };
  }
  /**
   * 改绑 TMDB 条目：建任务时选错了同名剧 / 手滑填错 id 的手动修复路径。
   * 服务端会合并已存在的目标条目（迁移任务与库内片源关联）、按新条目重建分季并作废旧缺集快照。
   */
  async function rebindTaskTmdb(
    taskId: number,
    input: { tmdbId: number; mediaType?: "tv" | "movie"; title?: string },
  ): Promise<{ ok: boolean; error?: string; merged?: boolean; metadataSynced?: boolean }> {
    const { response, body } = await requests.request<{ error?: string; merged?: boolean; metadataSynced?: boolean }>(
      `/api/tasks/${taskId}/tmdb`,
      json("PUT", input),
      { refresh: true, timeoutMs: 180_000, readErrorBody: true },
    );
    if (!response.ok) {
      return { ok: false, error: body?.error ?? "rebind_failed" };
    }
    return { ok: true, merged: body?.merged, metadataSynced: body?.metadataSynced };
  }
  const cancelTask = (taskId: number) => taskAction(taskId, "cancel");
  const retryTask = (taskId: number) => taskAction(taskId, "retry");
  const deleteTask = (taskId: number) => taskAction(taskId, "delete");
  return {
    invalidate: requests.invalidate,
    stop: requests.stop,
    createTask,
    rebindTaskTmdb,
    updateTaskProgress,
    updateTaskSeason,
    updateTaskSchedule,
    getTaskMapping,
    setTaskMapping,
    clearTaskMapping,
    batchDeleteTasks,
    cancelTask,
    retryTask,
    deleteTask,
  };
}
