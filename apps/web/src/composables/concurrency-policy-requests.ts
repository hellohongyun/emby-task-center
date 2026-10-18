import type { Ref } from "vue";
import { fetchJsonWithTimeout } from "./request-timeout";

interface State<T> {
  draft: T;
  draftRevision: () => number;
  loading: Ref<boolean>;
  saving: Ref<boolean>;
  message: Ref<string>;
}

/** Loads cannot replace a newer draft; a save remains exclusive until it settles. */
export function createConcurrencyPolicyRequests<T extends object>(
  fetchImpl: typeof fetch,
  state: State<T>,
  requireAuth: () => void = () => undefined,
) {
  let stopped = false;
  let loadRevision = 0;
  let loadController: AbortController | undefined;
  let saveController: AbortController | undefined;
  let savePending = false;

  async function load() {
    if (stopped || savePending) return;
    loadController?.abort();
    const controller = (loadController = new AbortController());
    const current = ++loadRevision;
    const draftRevision = state.draftRevision();
    const active = () => !stopped && current === loadRevision;
    state.loading.value = true;
    state.message.value = "";
    try {
      const { response, body } = await fetchJsonWithTimeout<{ policy?: T }>(fetchImpl, "/api/concurrency-policy", {
        credentials: "include",
        signal: controller.signal,
      });
      if (!active()) return;
      if (response.status === 401) {
        requireAuth();
        return;
      }
      if (!response.ok || !body?.policy || typeof body.policy !== "object" || Array.isArray(body.policy))
        throw new Error("读取失败，请稍后重试");
      if (draftRevision === state.draftRevision()) Object.assign(state.draft, body.policy);
    } catch (error) {
      if (active())
        state.message.value =
          (error as { name?: string } | null)?.name === "AbortError" ? "读取超时，请稍后重试" : "读取失败，请稍后重试";
    } finally {
      if (active()) state.loading.value = false;
    }
  }

  async function save() {
    if (stopped || savePending) return;
    savePending = true;
    loadRevision += 1;
    loadController?.abort();
    state.loading.value = false;
    state.saving.value = true;
    state.message.value = "";
    const controller = (saveController = new AbortController());
    try {
      const { response } = await fetchJsonWithTimeout(
        fetchImpl,
        "/api/concurrency-policy",
        {
          method: "PUT",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(state.draft),
          signal: controller.signal,
        },
        15_000,
        true,
      );
      if (stopped) return;
      if (response.status === 401) {
        requireAuth();
        return;
      }
      if (!response.ok) throw new Error("保存失败");
      state.message.value = "已保存，超限升级策略已生效";
    } catch (error) {
      if (!stopped)
        state.message.value =
          (error as { name?: string } | null)?.name === "AbortError"
            ? "保存超时，请重新读取确认是否已生效"
            : "保存失败，请稍后重试";
    } finally {
      savePending = false;
      if (!stopped) state.saving.value = false;
    }
  }

  function stop() {
    stopped = true;
    loadRevision += 1;
    loadController?.abort();
    saveController?.abort();
  }
  return { load, save, stop };
}
