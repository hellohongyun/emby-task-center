import { getCurrentScope, onScopeDispose, ref } from "vue";
import { guardedPortalFetch, portalIdentityRevision } from "./portal-access";
import { fetchJsonWithTimeout } from "./request-timeout";

const messages: Record<string, string> = {
  unauthorized: "登录已失效，请重新登录。",
  membership_expired: "会员已过期，请先续期。",
  member_frozen: "账号被冻结，请先处理冻结状态。",
  member_disabled: "会员已停用。",
  not_member: "会员不存在，请重新登录。",
  tmdb_unavailable: "暂时无法读取 TMDB，请联系管理员。",
  tmdb_search_failed: "搜索失败，请稍后重试。",
  tmdb_details_failed: "作品资料读取失败，请重新选择。",
  rate_limited: "操作过于频繁，请稍后重试。",
  invalid_request: "请检查作品、分季和说明是否填写完整。",
  request_conflict: "这条申请已被更新，请刷新后再处理。",
  request_changed: "这条申请已被更新，请取消编辑并刷新，再重新编辑。",
  request_closed: "申请已结束，无法继续修改说明，请刷新记录。",
  request_not_found: "申请不存在或已不可访问，请刷新记录。",
  request_already_active: "同一作品或分季已有未结束申请，不能重复开启。",
  tmdb_lookup_failed: "无法确认作品资料，申请尚未提交，请稍后重试。",
  season_required: "请选择该剧实际存在的一个季。",
  description_required: "请填写缺少的集号或补集说明。",
  member_changed: "会员身份已变化，请重新登录后操作。",
};

/** Each mounted page owns its requests; late responses cannot cross identities. */
export function useMediaRequestApi(admin = false, requireAuth: () => void = () => {}) {
  const error = ref("");
  const busy = ref<Record<string, boolean>>({});
  const pending = new Map<string, AbortController>();
  let stopped = false;
  function cancel(key?: string) {
    for (const [name, controller] of pending) {
      if (key !== undefined && name !== key) continue;
      controller.abort();
      pending.delete(name);
      busy.value[name] = false;
    }
  }
  if (getCurrentScope())
    onScopeDispose(() => {
      stopped = true;
      cancel();
    });

  async function run<T>(key: string, url: string, init: RequestInit = {}): Promise<T | null> {
    if (stopped) return null;
    cancel(key);
    const controller = new AbortController();
    const identity = portalIdentityRevision();
    pending.set(key, controller);
    busy.value[key] = true;
    error.value = "";
    const current = () =>
      !stopped &&
      pending.get(key) === controller &&
      !controller.signal.aborted &&
      (admin || identity === portalIdentityRevision());
    try {
      const { response, body } = await fetchJsonWithTimeout<T & { error?: string; message?: string }>(
        (input, options) => (admin ? fetch(input, options) : guardedPortalFetch(input, options, current)),
        url,
        { credentials: "include", ...init, signal: controller.signal },
        15_000,
        true,
      );
      if (!current()) return null;
      if (response.status === 401 && admin) requireAuth();
      if (!response.ok) throw new Error(messages[body?.error ?? ""] ?? body?.message ?? "操作失败，请稍后重试。");
      return body as T;
    } catch (caught) {
      if (current())
        error.value =
          caught instanceof Error && caught.name !== "AbortError"
            ? caught.message
            : init.method && init.method !== "GET"
              ? "等待超时，提交结果尚未确认，请刷新记录核对后再操作。"
              : "请求超时，请重试。";
      return null;
    } finally {
      if (pending.get(key) === controller) {
        pending.delete(key);
        busy.value[key] = false;
      }
    }
  }
  return { run, cancel, error, busy };
}
