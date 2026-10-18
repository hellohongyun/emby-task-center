<script setup lang="ts">
import SvgIcon from "@jamescoyle/vue-icon";
import { mdiClose, mdiFilterVariant, mdiMagnify } from "@mdi/js";
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";

import LibraryDetailDialog from "./LibraryDetailDialog.vue";
import FilterChipRow, { type FilterOption } from "./FilterChipRow.vue";
import { useLibraryPortal, type PublicLibraryFacets, type PublicLibraryItem } from "../composables/useLibraryPortal";

const props = withDefaults(defineProps<{ query?: string }>(), { query: "" });

const PAGE_SIZE = 24;
const library = useLibraryPortal();
const items = ref<PublicLibraryItem[]>([]);
const total = ref(0);
const loading = ref(false);
const error = ref("");
const offset = ref(0);
const searchText = ref(props.query);
const filtersOpen = ref(false);
const facets = ref<PublicLibraryFacets | null>(null);
const selected = ref<PublicLibraryItem | null>(null);
const detail = ref<PublicLibraryItem | null>(null);
const detailLoading = ref(false);
const posterErrors = reactive<Record<string, boolean>>({});
const loadMoreSentinel = ref<HTMLElement | null>(null);
let observer: IntersectionObserver | null = null;
let requestSeq = 0;
let listController: AbortController | undefined;
let detailController: AbortController | undefined;

const typeFilter = ref<"all" | "movie" | "tv">("all");
const statusFilter = ref<"all" | "matched" | "unresolved">("all");
const resolutionFilter = ref<string>("all");
const codecFilter = ref<string>("all");
const genreFilter = ref<string>("all");
const yearFilter = ref<string>("all");
const sortFilter = ref<"latest" | "title" | "year">("latest");

const fallbackResolutions = ["2160p", "1080p", "720p", "480p"];
const resolutions = computed(() =>
  facets.value?.resolutions?.length ? facets.value.resolutions : fallbackResolutions,
);
const fallbackCodecs = [
  "HEVC",
  "AVC",
  "AV1",
  "DoVi",
  "HDR10+",
  "HDR10",
  "Atmos",
  "TrueHD",
  "DTS",
  "BluRay",
  "Remux",
  "WEB-DL",
];
const codecs = computed(() => (facets.value?.codecs?.length ? facets.value.codecs : fallbackCodecs));
const resolutionOptions = computed<FilterOption[]>(() => resolutions.value.map((value) => ({ value, label: value })));
const codecOptions = computed<FilterOption[]>(() => codecs.value.map((value) => ({ value, label: value })));
const genreOptions = computed<FilterOption[]>(() =>
  (facets.value?.genres ?? []).map((value) => ({ value, label: value })),
);
const yearOptions = computed<FilterOption[]>(() =>
  (facets.value?.years ?? []).map((year) => ({ value: String(year), label: String(year) })),
);
const sortOptions: FilterOption[] = [
  { value: "latest", label: "最近入库" },
  { value: "title", label: "按片名" },
  { value: "year", label: "按年份" },
];
const typeFilterOptions: FilterOption[] = [
  { value: "movie", label: "电影" },
  { value: "tv", label: "剧集" },
];
const statusFilterOptions: FilterOption[] = [
  { value: "matched", label: "已匹配" },
  { value: "unresolved", label: "未匹配" },
];
const isSearch = computed(() => searchText.value.trim().length > 0);
const activeFilterCount = computed(
  () =>
    [
      typeFilter.value !== "all",
      statusFilter.value !== "all",
      resolutionFilter.value !== "all",
      codecFilter.value !== "all",
      genreFilter.value !== "all",
      yearFilter.value !== "all",
      sortFilter.value !== "latest",
      isSearch.value,
    ].filter(Boolean).length,
);

