import { computed, ref } from "vue";
import {
  isVirtualLibraryItemCompatible,
  type VirtualLibrary,
  type VirtualLibraryItem,
  type VirtualLibraryMappingIssue,
} from "@emby-task-center/contracts/virtual-library";
import { virtualLibraryRequests } from "./virtual-library-requests";
import {
  incompatibleItems,
  incompatibleMessage,
  isSelectableWork,
  selectionError,
} from "../components/virtual-libraries/virtual-library-types";

export interface ProxyState {
  config: { enabled: boolean; upstream: string; port: number };
  status: { running: boolean; port: number | null; error: string | null };
}
export type LibraryDraft = Pick<VirtualLibrary, "name" | "collectionType" | "sortOrder">;

export function useVirtualLibraries(requireAuth: () => void) {
  const { run, error, cancel } = virtualLibraryRequests(requireAuth);
  const libraries = ref<VirtualLibrary[]>([]);
  const selectedId = ref("");
  const items = ref<VirtualLibraryItem[]>([]);
  const issues = ref<VirtualLibraryMappingIssue[]>([]);
  const sourceItems = ref<VirtualLibraryItem[]>([]);
  const sourceLibraries = ref<Array<{ id: string; name: string }>>([]);
  const selectedItems = ref<string[]>([]);
  const total = ref(0);
  const searchTerm = ref("");
  const parentId = ref("");
  const startIndex = ref(0);
  const limit = 24;
  const loading = ref(false);
  const itemLoading = ref(false);
  const sourceLoading = ref(false);
  const rootsLoading = ref(false);
  const saving = ref(false);
  const proxyLoading = ref(false);
  const proxySaving = ref(false);
  const proxy = ref<ProxyState | null>(null);
  const selectedLibrary = computed(() => libraries.value.find((library) => library.id === selectedId.value) ?? null);
  const addedIds = computed(() => new Set(items.value.map((item) => item.itemId)));

  async function load() {
    const result = await run<{ libraries: VirtualLibrary[] }>("libraries", loading, "");
    if (!result) return;
    libraries.value = result.libraries;
    if (!selectedLibrary.value) await selectLibrary(libraries.value[0]?.id ?? "");
  }
  async function selectLibrary(id: string) {
    selectedId.value = id;
    items.value = [];
    issues.value = [];
    selectedItems.value = [];
    if (id) await loadItems();
  }
  async function loadItems() {
    const id = selectedId.value;
    if (!id) return;
    const result = await run<{ items: VirtualLibraryItem[]; issues?: VirtualLibraryMappingIssue[] }>(
      "items",
      itemLoading,
      `/${encodeURIComponent(id)}/items`,
    );
    if (result && selectedId.value === id) {
      items.value = result.items;
      issues.value = result.issues ?? [];
    }
  }
  async function saveLibrary(draft: LibraryDraft, id?: string) {
    if (saving.value) return false;
    const current = libraries.value.find((library) => library.id === id);
    if (current && current.collectionType !== draft.collectionType && id === selectedId.value) {
      const conflicts = incompatibleItems(draft.collectionType, items.value);
      if (itemLoading.value || conflicts.length) {
        error.value = itemLoading.value
          ? "正在检查已加入内容，请稍候再保存类型"
          : incompatibleMessage(draft.collectionType, conflicts);
        return false;
      }
    }
    const result = await run<{ library: VirtualLibrary }>("mutation", saving, id ? `/${encodeURIComponent(id)}` : "", {
      method: id ? "PATCH" : "POST",
      body: JSON.stringify(draft),
    });
    if (!result) return false;
    libraries.value = [...libraries.value.filter((library) => library.id !== result.library.id), result.library].sort(
      (a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name),
    );
    await selectLibrary(result.library.id);
    return true;
  }
  async function deleteLibrary(id: string) {
    if (saving.value) return;
    // 204 has no JSON body; a subsequent read is the authority for the resulting list.
    const result = await run("mutation", saving, `/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (result) await load();
    return !!result;
  }
  async function addItems() {
    const id = selectedId.value;
    if (!id || !selectedItems.value.length || saving.value) return;
    const library = selectedLibrary.value;
    if (!library) {
      error.value = "请重新选择虚拟媒体库后再添加内容";
      return;
    }
    for (const itemId of selectedItems.value) {
      const item = sourceItems.value.find((value) => value.itemId === itemId);
      if (!item || !isSelectableWork(item.type) || !isVirtualLibraryItemCompatible(library.collectionType, item.type)) {
        error.value = item ? selectionError(library.collectionType, item) : "选片内容已更新，请重新选择后添加";
        return;
      }
    }
    const result = await run<{ items: VirtualLibraryItem[] }>("mutation", saving, `/${encodeURIComponent(id)}/items`, {
      method: "POST",
      body: JSON.stringify({ itemIds: selectedItems.value }),
    });
    if (!result) return;
    if (id === selectedId.value) {
      items.value = result.items;
      const remainingIds = new Set(result.items.map((item) => item.itemId));
      issues.value = issues.value.filter((issue) => remainingIds.has(issue.itemId));
      selectedItems.value = [];
      await loadItems();
    }
    await load();
    return true;
  }
  async function removeItem(itemId: string) {
    const id = selectedId.value;
    if (!id || saving.value) return;
    const result = await run("mutation", saving, `/${encodeURIComponent(id)}/items/${encodeURIComponent(itemId)}`, {
      method: "DELETE",
    });
    if (!result) return;
    if (id === selectedId.value) await loadItems();
    await load();
  }
  async function loadSources(reset = false) {
    if (reset) {
      startIndex.value = 0;
      selectedItems.value = [];
    }
    const query = new URLSearchParams({
      searchTerm: searchTerm.value,
      parentId: parentId.value,
      startIndex: String(startIndex.value),
      limit: String(limit),
    });
    const result = await run<{ items: VirtualLibraryItem[]; total: number }>(
      "sources",
      sourceLoading,
      `/source-items?${query}`,
    );
    if (result) {
      sourceItems.value = result.items;
      total.value = result.total;
    }
  }
  async function loadSourceLibraries() {
    const result = await run<{ items: Array<{ id: string; name: string }> }>(
      "roots",
      rootsLoading,
      "/source-libraries",
    );
    if (result) sourceLibraries.value = result.items;
  }
  async function loadProxy() {
    const result = await run<ProxyState>("proxy", proxyLoading, "/proxy");
    if (result) proxy.value = result;
  }
  async function saveProxy(config: ProxyState["config"]) {
    if (proxySaving.value) return;
    const result = await run<ProxyState>("proxy", proxySaving, "/proxy", {
      method: "PUT",
      body: JSON.stringify(config),
    });
    if (result) proxy.value = result;
  }
  function toggleItem(id: string) {
    if (!selectedItems.value.includes(id)) {
      const library = selectedLibrary.value;
      const item = sourceItems.value.find((value) => value.itemId === id);
      if (!library || !item) return;
      if (!isSelectableWork(item.type) || !isVirtualLibraryItemCompatible(library.collectionType, item.type)) {
        error.value = selectionError(library.collectionType, item);
        return;
      }
    }
    selectedItems.value = selectedItems.value.includes(id)
      ? selectedItems.value.filter((item) => item !== id)
      : [...selectedItems.value, id];
  }
  async function page(direction: number) {
    startIndex.value = Math.max(0, startIndex.value + direction * limit);
    selectedItems.value = [];
    await loadSources();
  }
  return {
    libraries,
    selectedId,
    selectedLibrary,
    items,
    issues,
    sourceItems,
    sourceLibraries,
    selectedItems,
    addedIds,
    total,
    searchTerm,
    parentId,
    startIndex,
    limit,
    loading,
    itemLoading,
    sourceLoading,
    saving,
    proxyLoading,
    proxySaving,
    proxy,
    error,
    load,
    loadItems,
    selectLibrary,
    saveLibrary,
    deleteLibrary,
    addItems,
    removeItem,
    loadSources,
    loadSourceLibraries,
    loadProxy,
    saveProxy,
    toggleItem,
    page,
    cancel,
  };
}
