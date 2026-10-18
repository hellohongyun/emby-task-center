import { onScopeDispose, ref, watch } from "vue";
import type { Task, TmdbMedia } from "../types";

type Pick = { tmdbId: number; mediaType: "tv" | "movie"; title: string };
type Outcome = { ok: boolean; error?: string };
type Actions = {
  createTask?: (input: Pick) => Promise<Outcome>;
  rebindTask?: (id: number, input: { tmdbId: number; mediaType?: "tv" | "movie"; title?: string }) => Promise<Outcome>;
  deleteTask?: (id: number) => Promise<void>;
};
type Search = { search: (query: string) => Promise<TmdbMedia[]>; cancel: () => void };
const uncertainWrite = "请求超时，操作可能已提交。请刷新检查结果后再重试。";

/** Drawer rounds prevent late responses from changing a reopened drawer or an unmounted board. */
export function useTaskBoardActions(actions: Actions, tmdb: Search, refresh: () => void) {
  const drawerOpen = ref(false);
  const drawerMode = ref<"create" | "rebind">("create");
  const query = ref("");
  const results = ref<TmdbMedia[]>([]);
  const searching = ref(false);
  const creating = ref(false);
  const rebinding = ref(false);
  const drawerMessage = ref("");
  const rebindTarget = ref<Task | null>(null);
  const pendingPick = ref<Pick | null>(null);
  const manualId = ref<string | number>("");
  const manualType = ref<"tv" | "movie">("tv");
  const manualTitle = ref("");
  const deletingId = ref<number | null>(null);
  const actionMessage = ref("");
  let round = 0;
  let stopped = false;

  function reset() {
    round += 1;
    tmdb.cancel();
    query.value = "";
    results.value = [];
    drawerMessage.value = "";
    rebindTarget.value = null;
    pendingPick.value = null;
    manualId.value = "";
    manualTitle.value = "";
    searching.value = creating.value = rebinding.value = false;
  }
  watch(
    drawerOpen,
    (open) => {
      if (!open) reset();
    },
    { flush: "sync" },
  );
  onScopeDispose(() => {
    stopped = true;
    reset();
  });
  const active = (token: number) => !stopped && drawerOpen.value && round === token;
  const aborted = (error: unknown) => (error as Error)?.name === "AbortError";
  const timedOut = (error: unknown) => (error as Error)?.message?.includes("超时");

  function openCreate() {
    if (stopped) return;
    reset();
    drawerMode.value = "create";
    drawerOpen.value = true;
  }
  function openRebind(task: Task) {
    if (stopped) return;
    reset();
    drawerMode.value = "rebind";
    rebindTarget.value = task;
    manualType.value = task.mediaType === "movie" ? "movie" : "tv";
    drawerOpen.value = true;
  }
  function pickCandidate(hit: TmdbMedia) {
    pendingPick.value = { tmdbId: hit.id, mediaType: hit.mediaType === "movie" ? "movie" : "tv", title: hit.title };
    drawerMessage.value = "";
  }
  function pickManual() {
    const tmdbId = Number(String(manualId.value ?? "").trim());
    if (!Number.isInteger(tmdbId) || tmdbId <= 0) {
      drawerMessage.value = "TMDB ID 必须是正整数。";
      return;
    }
    pendingPick.value = { tmdbId, mediaType: manualType.value, title: manualTitle.value.trim() };
    drawerMessage.value = "";
  }
  async function search() {
    const keyword = query.value.trim();
    if (!keyword || searching.value || !drawerOpen.value || stopped) return;
    const token = round;
    searching.value = true;
    drawerMessage.value = "";
    try {
      const found = await tmdb.search(keyword);
      if (!active(token)) return;
      results.value = found.filter((item) => item.mediaType === "tv" || item.mediaType === "movie");
      if (!results.value.length) drawerMessage.value = "没有找到片名，换个关键词试试。";
    } catch (error) {
      if (active(token) && !aborted(error))
        drawerMessage.value = timedOut(error) ? "请求超时，请稍后重试。" : "搜索失败，请稍后再试。";
    } finally {
      if (active(token)) searching.value = false;
    }
  }
  async function write(mode: "create" | "rebind", pick: Pick, task?: Task) {
    if (!drawerOpen.value || stopped || creating.value || rebinding.value) return;
    const busy = mode === "create" ? creating : rebinding;
    const token = round;
    busy.value = true;
    drawerMessage.value = "";
    try {
      const outcome =
        mode === "create"
          ? await actions.createTask?.(pick)
          : await actions.rebindTask?.(task!.id, {
              tmdbId: pick.tmdbId,
              mediaType: pick.mediaType,
              ...(pick.title ? { title: pick.title } : {}),
            });
      if (!active(token) || outcome?.error === "aborted") return;
      if (!outcome?.ok) {
        drawerMessage.value =
          outcome?.error === "unauthorized"
            ? "登录已过期，请重新登录。"
            : outcome?.error === "timeout"
              ? uncertainWrite
              : mode === "create"
                ? "创建失败，请稍后再试。"
                : "改绑失败：TMDB 里查不到这个 ID（可以在下面填标题兜底，或换个 ID 再试）。";
        return;
      }
      drawerOpen.value = false;
      refresh();
    } catch (error) {
      if (active(token) && !aborted(error))
        drawerMessage.value = timedOut(error) ? uncertainWrite : "操作失败，请刷新检查结果后再重试。";
    } finally {
      if (active(token)) busy.value = false;
    }
  }
  const create = (hit: TmdbMedia) =>
    write("create", {
      tmdbId: hit.id,
      title: hit.title,
      mediaType: hit.mediaType === "movie" ? "movie" : "tv",
    });
  const confirmRebind = () =>
    rebindTarget.value && pendingPick.value
      ? write("rebind", { ...pendingPick.value }, rebindTarget.value)
      : Promise.resolve();

  async function removeTask(task: Task) {
    if (stopped || deletingId.value !== null || !actions.deleteTask) return;
    if (
      typeof window !== "undefined" &&
      !window.confirm(`删除任务「${task.title}」？只删这条任务记录，媒体库里的片源不会被删除。`)
    )
      return;
    deletingId.value = task.id;
    actionMessage.value = "";
    try {
      await actions.deleteTask(task.id);
      if (!stopped) refresh();
    } catch (error) {
      if (!stopped && !aborted(error))
        actionMessage.value = timedOut(error)
          ? uncertainWrite
          : `删除「${task.title}」失败：任务可能正在处理中，请稍后再试。`;
    } finally {
      if (!stopped) deletingId.value = null;
    }
  }
  return {
    drawerOpen,
    drawerMode,
    query,
    results,
    searching,
    creating,
    rebinding,
    drawerMessage,
    rebindTarget,
    pendingPick,
    manualId,
    manualType,
    manualTitle,
    deletingId,
    actionMessage,
    openCreate,
    openRebind,
    pickCandidate,
    pickManual,
    search,
    create,
    confirmRebind,
    removeTask,
  };
}