function buildFilters() {
  return {
    type: typeFilter.value,
    status: statusFilter.value,
    resolution: resolutionFilter.value === "all" ? undefined : resolutionFilter.value,
    codec: codecFilter.value === "all" ? undefined : codecFilter.value,
    genre: genreFilter.value === "all" ? undefined : genreFilter.value,
    year: yearFilter.value === "all" ? undefined : yearFilter.value,
    sort: sortFilter.value === "latest" ? undefined : sortFilter.value,
    q: searchText.value.trim() || undefined,
  };
}

async function load(reset = false) {
  const seq = ++requestSeq;
  listController?.abort();
  const controller = (listController = new AbortController());
  if (reset) offset.value = 0;
  loading.value = true;
  error.value = "";
  try {
    const result = await library.list(PAGE_SIZE, offset.value, buildFilters(), controller.signal);
    if (seq !== requestSeq) return;
    if (!result) {
      error.value = "媒体库暂不可用。";
      return;
    }
    items.value = reset ? result.items : [...items.value, ...result.items];
    total.value = result.total;
    offset.value += result.items.length;
    if (result.facets) facets.value = result.facets;
  } finally {
    if (seq === requestSeq) loading.value = false;
  }
}

function runSearch() {
  void load(true);
}
function clearSearch() {
  searchText.value = "";
  void load(true);
}
function resetFilters() {
  typeFilter.value = "all";
  statusFilter.value = "all";
  resolutionFilter.value = "all";
  codecFilter.value = "all";
  genreFilter.value = "all";
  yearFilter.value = "all";
  sortFilter.value = "latest";
}

function posterSrc(item: PublicLibraryItem): string | null {
  return posterErrors[item.id] ? null : item.posterUrl;
}
function posterFailed(item: PublicLibraryItem) {
  posterErrors[item.id] = true;
}

function openDetail(item: PublicLibraryItem) {
  detailController?.abort();
  const controller = (detailController = new AbortController());
  selected.value = item;
  detail.value = item;
  detailLoading.value = true;
  void library
    .detail(item.id, controller.signal)
    .then((body) => {
      if (!controller.signal.aborted && selected.value?.id === item.id) detail.value = body ?? item;
    })
    .finally(() => {
      if (!controller.signal.aborted && selected.value?.id === item.id) detailLoading.value = false;
    });
}
function closeDetail() {
  detailController?.abort();
  selected.value = null;
  detail.value = null;
  detailLoading.value = false;
}

function setupInfiniteScroll() {
  if (observer) observer.disconnect();
  if (!loadMoreSentinel.value) return;
  observer = new IntersectionObserver(
    (entries) => {
      if (entries.some((entry) => entry.isIntersecting) && !loading.value && items.value.length < total.value) {
        void load();
      }
    },
    { rootMargin: "800px 0px", threshold: 0 },
  );
  observer.observe(loadMoreSentinel.value);
}
function teardownInfiniteScroll() {
  observer?.disconnect();
  observer = null;
}

let scrollCheckTimer: number | null = null;
function nearBottom(): boolean {
  const scrollTop = window.scrollY || document.documentElement.scrollTop || document.body.scrollTop;
  const viewport = window.innerHeight || document.documentElement.clientHeight;
  const height = document.documentElement.scrollHeight;
  return height - scrollTop - viewport < 800;
}
function maybeAutoLoadMore() {
  if (loading.value || items.value.length >= total.value || !nearBottom()) return;
  void load();
}
function onWindowScroll() {
  if (scrollCheckTimer != null) return;
  scrollCheckTimer = window.setTimeout(() => {
    scrollCheckTimer = null;
    maybeAutoLoadMore();
  }, 120);
}
function startScrollListener() {
  window.addEventListener("scroll", onWindowScroll, { passive: true });
}
function stopScrollListener() {
  window.removeEventListener("scroll", onWindowScroll);
  if (scrollCheckTimer != null) {
    window.clearTimeout(scrollCheckTimer);
    scrollCheckTimer = null;
  }
}

