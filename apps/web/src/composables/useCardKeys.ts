import { getCurrentScope, onScopeDispose, ref } from "vue";
import { createCardRequests } from "./card-key-requests";
import { AI_ERROR_TEXT, type CardRow, type CardStats, type CreateCardInput } from "./card-key-types";
export { AI_ERROR_TEXT, type CardRow, type CardStats, type CreateCardInput } from "./card-key-types";

function message(caught: unknown, fallback: string): string {
  return caught instanceof DOMException && caught.name === "AbortError"
    ? "请求超时，请刷新列表确认结果。"
    : caught instanceof Error
      ? caught.message
      : fallback;
}

function computeStats(rows: CardRow[]): CardStats {
  const unused = rows.filter((row) => row.status === "unused").length;
  return { total: rows.length, unused, used: rows.length - unused };
}

export function useCardKeys(requireAuth?: () => void) {
  const cards = ref<CardRow[]>([]);
  const stats = ref<CardStats>({ total: 0, unused: 0, used: 0 });
  const loading = ref(false);
  const error = ref("");
  const busy = ref(false);
  // Deletion stays independent per row; other rows remain interactive.
  const deletingIds = ref<number[]>([]);
  const aiBusy = ref(false);
  const aiError = ref("");
  const requests = createCardRequests(requireAuth);
  const active = requests.active;
  const request = requests.request;
  let loadRevision = 0;
  let loadController: AbortController | undefined;
  let aiRevision = 0;
  let aiController: AbortController | undefined;

  function cancelLoad() {
    loadRevision += 1;
    loadController?.abort();
    loading.value = false;
  }
  function stop() {
    cancelLoad();
    aiRevision += 1;
    requests.stop();
    busy.value = false;
    aiBusy.value = false;
    deletingIds.value = [];
  }
  if (getCurrentScope()) onScopeDispose(stop);

  /** Silent alignment preserves the visible table during optimistic deletion. */
  async function load(options: { silent?: boolean } = {}): Promise<void> {
    if (!active()) return;
    cancelLoad();
    const current = loadRevision;
    const controller = (loadController = new AbortController());
    const latest = () => active() && current === loadRevision;
    if (!options.silent) loading.value = true;
    error.value = "";
    try {
      const body = await request<{ cards: CardRow[]; total: number; unused: number; used: number }>(
        "/api/cards",
        { signal: controller.signal },
        latest,
      );
      if (!latest()) return;
      cards.value = body.cards.filter((card) => !deletingIds.value.includes(card.id));
      stats.value = deletingIds.value.length
        ? computeStats(cards.value)
        : { total: body.total, unused: body.unused, used: body.used };
    } catch (caught) {
      if (latest()) error.value = message(caught, "无法加载卡密");
    } finally {
      if (latest()) loading.value = false;
    }
  }

  async function create(input: CreateCardInput): Promise<string[]> {
    if (!active() || busy.value) return [];
    busy.value = true;
    error.value = "";
    try {
      const body = await request<{ codes: string[] }>("/api/cards", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!active()) return [];
      await load();
      return active() ? body.codes : [];
    } catch (caught) {
      if (!active()) return [];
      const reason = caught instanceof Error ? caught.message : "创建失败";
      error.value =
        reason === "invalid_expires_at"
          ? "到期日期不合法，请重新选择。"
          : reason === "invalid_days"
            ? "自定义卡密必须填天数，或用日历选一个到期日期。"
            : caught instanceof DOMException && caught.name === "AbortError"
              ? "创建请求未完成，请刷新列表核对结果。"
              : reason;
      return [];
    } finally {
      if (active()) busy.value = false;
    }
  }

  async function update(input: {
    ids: number[];
    name?: string;
    expiryLabel?: string;
    blessing?: string;
  }): Promise<boolean> {
    if (!active()) return false;
    error.value = "";
    try {
      await request("/api/cards", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!active()) return false;
      await load();
      return active();
    } catch (caught) {
      if (active()) error.value = message(caught, "保存失败");
      return false;
    }
  }

  /** Roll back only this deletion's rows, preserving other in-flight or completed deletions. */
  async function remove(ids: number[]): Promise<void> {
    if (!active()) return;
    const targets = ids.filter((id) => Number.isInteger(id) && !deletingIds.value.includes(id));
    if (!targets.length) return;
    cancelLoad();
    error.value = "";
    deletingIds.value = [...deletingIds.value, ...targets];
    const snapshotCards = cards.value;
    const removing = new Set(targets);
    cards.value = cards.value.filter((card) => !removing.has(card.id));
    stats.value = computeStats(cards.value);
    try {
      await request("/api/cards", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids: targets }),
      });
      if (active()) await load({ silent: true });
    } catch (caught) {
      if (!active()) return;
      const otherDeletes = new Set(deletingIds.value.filter((id) => !removing.has(id)));
      const existing = new Set(cards.value.map((card) => card.id));
      const restored = snapshotCards.filter(
        (card) => removing.has(card.id) && !otherDeletes.has(card.id) && !existing.has(card.id),
      );
      const order = new Map(snapshotCards.map((card, index) => [card.id, index]));
      cards.value = [...cards.value, ...restored].sort(
        (a, b) => (order.get(a.id) ?? Infinity) - (order.get(b.id) ?? Infinity),
      );
      stats.value = computeStats(cards.value);
      error.value = message(caught, "删除失败");
    } finally {
      if (active()) deletingIds.value = deletingIds.value.filter((id) => !removing.has(id));
    }
  }

  async function runAi(url: string, input?: { occasion?: string; hint?: string }): Promise<string> {
    if (!active()) return "";
    aiController?.abort();
    const controller = (aiController = new AbortController());
    const current = ++aiRevision;
    const latest = () => active() && current === aiRevision;
    aiBusy.value = true;
    aiError.value = "";
    try {
      // The backend permits up to 120 seconds for AI; include a small response margin.
      const body = await request<{ text?: string; model?: string; sample?: string }>(
        url,
        {
          method: "POST",
          signal: controller.signal,
          ...(input ? { headers: { "content-type": "application/json" }, body: JSON.stringify(input) } : {}),
        },
        latest,
        125_000,
      );
      if (!latest()) return "";
      return input ? (body.text ?? "") : `连接正常：${body.model} 返回「${body.sample}」`;
    } catch (caught) {
      if (latest()) {
        const reason = caught instanceof Error ? caught.message : "ai_request_failed";
        aiError.value =
          caught instanceof DOMException && caught.name === "AbortError"
            ? AI_ERROR_TEXT.ai_timeout!
            : (AI_ERROR_TEXT[reason] ?? "AI 请求失败，请稍后重试。");
      }
      return "";
    } finally {
      if (latest()) aiBusy.value = false;
    }
  }
  const draftBlessing = (input: { occasion?: string; hint?: string }) => runAi("/api/cards/blessing/draft", input);
  const testAi = () => runAi("/api/cards/blessing/test");
  return {
    cards,
    stats,
    loading,
    error,
    busy,
    deletingIds,
    aiBusy,
    aiError,
    load,
    create,
    update,
    remove,
    draftBlessing,
    testAi,
    stop,
  };
}
