import { computed, inject, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { onBeforeRouteLeave } from "vue-router";

import { fetchJsonWithTimeout } from "../composables/request-timeout";
import { APP_SERVICES } from "../state/app-services";
import {
  hasPreviewChanges,
  librariesInOrder,
  messages,
  previewAction,
  sameOrder,
  type Account,
  type ApplyResult,
  type Catalog,
  type Library,
  type Preview,
} from "./LibraryOrderPageData";

export function useLibraryOrderPage() {
  const services = inject(APP_SERVICES, null);
  const endpoint = "/api/emby/library-order";
  const libraryRows = ref<Library[]>([]);
  const savedOrder = ref<string[]>([]);
  const hasSavedOrder = ref(false);
  const activeOrder = ref<string[]>();
  const users = ref<Account[]>([]);
  const updatedAt = ref<string | null>(null);
  const catalogWarnings = ref<string[]>([]);
  const preview = ref<Preview>();
  const results = ref<ApplyResult>();
  const operation = ref<"load" | "save" | "preview" | "apply">();
  const error = ref("");
  const message = ref("");
  const scope = ref<"all" | "one">("all");
  const testUserId = ref("");
  const previewOnlyChanges = ref(false);
  const search = ref("");
  const dragging = ref<number | null>(null);
  const resultHeading = ref<HTMLElement>();
  const controller = new AbortController();

  const currentOrder = computed(() => libraryRows.value.map((library) => library.id));
  const dirty = computed(() => !sameOrder(currentOrder.value, savedOrder.value));
  const proxyStatus = computed(() => {
    if (!activeOrder.value) return "反代尚未启用管理员顺序";
    return sameOrder(activeOrder.value, currentOrder.value) ? "反代已启用此顺序" : "反代当前使用上次确认的顺序";
  });
  const dirtyReason = computed(() => {
    if (!dirty.value) return "";
    const current = new Set(libraryRows.value.map((library) => library.id));
    const saved = new Set(savedOrder.value);
    if (savedOrder.value.some((id) => !current.has(id))) return "媒体库目录已变化";
    if (libraryRows.value.some((library) => !saved.has(library.id))) return "发现新增媒体库";
    return "有未保存修改";
  });
  const filtering = computed(() => search.value.trim().length > 0);
  const filteredRows = computed(() => {
    const query = search.value.trim().toLowerCase();
    return libraryRows.value
      .map((library, index) => ({ library, index }))
      .filter(({ library }) => !query || library.name.toLowerCase().includes(query));
  });
  const syncAction = computed(() => previewAction(preview.value));
  const previewWarnings = computed(() => preview.value?.warnings ?? catalogWarnings.value);
  const previewRows = computed(() =>
    (preview.value?.users ?? []).filter((row) => !previewOnlyChanges.value || hasPreviewChanges(row)),
  );

  function isNew(library: Library) {
    return hasSavedOrder.value && !savedOrder.value.includes(library.id);
  }

  function clearPreview() {
    preview.value = undefined;
    results.value = undefined;
    previewOnlyChanges.value = false;
  }

  async function request<T>(path: string, init: RequestInit = {}, timeoutMs = 20_000): Promise<T | undefined> {
    error.value = "";
    try {
      const { response, body } = await fetchJsonWithTimeout<T & { error?: string }>(
        fetch,
        path,
        { credentials: "include", ...init, signal: controller.signal },
        timeoutMs,
        true,
      );
      if (controller.signal.aborted) return undefined;
      if (response.status === 401) {
        services?.requireAuth();
        return undefined;
      }
      if (!response.ok || !body) {
        error.value = messages[body?.error ?? ""] ?? "操作失败，请重试。";
        return undefined;
      }
      return body;
    } catch {
      if (!controller.signal.aborted) error.value = "请求超时或连接失败，请重试。";
      return undefined;
    }
  }

  function applyCatalog(body: Catalog) {
    libraryRows.value = librariesInOrder(body.libraries, body.order);
    savedOrder.value = body.saved ? (body.savedOrder ?? body.order) : body.order;
    hasSavedOrder.value = body.saved;
    activeOrder.value = body.active ? body.activeOrder : undefined;
    users.value = body.users;
    updatedAt.value = body.updatedAt;
    catalogWarnings.value = body.warnings;
    if (!users.value.some((user) => user.id === testUserId.value)) {
      testUserId.value = users.value[0]?.id ?? "";
    }
    if (!users.value.length) scope.value = "all";
  }

  async function load() {
    if (operation.value) return;
    if (dirty.value) {
      message.value = "有未保存修改，请先保存或撤销后再刷新。";
      return;
    }
    operation.value = "load";
    clearPreview();
    message.value = "";
    const body = await request<Catalog>(endpoint, {}, 30_000);
    if (body) applyCatalog(body);
    operation.value = undefined;
  }

  async function persistOrder(): Promise<boolean> {
    const body = await request<{ order: string[]; updatedAt: string; libraries: Library[] }>(
      endpoint,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ order: currentOrder.value }),
      },
      30_000,
    );
    if (!body) return false;
    libraryRows.value = librariesInOrder(body.libraries, body.order);
    savedOrder.value = body.order;
    hasSavedOrder.value = true;
    updatedAt.value = body.updatedAt;
    return true;
  }

  async function save() {
    if (operation.value || (!dirty.value && hasSavedOrder.value)) return;
    operation.value = "save";
    message.value = "";
    if (await persistOrder()) message.value = "排序模板已保存，确认同步后生效。";
    operation.value = undefined;
  }

  async function previewOrder() {
    if (operation.value) return;
    operation.value = "preview";
    message.value = "";
    clearPreview();
    if (dirty.value || !hasSavedOrder.value) {
      if (!(await persistOrder())) {
        operation.value = undefined;
        return;
      }
    }
    if (scope.value === "one" && !testUserId.value) {
      error.value = "请选择一个测试账号。";
      operation.value = undefined;
      return;
    }
    const body = await request<Preview>(
      `${endpoint}/preview`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(scope.value === "one" ? { userIds: [testUserId.value] } : {}),
      },
      180_000,
    );
    if (body) preview.value = body;
    operation.value = undefined;
  }

  async function apply() {
    if (!preview.value || !syncAction.value.enabled || operation.value || results.value) return;
    operation.value = "apply";
    message.value = "";
    const body = await request<ApplyResult>(
      `${endpoint}/apply`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ previewToken: preview.value.previewToken }),
      },
      180_000,
    );
    if (body) {
      results.value = body;
      if (body.proxyActivated) {
        activeOrder.value = body.order;
        if (!sameOrder(currentOrder.value, body.order)) message.value = "同步使用了最新目录，刷新后可查看完整顺序。";
      }
      await nextTick();
      resultHeading.value?.focus();
    }
    operation.value = undefined;
  }

  function moveTo(from: number, to: number) {
    if (operation.value || filtering.value) return;
    if (from === to || from < 0 || to < 0 || from >= libraryRows.value.length || to >= libraryRows.value.length) return;
    const [row] = libraryRows.value.splice(from, 1);
    if (!row) return;
    libraryRows.value.splice(to, 0, row);
    clearPreview();
    message.value = "";
  }

  function resetOrder() {
    if (operation.value || !savedOrder.value.length) return;
    const restored = [...savedOrder.value, ...currentOrder.value.filter((id) => !savedOrder.value.includes(id))];
    libraryRows.value = librariesInOrder(libraryRows.value, restored);
    clearPreview();
    message.value = "已恢复到上次保存的顺序；新增媒体库保留在末尾。";
  }

  function dragStart(index: number, event: DragEvent) {
    if (operation.value || filtering.value) return;
    dragging.value = index;
    event.dataTransfer?.setData("text/plain", String(index));
    if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
  }

  function drop(index: number, event: DragEvent) {
    event.preventDefault();
    if (filtering.value) return;
    const raw = event.dataTransfer?.getData("text/plain");
    const from = dragging.value ?? (raw ? Number(raw) : Number.NaN);
    dragging.value = null;
    if (Number.isInteger(from)) moveTo(from, index);
  }

  function onScopeChange() {
    clearPreview();
    message.value = "";
  }

  function beforeUnload(event: BeforeUnloadEvent) {
    if (!dirty.value && operation.value !== "apply") return;
    event.preventDefault();
    event.returnValue = "";
  }

  onBeforeRouteLeave(() => {
    if (operation.value === "apply") {
      return window.confirm("同步正在进行，离开页面不会取消服务端写入，确定离开吗？");
    }
    if (!dirty.value) return true;
    return window.confirm("还有未保存的媒体库顺序，确定离开吗？");
  });

  onMounted(() => {
    window.addEventListener("beforeunload", beforeUnload);
    void load();
  });
  onBeforeUnmount(() => {
    window.removeEventListener("beforeunload", beforeUnload);
    controller.abort();
  });

  return {
    libraryRows,
    hasSavedOrder,
    users,
    updatedAt,
    preview,
    results,
    operation,
    error,
    message,
    scope,
    testUserId,
    previewOnlyChanges,
    search,
    dragging,
    resultHeading,
    dirty,
    dirtyReason,
    filtering,
    filteredRows,
    syncAction,
    previewWarnings,
    previewRows,
    proxyStatus,
    isNew,
    clearPreview,
    load,
    save,
    previewOrder,
    apply,
    moveTo,
    resetOrder,
    dragStart,
    drop,
    onScopeChange,
  };
}