watch(
  () => props.query,
  (query) => {
    if (query && query.trim()) {
      searchText.value = query;
      void load(true);
    }
  },
);
watch([typeFilter, statusFilter, resolutionFilter, codecFilter, genreFilter, yearFilter, sortFilter], () => {
  void load(true);
});
watch(items, () => {
  void nextTick(setupInfiniteScroll);
});
onMounted(() => {
  void load(true);
  startScrollListener();
  void nextTick(setupInfiniteScroll);
});
onBeforeUnmount(() => {
  requestSeq += 1;
  listController?.abort();
  closeDetail();
  stopScrollListener();
  teardownInfiniteScroll();
});
</script>

<template>
  <section class="library-page">
    <header class="library-head">
      <div>
        <h1>影视库</h1>
        <p>已入库的片源与尚未匹配 TMDB 的条目都在这里；点击卡片查看详情。</p>
      </div>
      <span v-if="total && !isSearch" class="count">共 {{ total }} 项</span>
    </header>

    <div v-if="filtersOpen" class="filter-backdrop" aria-hidden="true" @click="filtersOpen = false"></div>

    <div class="library-toolbar">
      <div class="search-line">
        <div class="search-box">
          <SvgIcon type="mdi" :path="mdiMagnify" :size="16" aria-hidden="true" />
          <input
            v-model="searchText"
            type="search"
            enterkeyhint="search"
            placeholder="搜索片名 / 原片名…"
            @keyup.enter="runSearch"
          />
          <button v-if="searchText" type="button" class="clear-search" aria-label="清除搜索" @click="clearSearch">
            <SvgIcon type="mdi" :path="mdiClose" :size="15" />
          </button>
        </div>
        <button
          type="button"
          class="filter-toggle"
          :class="{ open: filtersOpen, active: activeFilterCount > 0 }"
          :aria-expanded="filtersOpen"
          @click="filtersOpen = !filtersOpen"
        >
          <SvgIcon type="mdi" :path="mdiFilterVariant" :size="16" />
          <span>筛选</span>
          <b v-if="activeFilterCount">{{ activeFilterCount }}</b>
        </button>
      </div>

      <div class="filter-panel" :class="{ open: filtersOpen }">
        <div class="filter-panel-head">
          <strong>筛选</strong>
          <button type="button" aria-label="收起筛选" @click="filtersOpen = false">收起</button>
        </div>
        <div class="filter-section">
          <span class="filter-label">类型</span>
          <FilterChipRow v-model="typeFilter" :options="typeFilterOptions" all-label="全部" />
        </div>

        <div class="filter-section">
          <span class="filter-label">状态</span>
          <FilterChipRow v-model="statusFilter" :options="statusFilterOptions" all-label="全部" />
        </div>

        <div class="filter-section">
          <span class="filter-label">画质</span>
          <FilterChipRow v-model="resolutionFilter" :options="resolutionOptions" all-label="全部画质" />
        </div>

        <div class="filter-section">
          <span class="filter-label">规格</span>
          <FilterChipRow v-model="codecFilter" :options="codecOptions" all-label="全部规格" scrollable />
        </div>

        <div class="filter-section wide">
          <span class="filter-label">题材</span>
          <FilterChipRow v-model="genreFilter" :options="genreOptions" all-label="全部题材" scrollable />
        </div>

        <div class="filter-section wide">
          <span class="filter-label">年份</span>
          <FilterChipRow v-model="yearFilter" :options="yearOptions" all-label="全部年份" scrollable />
        </div>

        <div class="filter-section wide">
          <span class="filter-label">排序</span>
          <FilterChipRow v-model="sortFilter" :options="sortOptions" all-label="默认排序" :show-all="false" />
        </div>
      </div>
    </div>

    <p v-if="error" class="empty error" role="alert">{{ error }}</p>
    <div v-else-if="loading && !items.length" class="grid" role="status">
      <span v-for="n in 12" :key="n" class="card skeleton-card" />
    </div>
    <div v-else-if="!items.length" class="empty">
      <strong>{{
        activeFilterCount ? "没有匹配筛选的内容" : isSearch ? "没有找到匹配的入库内容" : "影视库还是空的"
      }}</strong>
      <p>
        {{
          activeFilterCount
            ? "换个筛选条件试试，或清除筛选查看全部内容。"
            : isSearch
              ? "换个片名试试，或清空搜索查看全部。"
              : "媒体库来自 Emby：Emby 里已有的影片与剧集都会出现在这里。"
        }}
      </p>
      <button v-if="activeFilterCount" type="button" class="empty-action" @click="resetFilters">清除筛选</button>
    </div>

    <template v-else>
      <ul class="grid">
        <li v-for="item in items" :key="item.id" class="card">
          <button type="button" class="card-hit" :aria-label="`查看 ${item.title} 详情`" @click="openDetail(item)">
            <div class="poster">
              <img
                v-if="posterSrc(item)"
                :src="posterSrc(item)!"
                :alt="item.title"
                loading="lazy"
                @error="posterFailed(item)"
              />
              <span v-else class="poster-fallback" :class="{ unresolved: item.status === 'unresolved' }">
                <span class="fallback-letter">{{ item.title.slice(0, 1) }}</span>
                <small v-if="item.status === 'unresolved'">未匹配</small>
              </span>
              <span class="badge" :class="{ unresolved: item.status === 'unresolved' }">
                {{ item.status === "unresolved" ? "未匹配" : item.mediaType === "tv" ? "剧集" : "电影" }}
              </span>
              <span v-if="item.resolution" class="res-badge">{{ item.resolution }}</span>
              <span class="view-hint">查看详情</span>
            </div>
            <b class="card-title" :title="item.title">{{ item.title }}</b>
            <small class="card-meta">
              <template v-if="item.year">{{ item.year }}</template>
              <template v-if="item.fileCount">
                · {{ item.mediaType === "tv" ? "已入库集数" : "文件" }} <b>{{ item.fileCount }}</b></template
              >
            </small>
          </button>
        </li>
      </ul>

      <div v-if="items.length < total" ref="loadMoreSentinel" class="load-more">
        <button type="button" :disabled="loading" @click="load()">
          {{ loading ? "加载中…" : `加载更多（${items.length}/${total}）` }}
        </button>
      </div>
    </template>

    <LibraryDetailDialog v-if="selected" :item="detail ?? selected" :loading="detailLoading" @close="closeDetail" />
  </section>
