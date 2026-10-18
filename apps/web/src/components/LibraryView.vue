<script setup lang="ts">
import SvgIcon from "@jamescoyle/vue-icon";
import { mdiAlertCircleOutline, mdiFolderMultipleOutline, mdiRefresh } from "@mdi/js";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import LibraryAdminDetailDialog from "./LibraryAdminDetailDialog.vue";
import LibraryFilterPanel from "./LibraryFilterPanel.vue";
import LibraryRootCard from "./LibraryRootCard.vue";
import LibrarySummaryBar from "./LibrarySummaryBar.vue";
import LibraryUnmatchedReport from "./LibraryUnmatchedReport.vue";
import { SORT_FILTER_OPTIONS, STATUS_FILTER_OPTIONS, TYPE_FILTER_OPTIONS } from "../composables/useLibraryFilters";
import type { useLibrary } from "../composables/useLibrary";
import { countActiveFilters, EMPTY_LIBRARY_FILTERS, type LibraryFilterValues } from "../library/filters";
import type { WorkGroupSummary } from "../library/paged-library";
import { posterUrlFor, type WorkGroup } from "../library/work-groups";

const props = defineProps<{ library: ReturnType<typeof useLibrary> }>();
const selectedRoot = ref("");
const filterModel = ref<LibraryFilterValues>({ ...EMPTY_LIBRARY_FILTERS });
const queryFilter = computed({
  get: () => filterModel.value.query,
  set: (query: string) => {
    filterModel.value = { ...filterModel.value, query };
  },
});
const page = ref(1);
const current = computed(() => props.library.worksPage.value);
const activeFilters = computed(() => countActiveFilters(filterModel.value));
const facets = computed(() => current.value?.facets);
const option = (values: readonly (string | number)[] = []) =>
  values.map((value) => ({ value: String(value), label: String(value) }));
const totalPages = computed(() => Math.max(1, Math.ceil((current.value?.total ?? 0) / 48)));
const matching = ref(false);
const message = ref("");
const selectedGroup = ref<{ group: WorkGroup; rootId: string; posterUrl: string | null } | null>(null);
const detailLoading = ref(false);
let detailSequence = 0;
let filterTimer: ReturnType<typeof setTimeout> | undefined;
let disposed = false;

async function load() {
  if (!selectedRoot.value || disposed) return;
  await props.library.loadWorks(selectedRoot.value, page.value, filterModel.value);
  if (current.value?.root.id === selectedRoot.value) page.value = current.value.page;
}
async function refresh() {
  if (disposed) return;
  await props.library.loadRoots();
  if (disposed) return;
  if (!props.library.roots.value.some((root) => root.id === selectedRoot.value)) {
    selectedRoot.value = props.library.roots.value[0]?.id ?? "";
  } else await load();
}
watch(selectedRoot, () => {
  clearTimeout(filterTimer);
  page.value = 1;
  closeDetail();
  void load();
});
watch(
  filterModel,
  () => {
    clearTimeout(filterTimer);
    props.library.cancelPage();
    filterTimer = setTimeout(() => {
      page.value = 1;
      void load();
    }, 250);
  },
  { deep: true },
);
function changePage(next: number) {
  clearTimeout(filterTimer);
  page.value = next;
  void load();
}
async function scan(rootId: string) {
  if (await props.library.scan(rootId)) await refresh();
}
async function runMatch() {
  if (matching.value) return;
  matching.value = true;
  const result = await props.library.matchUnresolved(200);
  if (disposed) return;
  message.value = result
    ? `补齐 ${result.matchedGroups} 组 / 关联 ${result.linkedLibraryItems} 条，清理孤儿 ${result.cleaned} 条`
    : "补齐失败，请稍后重试";
  matching.value = false;
  if (result) await refresh();
}
async function openDetail(group: WorkGroupSummary, rootId: string) {
  const sequence = ++detailSequence;
  detailLoading.value = true;
  message.value = "";
  try {
    const body = await props.library.loadItems(rootId, group.key);
    if (sequence === detailSequence)
      selectedGroup.value = {
        group: { ...group, items: body.items },
        rootId,
        posterUrl: posterUrlFor(group.posterPath),
      };
  } catch {
    if (sequence === detailSequence) message.value = "作品详情读取失败，请重试。";
  } finally {
    if (sequence === detailSequence) detailLoading.value = false;
  }
}
function closeDetail() {
  detailSequence += 1;
  props.library.cancelItems();
  selectedGroup.value = null;
  detailLoading.value = false;
}
function handleBound() {
  closeDetail();
  void refresh();
}
onMounted(() => void refresh());
onBeforeUnmount(() => {
  disposed = true;
  clearTimeout(filterTimer);
  props.library.cancelRequests();
  closeDetail();
});
</script>