</template>

<style scoped>
.library-page {
  display: grid;
  gap: 18px;
}
.library-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 4px 0;
}
.library-head h1 {
  margin: 0 0 6px;
  font-size: 24px;
  font-weight: 780;
}
.library-head p {
  margin: 0;
  color: var(--text-dim);
  font-size: 13px;
}
.count {
  padding: 4px 10px;
  border: 1px solid var(--line);
  border-radius: 999px;
  color: var(--text-dim);
  font-size: 12px;
  background: #0a141c;
}

.library-toolbar {
  display: grid;
  gap: 10px;
  padding: 0 4px;
}
.search-line {
  display: flex;
  gap: 8px;
  align-items: center;
}
.search-box {
  display: flex;
  flex: 1;
  align-items: center;
  gap: 8px;
  min-width: 0;
  min-height: 40px;
  padding: 0 12px;
  border: 1px solid var(--line-strong);
  border-radius: 10px;
  color: var(--text-dim);
  background: var(--input);
}
.search-box:focus-within {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-dim);
}
.search-box input {
  flex: 1;
  min-width: 0;
  border: 0;
  outline: 0;
  color: var(--text);
  background: transparent;
  font-size: 13px;
}
.search-box input::placeholder {
  color: #5f7480;
}
.clear-search {
  flex: none;
  width: 26px;
  height: 26px;
  padding: 0;
  display: grid;
  place-items: center;
  border: 0;
  border-radius: 7px;
  color: #9aa5ad;
  background: transparent;
  cursor: pointer;
}
.clear-search:hover {
  color: var(--text);
  background: #101d25;
}

.filter-toggle {
  flex: none;
  min-height: 40px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 0 13px;
  border: 1px solid var(--line-strong);
  border-radius: 10px;
  color: #cdd6dc;
  background: #14202b;
  cursor: pointer;
  font-size: 13px;
  font-weight: 650;
}
.filter-toggle b {
  min-width: 18px;
  height: 18px;
  display: grid;
  place-items: center;
  padding: 0 5px;
  border-radius: 999px;
  color: var(--accent-ink);
  background: var(--accent-strong);
  font-size: 10px;
}
.filter-toggle.active,
.filter-toggle.open {
  border-color: #3e6b48;
  color: #b9e8bb;
}

.filter-backdrop {
  display: none;
}
.filter-panel-head {
  display: none;
}
.filter-panel-head strong {
  font-size: 15px;
}
.filter-panel-head button {
  min-height: 34px;
  padding: 0 12px;
  border: 1px solid var(--line-strong);
  border-radius: 999px;
  color: #9aa6ae;
  background: #101c24;
  cursor: pointer;
}

.filter-panel {
  display: none;
  grid-template-columns: 1fr;
  gap: 10px;
  padding: 13px;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: #0a141c;
}
.filter-panel.open {
  display: grid;
}
.filter-section {
  display: grid;
  grid-template-columns: 64px minmax(0, 1fr);
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.filter-label {
  color: #6f7f89;
  font-size: 11px;
  font-weight: 700;
}

.grid {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 14px;
}
.card {
  min-width: 0;
}
.card-hit {
  width: 100%;
  display: grid;
  gap: 7px;
  padding: 8px;
  border: 1px solid var(--line);
  border-radius: var(--radius-lg);
  background: var(--surface);
  color: inherit;
  text-align: left;
  cursor: pointer;
  transition:
    border-color 0.18s var(--ease),
    transform 0.18s var(--ease),
    background-color 0.18s var(--ease);
}
.card-hit:hover {
  border-color: #4f7a52;
  background: var(--surface-hi);
  transform: translateY(-2px);
}
.skeleton-card {
  min-height: 278px;
  border: 1px solid var(--line);
  border-radius: var(--radius-lg);
  background: #0d1921;
}

.poster {
  position: relative;
  aspect-ratio: 2 / 3;
  border-radius: 9px;
  overflow: hidden;
  background: #0a1218;
}
.poster img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.poster-fallback {
  position: relative;
  width: 100%;
  height: 100%;
  display: grid;
  place-items: center;
  color: #33505f;
  background: linear-gradient(165deg, #14314a, #0b1a26 55%, #0d1921);
}
.poster-fallback.unresolved {
  background: linear-gradient(165deg, #2b2417, #14110b 55%, #0d1921);
}
.fallback-letter {
  font-size: 40px;
  font-weight: 820;
  letter-spacing: -0.04em;
  color: #4d7186;
  text-shadow: 0 6px 22px rgb(0 0 0 / 42%);
}
.poster-fallback.unresolved .fallback-letter {
  color: #b9984f;
}
.poster-fallback small {
  position: absolute;
  bottom: 10px;
  left: 50%;
  transform: translateX(-50%);
  padding: 3px 9px;
  border: 1px solid rgb(255 255 255 / 10%);
  border-radius: 999px;
  color: #e6c06a;
  background: rgb(14 12 7 / 64%);
  font-size: 10px;
  font-weight: 720;
  white-space: nowrap;
}

.badge {
  position: absolute;
  top: 7px;
  left: 7px;
  padding: 2px 7px;
  border-radius: 999px;
  color: #8fd0a0;
  background: rgb(18 43 28 / 86%);
  font-size: 10px;
  font-weight: 740;
}
.badge.unresolved {
  color: #e6c06a;
  background: rgb(55 44 16 / 86%);
}
.res-badge {
  position: absolute;
  top: 7px;
  right: 7px;
  padding: 2px 7px;
  border-radius: 999px;
  color: #e7d9a8;
  background: rgb(58 46 14 / 88%);
  font-size: 10px;
  font-weight: 740;
}
.view-hint {
  position: absolute;
  right: 7px;
  bottom: 7px;
  left: 7px;
  display: grid;
  place-items: center;
  min-height: 30px;
  border-radius: 8px;
  color: #d8f0d9;
  background: rgb(8 20 14 / 78%);
  backdrop-filter: blur(4px);
  font-size: 11px;
  font-weight: 700;
  opacity: 0;
  transform: translateY(4px);
  transition:
    opacity 0.18s var(--ease),
    transform 0.18s var(--ease);
  pointer-events: none;
}
.card-hit:hover .view-hint,
.card-hit:focus-visible .view-hint {
  opacity: 1;
  transform: none;
}

.card-title {
  color: var(--text);
  font-size: 13px;
  line-height: 1.35;
  min-height: 36px;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.card-meta {
  color: var(--text-faint);
  font-size: 11px;
}
.card-meta b {
  color: #8fb7e8;
}

.empty {
  display: grid;
  gap: 8px;
  padding: 40px 20px;
  border: 1px dashed var(--line);
  border-radius: var(--radius-lg);
  text-align: center;
  color: var(--text-dim);
}
.empty strong {
  color: var(--text);
  font-size: 16px;
}
.empty p {
  margin: 0;
  font-size: 13px;
}
.empty.error {
  color: #f27979;
}
.empty-action {
  justify-self: center;
  min-height: 36px;
  padding: 0 14px;
  border: 1px solid #3e6b48;
  border-radius: 9px;
  color: #b9e8bb;
  background: #10241b;
  cursor: pointer;
  font-size: 12px;
}

.load-more {
  display: flex;
  justify-content: center;
  padding: 8px 0 20px;
}
.load-more button {
  min-height: 42px;
  padding: 0 18px;
  border: 1px solid var(--line-strong);
  border-radius: 9px;
  color: #cdd6dc;
  background: #14202b;
  cursor: pointer;
  font-size: 13px;
}

@media (max-width: 899px) {
  .filter-backdrop {
    display: block;
    position: fixed;
    z-index: 119;
    inset: 0;
    background: rgb(0 4 7 / 64%);
    backdrop-filter: blur(3px);
  }
  .filter-panel.open {
    position: fixed;
    z-index: 120;
    right: 0;
    bottom: 0;
    left: 0;
    max-height: 82dvh;
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
    touch-action: pan-y;
    overscroll-behavior: contain;
    border: 1px solid var(--line-strong);
    border-bottom: 0;
    border-radius: 20px 20px 0 0;
    box-shadow: 0 -20px 60px rgb(0 0 0 / 45%);
    padding-bottom: calc(16px + env(safe-area-inset-bottom));
  }
  .filter-panel-head {
    grid-column: 1 / -1;
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 2px;
  }
}

@media (min-width: 900px) {
  .filter-toggle {
    display: none;
  }
  .filter-panel {
    display: grid !important;
    grid-template-columns: 1fr;
    padding: 14px 16px;
  }
}

@media (max-width: 560px) {
  .library-page {
    gap: 14px;
  }
  .library-head {
    align-items: flex-start;
    flex-direction: column;
    gap: 8px;
    padding-top: 4px;
  }
  .library-head h1 {
    font-size: 21px;
    margin-bottom: 4px;
  }
  .grid {
    grid-template-columns: repeat(2, 1fr);
    gap: 10px;
  }
  .card-hit {
    padding: 6px;
  }
  .card-title {
    min-height: 34px;
    font-size: 12px;
  }
  .fallback-letter {
    font-size: 32px;
  }
  .filter-panel {
    grid-template-columns: 1fr;
    gap: 12px;
    max-height: 70dvh;
    overflow-y: auto;
    overscroll-behavior: contain;
  }
  .filter-section {
    grid-template-columns: 1fr;
    gap: 4px;
  }
  .search-box {
    min-height: 40px;
  }
}
</style>