<template>
  <section class="library-view" aria-labelledby="library-title">
    <header class="library-heading">
      <div>
        <span class="eyebrow">EMBY LIBRARY INVENTORY</span>
        <h1 id="library-title">媒体库</h1>
        <p>选择媒体库，按电影和整部剧浏览；打开剧集详情查看完整分集。</p>
      </div>
      <div class="heading-actions">
        <button type="button" :disabled="matching" @click="runMatch">{{ matching ? "补齐中…" : "补齐未匹配" }}</button>
        <button type="button" :disabled="library.loading.value || library.summaryLoading.value" @click="refresh">
          <SvgIcon type="mdi" :path="mdiRefresh" :size="20" />刷新目录
        </button>
      </div>
    </header>
    <p v-if="message" class="match-message" role="status">{{ message }}</p>
    <LibrarySummaryBar
      v-if="library.overview.value"
      :summary="library.overview.value.summary"
      :root-count="library.roots.value.length"
    />
    <LibraryUnmatchedReport
      v-if="library.overview.value?.unmatchedReport.length"
      :report="library.overview.value.unmatchedReport"
    />
    <p v-if="library.error.value" class="library-error" role="alert">
      <SvgIcon type="mdi" :path="mdiAlertCircleOutline" :size="20" />{{ library.error.value }}
    </p>
    <p v-if="library.summaryLoading.value && !library.overview.value" role="status">正在读取媒体库概览…</p>
    <div v-if="!library.summaryLoading.value && !library.roots.value.length && !library.error.value" class="empty">
      <SvgIcon type="mdi" :path="mdiFolderMultipleOutline" :size="38" />
      <strong>尚未配置媒体库</strong>
      <span>请到「系统设置 → Emby」填写 Emby 地址与 API Key，并确认 Emby 里已有电影或剧集媒体库。</span>
    </div>
    <label v-if="library.roots.value.length" class="library-picker"
      >媒体库
      <select v-model="selectedRoot" aria-label="选择媒体库">
        <option v-for="root in library.roots.value" :key="root.id" :value="root.id">{{ root.name }}</option>
      </select>
    </label>
    <LibraryFilterPanel
      v-if="selectedRoot"
      v-model="filterModel"
      v-model:query="queryFilter"
      :type-options="TYPE_FILTER_OPTIONS"
      :status-options="STATUS_FILTER_OPTIONS"
      :sort-options="SORT_FILTER_OPTIONS"
      :resolution-options="option(facets?.resolutions)"
      :codec-options="option(facets?.codecs)"
      :genre-options="option(facets?.genres)"
      :year-options="option(facets?.years)"
      :visible-group-count="current?.total ?? 0"
      :active-filter-count="activeFilters"
      :has-active-filters="activeFilters > 0"
      @clear="filterModel = { ...EMPTY_LIBRARY_FILTERS }"
    />
    <p v-if="library.loading.value" role="status">正在读取作品…</p>
    <p v-if="detailLoading" role="status">正在读取作品详情… <button type="button" @click="closeDetail">取消</button></p>
    <LibraryRootCard
      v-if="current && current.root.id === selectedRoot"
      :root="current.root"
      :summary="current.summary"
      :scanning-root-id="library.scanningRootId.value"
      :groups="current.works"
      @scan="scan"
      @select="openDetail"
    />
    <nav v-if="current" class="library-pagination" aria-label="媒体库分页">
      <button type="button" :disabled="library.loading.value || page <= 1" @click="changePage(page - 1)">上一页</button>
      <span>第 {{ page }} / {{ totalPages }} 页 · 共 {{ current.total }} 个作品</span>
      <button type="button" :disabled="library.loading.value || page >= totalPages" @click="changePage(page + 1)">
        下一页
      </button>
    </nav>
    <LibraryAdminDetailDialog
      v-if="selectedGroup"
      :group="selectedGroup.group"
      :root-id="selectedGroup.rootId"
      :poster-url="selectedGroup.posterUrl"
      @close="closeDetail"
      @bound="handleBound"
    />
  </section>
</template>

<style scoped src="./LibraryView.css"></style>
