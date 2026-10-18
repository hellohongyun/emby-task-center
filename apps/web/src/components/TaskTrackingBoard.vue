<script setup lang="ts">
import SvgIcon from "@jamescoyle/vue-icon";
import {
  mdiChevronDown,
  mdiDeleteOutline,
  mdiMagnify,
  mdiMovieOpenOutline,
  mdiPlus,
  mdiRefresh,
  mdiSwapHorizontal,
  mdiTelevisionClassic,
} from "@mdi/js";
import { computed, ref } from "vue";

import type { Task, TaskLibrarySource, TaskSeasonLibrary, TaskSeasonRow } from "../types";
import { useIsNarrowViewport } from "../composables/useMediaQuery";
import { useTmdbSearch } from "../composables/useTmdbSearch";
import { useTaskBoardActions } from "../composables/task-board-actions";

/**
 * 任务看板 —— 入库任务的监控 + 创建。
 *
 * 一行一剧：剧名 · TMDB 已播 · 库内已存 · 媒体库（存在哪个库、库内哪个目录）· 缺几集 · 最后检查 · 状态；
 * 展开后每季一行：季号 · 已播 · 已存 · 媒体库（该季落在哪个库）· 缺哪几集。
 *
 * 桌面（>900px）用真表格，可排序、行内展开；窄屏用卡片 + 手风琴。
 * 两套是不同 DOM：手机上不该存在一张溢出屏幕的表格。
 *
 * 创建入口 = 搜 TMDB 建一条「完结入库」任务（追更已整体下线，不再有"持续追更"这一维）：
 * 任务登记已播与已存状态，片源入库由外部流程完成。
 */
const props = defineProps<{
  tasks: Task[];
  loading?: boolean;
  createTask?: (input: {
    tmdbId: number;
    title: string;
    mediaType: "tv" | "movie";
  }) => Promise<{ ok: boolean; error?: string; created?: boolean }>;
  /** 改绑 TMDB 条目：选错同名剧 / 手滑填错 id 时的手动修复入口。 */
  rebindTask?: (
    taskId: number,
    input: { tmdbId: number; mediaType?: "tv" | "movie"; title?: string },
  ) => Promise<{ ok: boolean; error?: string; merged?: boolean; metadataSynced?: boolean }>;
  deleteTask?: (taskId: number) => Promise<void>;
  requireAuth?: () => void;
}>();
const emit = defineEmits<{ refresh: [] }>();

const isNarrow = useIsNarrowViewport();
const tmdb = useTmdbSearch(fetch, () => props.requireAuth?.());

type SortKey = "title" | "aired" | "stored" | "missing" | "checked";
const sortKey = ref<SortKey>("title");
const sortAsc = ref(true);
const expanded = ref<Set<number>>(new Set());

/**
 * 状态筛选（看板自己的状态，而不是已删除的任务生命周期）。
 *
 * 侧边栏原来那组「全部任务 / 追更中 / 待执行 / 处理中 / 已完成」是按 task.status 过滤的，
 * 而看板上的任务实际只有"缺集/已齐"两种：待执行/处理中/已完成永远是 0，筛选也对看板无效。
 * 现在改成看板真正会出现的状态，数字与行上的状态胶囊一致。
 * （追更已整体下线：不再有"追更中/已完结"这一维。）
 */
type StatusFilter = "all" | "missing" | "pending" | "complete";
const statusFilter = ref<StatusFilter>("all");

const rows = computed(() =>
  props.tasks.map((task) => {
    const seasons = task.seasons ?? [];
    // 任务级数字由服务端算好（媒体库逐集明细优先），分季只做展开明细。
    const aired = task.airProgress ?? seasons.reduce((sum, season) => sum + (season.airProgress ?? 0), 0);
    const stored = task.storedProgress ?? seasons.reduce((sum, season) => sum + (season.storedProgress ?? 0), 0);
    const missing = task.missingEpisodes?.length ?? 0;
    // 「今日更新」：已播出但还在入库宽限期内（默认次日 0 点前）的集——不算缺集，只提示。
    const pendingEpisodes = task.pendingEpisodes ?? seasons.flatMap((season) => season.pendingEpisodes ?? []);
    const pending = pendingEpisodes.length;
    const unmatched = task.unmatchedSeasons ?? [];
    const status = statusOf(missing, pending);
    const statusKey: StatusFilter = missing > 0 ? "missing" : pending > 0 ? "pending" : "complete";
    // 已存集数究竟存在哪个 Emby 库：服务端按库根归属算好（libraries），前端只负责展示。
    const libraries = task.libraries ?? [];
    return { task, seasons, aired, stored, missing, pending, pendingEpisodes, unmatched, status, statusKey, libraries };
  }),
);

/** 筛选按钮与计数（数字随数据实时变化，口径与行上的状态胶囊一致）。 */
const statusTabs = computed(() => {
  const counts: Record<StatusFilter, number> = { all: rows.value.length, missing: 0, pending: 0, complete: 0 };
  for (const row of rows.value) counts[row.statusKey] += 1;
  return [
    { key: "all" as const, label: "全部", count: counts.all },
    { key: "missing" as const, label: "缺集中", count: counts.missing },
    { key: "pending" as const, label: "今日更新", count: counts.pending },
    { key: "complete" as const, label: "已齐", count: counts.complete },
  ];
});

/**
 * 媒体库筛选：按"这条任务的已存出现在这个库里"过滤。
 *
 * 同一部作品可能同时存在于多个库（例如「动漫」和「剧集」各有一份），所以不能把任务归属到单一库。
 */
const libraryFilter = ref<string>("all");
const libraryTabs = computed(() => {
  const counts = new Map<string, { id: string; name: string; count: number }>();
  for (const row of rows.value) {
    for (const library of row.libraries) {
      const entry = counts.get(library.rootId) ?? { id: library.rootId, name: library.name, count: 0 };
      entry.count += 1;
      counts.set(library.rootId, entry);
    }
  }
  return [...counts.values()].sort((left, right) => left.name.localeCompare(right.name, "zh-Hans-CN"));
});

const visibleRows = computed(() =>
  rows.value.filter(
    (row) =>
      (statusFilter.value === "all" || row.statusKey === statusFilter.value) &&
      (libraryFilter.value === "all" || row.libraries.some((library) => library.rootId === libraryFilter.value)),
  ),
);

/** 季号对不上、被排除在合计之外的季（例：TMDB 拆了 S1–S4，Emby 只有一个 S5 年番）。 */
function unmatchedText(seasons: { seasonNumber: number; airedEpisodes: number }[]): string {
  if (!seasons.length) return "";
  const numbers = seasons.map((season) => `S${String(season.seasonNumber).padStart(2, "0")}`).join("、");
  const aired = seasons.reduce((sum, season) => sum + season.airedEpisodes, 0);
  return `${numbers} 库内无对应季号（共 ${aired} 集），未计入`;
}

const sorted = computed(() => {
  const list = [...visibleRows.value];
  const direction = sortAsc.value ? 1 : -1;
  list.sort((left, right) => {
    switch (sortKey.value) {
      case "aired":
        return ((left.aired ?? 0) - (right.aired ?? 0)) * direction;
      case "stored":
        return ((left.stored ?? 0) - (right.stored ?? 0)) * direction;
      case "missing":
        return (left.missing - right.missing) * direction;
      case "checked":
        return (
          ((Date.parse(left.task.lastCheckedAt ?? "") || 0) - (Date.parse(right.task.lastCheckedAt ?? "") || 0)) *
          direction
        );
      default:
        return left.task.title.localeCompare(right.task.title, "zh-Hans-CN") * direction;
    }
  });
  return list;
});

function toggleSort(key: SortKey) {
  if (sortKey.value === key) sortAsc.value = !sortAsc.value;
  else {
    sortKey.value = key;
    sortAsc.value = true;
  }
}

function toggleRow(id: number) {
  const next = new Set(expanded.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  expanded.value = next;
}

function seasonLabel(season: TaskSeasonRow): string {
  return season.seasonNumber === 0 ? "整剧 / 特别篇" : `第 ${season.seasonNumber} 季`;
}

/** 缺哪几集：E06、E07（超过 8 个折叠成区间，避免撑爆一行）。 */
function episodeList(episodes: number[]): string {
  const format = (episode: number) => `E${String(episode).padStart(2, "0")}`;
  if (episodes.length === 0) return "—";
  if (episodes.length > 8)
    return `${format(episodes[0]!)} – ${format(episodes[episodes.length - 1]!)}（共 ${episodes.length} 集）`;
  return episodes.map(format).join("、");
}

function seasonCount(row: { seasons: TaskSeasonRow[] }): string {
  return row.seasons.length ? `${row.seasons.length} 季` : "整剧";
}

/** 任务级媒体库胶囊里的数字：剧集说集数；电影没有逐集明细，只说"已入库"。 */
function libraryCountText(library: TaskLibrarySource, mediaType: Task["mediaType"]): string {
  if (mediaType === "movie") return library.fileCount > 0 ? "已入库" : "无片源";
  return `${library.episodeCount} 集`;
}

/** 分季媒体库胶囊：分季只出现在剧集任务里，直接说集数。 */
function seasonLibraryCountText(library: TaskSeasonLibrary): string {
  return `${library.episodeCount} 集`;
}

/** 悬停提示：把库名与库内目录一起给出，方便直接去 Emby 里定位。 */
function libraryTitle(library: TaskLibrarySource | TaskSeasonLibrary): string {
  return library.path ? `媒体库：${library.name} · 库内目录：${library.path}` : `媒体库：${library.name}`;
}

/** 一行文案（移动卡片用）：库名 + 该库里的数量。 */
function libraryLine(list: TaskLibrarySource[], mediaType: Task["mediaType"]): string {
  if (!list.length) return "未入库";
  return list.map((library) => `${library.name} ${libraryCountText(library, mediaType)}`).join(" · ");
}

/** 季卡片的一行：库归属 + 该季在库内的目录。 */
function seasonLibraryLine(season: TaskSeasonRow): string {
  const list = season.libraries ?? [];
  if (!list.length) return "未入库";
  const first = list[0];
  const folders = list.map((library) => `${library.name} ${seasonLibraryCountText(library)}`).join(" · ");
  return `${folders}${first?.path ? `（${first.path}）` : ""}`;
}

/** 分季明细里的库内目录（没有目录时说明作品直接放在库根下）。 */
function seasonLibraryPath(season: TaskSeasonRow): string {
  return season.libraries?.[0]?.path || "库根";
}

function checkedText(value: string | null | undefined): string {
  if (!value) return "未检查";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "未检查";
  return date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

/**
 * 状态胶囊：缺集优先；没有真缺集但有「今日更新」时给中性色提示（不是缺集，也不是"已齐"）。
 *
 * 「今日更新」= 已播出、但还在入库宽限期内的集（默认次日 0 点前）：当天 18 点更新、20 点入库是常态，
 * 白天按旧口径会看到假的缺集。宽限期见系统设置 library.missingGraceHours。
 */
function statusOf(missing: number, pending: number): { label: string; cls: string } {
  if (missing > 0) return { label: "缺集中", cls: "warn" };
  if (pending > 0) return { label: `今日更新 ${pending} 集`, cls: "info" };
  return { label: "已齐", cls: "ok" };
}

/** 「今日更新」的悬停说明：把集号与"为什么不算缺集"讲清楚。 */
function pendingTitle(episodes: number[] | undefined, count: number): string {
  const list = episodes?.length ? `：${episodeList(episodes)}` : "";
  return `今日更新 ${count} 集${list}（当天播出，还在入库宽限期内，暂不计缺集）`;
}

const {
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
} = useTaskBoardActions(props, tmdb, () => emit("refresh"));
</script>

<template>
  <section class="board">
    <header class="board-head">
      <div>
        <h2>任务看板</h2>
        <p>
          只监控不派活：TMDB 已播多少、Emby 库里存了多少（存在哪个库、库内哪个目录）、还缺哪几集；
          「今日更新」是当天播出、还在入库宽限期内的集，不算缺集（宽限期见系统设置）。
        </p>
      </div>
      <div class="board-actions">
        <button v-if="!isNarrow" type="button" class="primary create" @click="openCreate">
          <SvgIcon type="mdi" :path="mdiPlus" :size="16" />新建任务
        </button>
        <button type="button" class="refresh" aria-label="刷新" @click="emit('refresh')">
          <SvgIcon type="mdi" :path="mdiRefresh" :size="18" />
        </button>
      </div>
    </header>

    <div v-if="rows.length" class="status-tabs" role="tablist" aria-label="按状态筛选">
      <button
        v-for="item in statusTabs"
        :key="item.key"
        type="button"
        role="tab"
        :aria-selected="statusFilter === item.key"
        :class="['status-tab', { active: statusFilter === item.key }]"
        @click="statusFilter = item.key"
      >
        {{ item.label }}<b>{{ item.count }}</b>
      </button>
    </div>

    <div v-if="libraryTabs.length" class="status-tabs library-tabs" role="tablist" aria-label="按媒体库筛选">
      <button
        type="button"
        role="tab"
        :aria-selected="libraryFilter === 'all'"
        :class="['status-tab', { active: libraryFilter === 'all' }]"
        @click="libraryFilter = 'all'"
      >
        不限媒体库<b>{{ rows.length }}</b>
      </button>
      <button
        v-for="library in libraryTabs"
        :key="library.id"
        type="button"
        role="tab"
        :aria-selected="libraryFilter === library.id"
        :class="['status-tab', { active: libraryFilter === library.id }]"
        @click="libraryFilter = library.id"
      >
        {{ library.name }}<b>{{ library.count }}</b>
      </button>
    </div>

    <p v-if="actionMessage" class="action-msg" role="alert">{{ actionMessage }}</p>
    <p v-if="loading && !rows.length" class="empty" role="status">正在读取任务列表…</p>
    <p v-else-if="!rows.length" class="empty">还没有任务。点「新建任务」搜 TMDB 添加，系统会自动比对已播与库内集数。</p>
    <p v-else-if="!visibleRows.length" class="empty">当前筛选下没有剧集，换个状态看看。</p>

    <!-- 桌面：真表格，可排序、行内展开 -->
    <div v-else-if="!isNarrow" class="table-wrap">
      <table class="tracking-table">
        <caption class="sr-only">
          任务看板列表
        </caption>
        <thead>
          <tr>
            <th scope="col" :aria-sort="sortKey === 'title' ? (sortAsc ? 'ascending' : 'descending') : 'none'">
              <button type="button" @click="toggleSort('title')">剧名</button>
            </th>
            <th scope="col" :aria-sort="sortKey === 'aired' ? (sortAsc ? 'ascending' : 'descending') : 'none'">
              <button type="button" @click="toggleSort('aired')">TMDB 已播</button>
            </th>
            <th scope="col" :aria-sort="sortKey === 'stored' ? (sortAsc ? 'ascending' : 'descending') : 'none'">
              <button type="button" @click="toggleSort('stored')">库内已存</button>
            </th>
            <th scope="col">媒体库</th>
            <th scope="col" :aria-sort="sortKey === 'missing' ? (sortAsc ? 'ascending' : 'descending') : 'none'">
              <button type="button" @click="toggleSort('missing')">缺集</button>
            </th>
            <th scope="col" :aria-sort="sortKey === 'checked' ? (sortAsc ? 'ascending' : 'descending') : 'none'">
              <button type="button" @click="toggleSort('checked')">最后检查</button>
            </th>
            <th scope="col">状态</th>
            <th scope="col">操作</th>
          </tr>
        </thead>
        <tbody>
          <template v-for="row in sorted" :key="row.task.id">
            <tr class="task-row">
              <th scope="row">
                <button
                  type="button"
                  class="row-toggle"
                  :aria-expanded="expanded.has(row.task.id)"
                  @click="toggleRow(row.task.id)"
                >
                  <SvgIcon
                    type="mdi"
                    :path="mdiChevronDown"
                    :size="15"
                    :class="['chevron', { open: expanded.has(row.task.id) }]"
                    aria-hidden="true"
                  />
                  <img v-if="row.task.posterUrl" class="poster" :src="row.task.posterUrl" alt="" loading="lazy" />
                  <span v-else class="poster placeholder" aria-hidden="true">{{ row.task.title.slice(0, 1) }}</span>
                  <span class="title-cell">
                    <b>{{ row.task.title }}</b>
                    <small>{{ seasonCount(row) }}</small>
                    <small v-if="row.unmatched.length" class="unmatched">{{ unmatchedText(row.unmatched) }}</small>
                  </span>
                </button>
              </th>
              <td class="num">{{ row.aired ?? "—" }}</td>
              <td class="num">{{ row.stored ?? "—" }}</td>
              <td class="library-cell">
                <span v-if="!row.libraries.length" class="lib-empty">未入库</span>
                <span v-else class="lib-list">
                  <span
                    v-for="library in row.libraries"
                    :key="library.rootId"
                    class="lib-chip"
                    :title="libraryTitle(library)"
                  >
                    {{ library.name }}<b>{{ libraryCountText(library, row.task.mediaType) }}</b>
                  </span>
                  <small v-if="row.libraries[0]?.path" class="lib-path">{{ row.libraries[0]?.path }}</small>
                </span>
              </td>
              <td class="num" :class="{ warn: row.missing > 0 }">
                <span>{{ row.missing ? `缺 ${row.missing} 集` : "—" }}</span>
                <!-- 今日更新：当天播出、还在入库宽限期内，不算缺集（8 点看到的假缺集就是这个） -->
                <small v-if="row.pending" class="pending-hint" :title="pendingTitle(row.pendingEpisodes, row.pending)">
                  今日更新 {{ row.pending }} 集
                </small>
              </td>
              <td class="num dim">{{ checkedText(row.task.lastCheckedAt) }}</td>
              <td>
                <span class="pill" :class="row.status.cls">{{ row.status.label }}</span>
              </td>
              <td class="row-actions">
                <!-- 改绑 TMDB：匹配错了（同名剧/手滑）就换一条，改完已播与缺集立即按新条目重算 -->
                <button
                  type="button"
                  class="row-rebind"
                  :aria-label="`改绑 TMDB ${row.task.title}`"
                  @click="openRebind(row.task)"
                >
                  <SvgIcon type="mdi" :path="mdiSwapHorizontal" :size="14" aria-hidden="true" />改绑
                </button>
                <button
                  type="button"
                  class="row-delete"
                  :aria-label="`删除任务 ${row.task.title}`"
                  :disabled="deletingId !== null"
                  @click="removeTask(row.task)"
                >
                  <SvgIcon type="mdi" :path="mdiDeleteOutline" :size="14" aria-hidden="true" />删除
                </button>
              </td>
            </tr>
            <tr v-if="expanded.has(row.task.id)" class="season-row">
              <td colspan="8">
                <table class="season-table">
                  <thead>
                    <tr>
                      <th scope="col">季</th>
                      <th scope="col">已播</th>
                      <th scope="col">已存</th>
                      <th scope="col">媒体库（已存在哪个库 / 库内目录）</th>
                      <th scope="col">缺哪几集</th>
                      <th scope="col">最后检查</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="season in row.seasons" :key="season.seasonNumber">
                      <td>{{ seasonLabel(season) }}</td>
                      <td class="num">{{ season.airProgress ?? "—" }}</td>
                      <td class="num">{{ season.storedProgress ?? "—" }}</td>
                      <td class="library-cell">
                        <span v-if="!season.libraries?.length" class="dim">—</span>
                        <span v-else class="lib-list">
                          <span
                            v-for="library in season.libraries"
                            :key="library.rootId"
                            class="lib-chip"
                            :title="libraryTitle(library)"
                          >
                            {{ library.name }}<b>{{ seasonLibraryCountText(library) }}</b>
                          </span>
                          <small class="lib-path">{{ seasonLibraryPath(season) }}</small>
                        </span>
                      </td>
                      <td v-if="season.aligned === false" class="num dim">库内无此季号（未比对）</td>
                      <td v-else class="num" :class="{ warn: season.missingEpisodes.length > 0 }">
                        <span>{{ episodeList(season.missingEpisodes) }}</span>
                        <small
                          v-if="season.pendingEpisodes?.length"
                          class="pending-hint"
                          :title="pendingTitle(season.pendingEpisodes, season.pendingEpisodes.length)"
                        >
                          今日更新 {{ episodeList(season.pendingEpisodes) }}
                        </small>
                      </td>
                      <td class="num dim">{{ checkedText(season.lastCheckedAt) }}</td>
                    </tr>
                    <tr v-if="!row.seasons.length">
                      <td colspan="6" class="dim">还没有分季数据。</td>
                    </tr>
                  </tbody>
                </table>
              </td>
            </tr>
          </template>
        </tbody>
      </table>
    </div>

    <!-- 移动：卡片 + 手风琴 -->
    <ul v-else class="card-list">
      <li v-for="row in visibleRows" :key="row.task.id" class="track-card">
        <button
          type="button"
          class="card-head"
          :aria-expanded="expanded.has(row.task.id)"
          @click="toggleRow(row.task.id)"
        >
          <img v-if="row.task.posterUrl" class="poster" :src="row.task.posterUrl" alt="" loading="lazy" />
          <span v-else class="poster placeholder" aria-hidden="true">{{ row.task.title.slice(0, 1) }}</span>
          <span class="card-main">
            <b>{{ row.task.title }}</b>
            <small>已播 {{ row.aired ?? "—" }} · 已存 {{ row.stored ?? "—" }}</small>
            <small v-if="row.pending" class="pending-hint" :title="pendingTitle(row.pendingEpisodes, row.pending)">
              今日更新 {{ row.pending }} 集（宽限期内不计缺集）
            </small>
            <small class="card-libraries">库：{{ libraryLine(row.libraries, row.task.mediaType) }}</small>
            <small v-if="row.unmatched.length" class="unmatched">{{ unmatchedText(row.unmatched) }}</small>
          </span>
          <span class="pill" :class="row.status.cls">{{ row.status.label }}</span>
        </button>
        <div v-if="expanded.has(row.task.id)" class="accordion">
          <p class="accordion-meta">
            缺 <b :class="{ warn: row.missing > 0 }">{{ row.missing }}</b> 集
            <template v-if="row.pending">
              · 今日更新 <b>{{ row.pending }}</b> 集（宽限期内不计缺集）
            </template>
            · 最后检查 {{ checkedText(row.task.lastCheckedAt) }}
          </p>
          <div v-for="season in row.seasons" :key="season.seasonNumber" class="season-card">
            <div class="season-top">
              <b>{{ seasonLabel(season) }}</b>
              <span>已播 {{ season.airProgress ?? "—" }} · 已存 {{ season.storedProgress ?? "—" }}</span>
            </div>
            <p class="season-library">库：{{ seasonLibraryLine(season) }}</p>
            <p v-if="season.aligned === false" class="season-missing dim">库内无此季号（未比对）</p>
            <template v-else>
              <p class="season-missing" :class="{ warn: season.missingEpisodes.length > 0 }">
                缺：{{ episodeList(season.missingEpisodes) }}
              </p>
              <p v-if="season.pendingEpisodes?.length" class="season-missing pending-hint">
                今日更新：{{ episodeList(season.pendingEpisodes) }}（当天播出，宽限期内不计缺集）
              </p>
            </template>
          </div>
          <p v-if="!row.seasons.length" class="dim">还没有分季数据。</p>
          <button type="button" class="card-rebind" @click="openRebind(row.task)">
            <SvgIcon type="mdi" :path="mdiSwapHorizontal" :size="15" aria-hidden="true" />
            改绑 TMDB 条目
          </button>
          <button type="button" class="card-delete" :disabled="deletingId !== null" @click="removeTask(row.task)">
            <SvgIcon type="mdi" :path="mdiDeleteOutline" :size="15" aria-hidden="true" />
            {{ deletingId === row.task.id ? "删除中…" : "删除这条任务" }}
          </button>
        </div>
      </li>
    </ul>

    <!-- 移动端创建入口：悬浮按钮 + 全屏抽屉 -->
    <button v-if="isNarrow" type="button" class="fab" aria-label="新建任务" @click="openCreate">
      <SvgIcon type="mdi" :path="mdiPlus" :size="26" />
    </button>

    <Teleport to="body">
      <div v-if="drawerOpen" class="drawer-mask" @click.self="drawerOpen = false">
        <section
          class="drawer"
          role="dialog"
          aria-modal="true"
          :aria-label="drawerMode === 'rebind' ? '改绑 TMDB' : '新建任务'"
        >
          <header class="drawer-head">
            <b>{{ drawerMode === "rebind" ? "改绑 TMDB" : "新建任务" }}</b>
            <button type="button" class="drawer-close" aria-label="关闭" @click="drawerOpen = false">×</button>
          </header>
          <form class="drawer-search" role="search" @submit.prevent="search">
            <SvgIcon type="mdi" :path="mdiMagnify" :size="17" aria-hidden="true" />
            <input v-model="query" type="search" enterkeyhint="search" placeholder="输入剧名或片名搜索 TMDB" />
            <button type="submit" class="primary" :disabled="searching || !query.trim()">
              {{ searching ? "搜索中…" : "搜索" }}
            </button>
          </form>
          <p v-if="drawerMode === 'rebind' && rebindTarget" class="rebind-current">
            当前：<b>{{ rebindTarget.title }}</b
            >（TMDB {{ rebindTarget.tmdbId ?? "—" }} · {{ rebindTarget.mediaType === "movie" ? "电影" : "剧集" }}）
          </p>
          <p v-if="drawerMessage" class="drawer-msg" role="status">{{ drawerMessage }}</p>
          <ul class="hit-list">
            <li v-for="hit in results" :key="hit.id">
              <button
                type="button"
                class="hit"
                :disabled="creating || rebinding"
                @click="drawerMode === 'rebind' ? pickCandidate(hit) : create(hit)"
              >
                <img v-if="hit.posterUrl" class="poster" :src="hit.posterUrl" alt="" loading="lazy" />
                <span v-else class="poster placeholder" aria-hidden="true">
                  <SvgIcon
                    type="mdi"
                    :path="hit.mediaType === 'movie' ? mdiMovieOpenOutline : mdiTelevisionClassic"
                    :size="20"
                  />
                </span>
                <span class="hit-main">
                  <b>{{ hit.title }}</b>
                  <small
                    >{{ hit.mediaType === "movie" ? "电影" : "剧集" }} · {{ hit.releaseYear ?? "—"
                    }}{{ hit.originalTitle ? " · " + hit.originalTitle : "" }}</small
                  >
                </span>
                <span class="hit-action">{{
                  drawerMode === "rebind" ? "选这条 →" : creating ? "创建中…" : "新建任务 →"
                }}</span>
              </button>
            </li>
          </ul>
          <!-- 改绑模式：手填 ID + 确认区（点搜索结果只是"选中"，真正落库要再点确认） -->
          <template v-if="drawerMode === 'rebind'">
            <section class="manual-pick">
              <h3>搜不到？直接填 TMDB ID</h3>
              <div class="manual-row">
                <label>
                  TMDB ID
                  <input v-model="manualId" type="number" min="1" inputmode="numeric" placeholder="例如 70523" />
                </label>
                <label>
                  类型
                  <select v-model="manualType">
                    <option value="tv">剧集</option>
                    <option value="movie">电影</option>
                  </select>
                </label>
                <label>
                  标题（TMDB 查不到时兜底）
                  <input v-model="manualTitle" type="text" maxlength="200" placeholder="可留空" />
                </label>
              </div>
              <button type="button" class="manual-use" @click="pickManual">用这个 ID</button>
            </section>
            <p v-if="pendingPick" class="pick-preview" role="status">
              将改绑为：<b>{{ pendingPick.title || "（按 TMDB 取标题）" }}</b
              >（TMDB {{ pendingPick.tmdbId }} · {{ pendingPick.mediaType === "movie" ? "电影" : "剧集" }}）
            </p>
            <p class="drawer-tip">
              改绑后会按新条目重建分季与已播进度、重算缺集；目标条目已存在时合并到同一条（不会出现重复条目）。
              库内片源会在下次媒体库扫描时按 Emby 登记的标识重新对齐。
            </p>
            <button
              type="button"
              class="primary confirm-rebind"
              :disabled="!pendingPick || rebinding"
              @click="confirmRebind"
            >
              {{ rebinding ? "改绑中…" : "确认改绑" }}
            </button>
          </template>
          <p v-else class="drawer-tip">
            建成后进入待执行：把 TMDB 已播、Emby 库里还缺的集补齐（同一部剧重复添加会复用已有任务）。
          </p>
        </section>
      </div>
    </Teleport>
  </section>
</template>

<style scoped>
.board {
  padding: 22px;
  max-width: 1180px;
  margin: 0 auto;
}
.board-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 16px;
}
.board-actions {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.board-head h2 {
  margin: 0 0 6px;
  font-size: 23px;
  font-weight: 760;
  color: var(--text);
}
.board-head p {
  margin: 0;
  color: var(--text-dim);
  font-size: 13px;
}
button.create,
button.refresh {
  min-height: 44px;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 0 15px;
  border: 1px solid var(--line-strong);
  border-radius: 9px;
  color: var(--text);
  background: var(--surface-hi);
  cursor: pointer;
  font-size: 13px;
}
button.create {
  border-color: #4d9b51;
  color: var(--accent-ink);
  background: var(--accent);
  font-weight: 700;
}
.empty {
  padding: 30px 18px;
  border: 1px solid var(--line);
  border-radius: var(--radius-lg);
  color: var(--text-dim);
  background: var(--surface);
  font-size: 13px;
  text-align: center;
}
.status-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 12px;
}
.status-tab {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  min-height: 36px;
  padding: 0 13px;
  border: 1px solid var(--line);
  border-radius: var(--radius-pill);
  color: var(--text-dim);
  background: var(--surface);
  cursor: pointer;
  font-size: 12.5px;
}
.status-tab b {
  color: var(--text-faint);
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
}
/* 触控目标：窄屏下筛选按钮同样不小于 44px */
@media (max-width: 900px) {
  .status-tab {
    min-height: 44px;
    padding: 0 16px;
    font-size: 13.5px;
  }
}
.status-tab.active {
  border-color: var(--line-strong);
  color: var(--text);
  background: var(--surface-hi);
}
.status-tab.active b {
  color: var(--text);
}
.table-wrap {
  overflow: auto;
  border: 1px solid var(--line);
  border-radius: var(--radius-lg);
  background: var(--surface);
}
.tracking-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
  min-width: 940px;
}
.tracking-table thead th {
  position: sticky;
  top: 0;
  z-index: 2;
  padding: 10px 12px;
  border-bottom: 1px solid var(--line);
  background: var(--surface-hi);
  color: var(--text-dim);
  font-size: 11px;
  font-weight: 700;
  text-align: left;
  white-space: nowrap;
}
.tracking-table thead th button {
  border: 0;
  padding: 0;
  color: inherit;
  background: none;
  cursor: pointer;
  font: inherit;
}
.tracking-table thead th button::after {
  content: "⇅";
  margin-left: 5px;
  opacity: 0.45;
  font-size: 10px;
}
.tracking-table td,
.tracking-table tbody th {
  padding: 10px 12px;
  border-bottom: 1px solid var(--line);
  vertical-align: middle;
  text-align: left;
  font-weight: 400;
}
.tracking-table tbody tr:hover {
  background: rgb(255 255 255 / 2%);
}
.num {
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.dim {
  color: var(--text-faint);
}
.warn {
  color: var(--warn);
}
.row-toggle {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-height: 44px;
  padding: 0;
  border: 0;
  color: inherit;
  background: none;
  cursor: pointer;
  text-align: left;
}
.chevron {
  flex: none;
  color: var(--text-faint);
  transition: transform 0.18s var(--ease);
}
.chevron.open {
  transform: rotate(180deg);
}
.poster {
  flex: none;
  width: 40px;
  height: 40px;
  border-radius: 7px;
  object-fit: cover;
  background: #0d1921;
}
.poster.placeholder {
  display: grid;
  place-items: center;
  color: #33505f;
  font-size: 16px;
}
.title-cell {
  display: grid;
  gap: 2px;
  min-width: 0;
}
.title-cell b {
  color: var(--text);
  font-size: 14px;
}
.title-cell small {
  color: var(--text-faint);
  font-size: 11px;
}
.unmatched {
  color: var(--warn);
}
.pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border-radius: var(--radius-pill);
  font-size: 11px;
  font-weight: 700;
  white-space: nowrap;
}
.pill.ok {
  color: #7fd08a;
  background: #14301c;
}
.pill.warn {
  color: #e6c06a;
  background: #2a2210;
}
/* 「今日更新」：不是缺集、也不是"已齐"，用中性蓝提示 */
.pill.info {
  color: #9cc1f2;
  background: #16283c;
}
/* 缺集列表下方的「今日更新」小字：等宽数字 + 弱化色，不抢缺集的注意力 */
.pending-hint {
  display: block;
  margin-top: 3px;
  color: #9cc1f2;
  font-size: 11px;
  font-weight: 500;
  white-space: normal;
}
.pill.done {
  color: var(--text-dim);
  background: var(--surface-hi);
}
/* 行内删除：桌面是次要操作，做小而克制；移动端（触控）走 .card-delete 的 44px。 */
.row-delete {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-height: 32px;
  padding: 0 10px;
  border: 1px solid var(--line-strong);
  border-radius: 8px;
  color: var(--text-dim);
  background: transparent;
  cursor: pointer;
  font-size: 12px;
  white-space: nowrap;
}
.row-delete:hover:not(:disabled) {
  border-color: #7a3f3f;
  color: #ef8585;
}
.row-delete:disabled {
  opacity: 0.5;
  cursor: default;
}
/* 操作列：改绑是"修复类"次要操作，用中性蓝，不与删除的红色抢注意力 */
.row-actions {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
}
.row-rebind {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-height: 32px;
  padding: 0 10px;
  border: 1px solid var(--line-strong);
  border-radius: 8px;
  color: #9cc1f2;
  background: transparent;
  cursor: pointer;
  font-size: 12px;
  white-space: nowrap;
}
.row-rebind:hover {
  border-color: #3f6a9b;
  background: rgb(28 58 92 / 26%);
}
/* 移动端：改绑与删除同为整宽 44px 触控按钮 */
.card-rebind {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  width: 100%;
  min-height: 44px;
  margin-top: 4px;
  border: 1px solid var(--line-strong);
  border-radius: 10px;
  color: #9cc1f2;
  background: rgb(28 58 92 / 22%);
  cursor: pointer;
  font-size: 13px;
  font-weight: 650;
}
/* 抽屉（改绑模式）：当前身份 / 手填 ID / 选中预览 / 确认 */
.rebind-current {
  margin: 12px 0 0;
  padding: 10px 12px;
  border: 1px solid var(--line);
  border-radius: 10px;
  color: var(--text-dim);
  background: var(--bg-raised);
  font-size: 12.5px;
}
.rebind-current b {
  color: var(--text);
}
.manual-pick {
  margin-top: 16px;
  padding-top: 14px;
  border-top: 1px solid var(--line);
}
.manual-pick h3 {
  margin: 0 0 10px;
  color: var(--text-dim);
  font-size: 12.5px;
  font-weight: 700;
}
.manual-row {
  display: grid;
  gap: 8px;
}
.manual-row label {
  display: grid;
  gap: 4px;
  color: var(--text-dim);
  font-size: 12px;
}
.manual-row input,
.manual-row select {
  min-height: 44px;
  padding: 0 10px;
  border: 1px solid var(--line-strong);
  border-radius: 9px;
  color: var(--text);
  background: var(--input);
  font-size: 14px;
}
.manual-use {
  min-height: 40px;
  margin-top: 10px;
  padding: 0 14px;
  border: 1px solid var(--line-strong);
  border-radius: 9px;
  color: var(--text);
  background: var(--surface-hi);
  cursor: pointer;
  font-size: 13px;
}
.pick-preview {
  margin: 12px 0 0;
  padding: 10px 12px;
  border: 1px solid #3f6a9b;
  border-radius: 10px;
  color: var(--text);
  background: rgb(28 58 92 / 26%);
  font-size: 13px;
}
.pick-preview b {
  color: #9cc1f2;
}
.confirm-rebind {
  width: 100%;
  min-height: 46px;
  margin-top: 10px;
  border: 1px solid #4d9b51;
  border-radius: 10px;
  color: var(--accent-ink);
  background: var(--accent);
  cursor: pointer;
  font-size: 14px;
  font-weight: 700;
}
.confirm-rebind:disabled {
  opacity: 0.55;
  cursor: default;
}
.action-msg {
  margin: 0 0 12px;
  padding: 10px 12px;
  border: 1px solid #6a3a3a;
  border-radius: 10px;
  color: #ef8585;
  background: #221111;
  font-size: 13px;
}
.season-row > td {
  padding: 0 12px 12px;
  background: rgb(255 255 255 / 1.5%);
}
.season-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}
.season-table th,
.season-table td {
  padding: 8px 10px;
  border-bottom: 1px solid var(--line);
  text-align: left;
  font-weight: 400;
  color: var(--text-dim);
}
.season-table th {
  color: var(--text-faint);
  font-size: 11px;
}

/* 移动形态：卡片 + 手风琴 */
.card-list {
  list-style: none;
  margin: 0;
  padding: 0 0 84px;
  display: grid;
  gap: 10px;
}
.track-card {
  border: 1px solid var(--line);
  border-radius: var(--radius-lg);
  background: var(--surface);
  overflow: hidden;
}
.card-head {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  min-height: 64px;
  padding: 12px 14px;
  border: 0;
  color: inherit;
  background: none;
  cursor: pointer;
  text-align: left;
}
.card-main {
  display: grid;
  gap: 3px;
  min-width: 0;
  flex: 1;
}
.card-main b {
  color: var(--text);
  font-size: 15px;
}
.card-main small {
  color: var(--text-dim);
  font-size: 12px;
}
.accordion {
  display: grid;
  gap: 10px;
  padding: 0 14px 14px;
}
.accordion-meta {
  margin: 0;
  color: var(--text-dim);
  font-size: 12px;
}
.season-card {
  padding: 10px 12px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--bg-raised);
}
.season-top {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  font-size: 12px;
  color: var(--text-dim);
}
.season-top b {
  color: var(--text);
  font-size: 13px;
}
.season-missing {
  margin: 6px 0 0;
  color: var(--text-dim);
  font-size: 12px;
  word-break: break-word;
}
.card-delete {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  width: 100%;
  min-height: 44px;
  margin-top: 4px;
  border: 1px solid #6a3a3a;
  border-radius: 10px;
  color: #ef8585;
  background: rgb(80 24 24 / 26%);
  cursor: pointer;
  font-size: 13px;
  font-weight: 650;
}
.card-delete:disabled {
  opacity: 0.6;
  cursor: default;
}
.fab {
  position: fixed;
  right: 18px;
  bottom: 84px;
  z-index: 40;
  width: 56px;
  height: 56px;
  display: grid;
  place-items: center;
  border: 0;
  border-radius: 50%;
  color: var(--accent-ink);
  background: var(--accent);
  box-shadow: 0 10px 26px rgb(0 0 0 / 45%);
  cursor: pointer;
}

/* 全屏抽屉（移动端新建任务） */
.drawer-mask {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: flex;
  justify-content: center;
  align-items: flex-end;
  background: rgb(4 10 14 / 72%);
}
.drawer {
  width: 100%;
  max-width: 560px;
  max-height: 92vh;
  overflow: auto;
  padding: 18px;
  border-radius: 16px 16px 0 0;
  background: var(--surface);
}
.drawer-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 14px;
}
.drawer-head b {
  color: var(--text);
  font-size: 17px;
}
.drawer-close {
  width: 44px;
  height: 44px;
  border: 0;
  border-radius: 9px;
  color: var(--text-dim);
  background: var(--surface-hi);
  cursor: pointer;
  font-size: 20px;
}
.drawer-search {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 10px;
  border: 1px solid var(--line-strong);
  border-radius: 10px;
  background: var(--input);
}
.drawer-search input {
  flex: 1;
  min-height: 46px;
  border: 0;
  color: var(--text);
  background: none;
  font-size: 15px;
}
.drawer-search input:focus {
  outline: none;
}
.drawer-search button {
  min-height: 36px;
  padding: 0 14px;
  border: 1px solid #4d9b51;
  border-radius: 8px;
  color: var(--accent-ink);
  background: var(--accent);
  font-weight: 700;
  cursor: pointer;
}
.drawer-search button:disabled {
  opacity: 0.55;
  cursor: default;
}
.drawer-msg {
  margin: 12px 0 0;
  color: var(--warn);
  font-size: 13px;
}
.hit-list {
  list-style: none;
  margin: 14px 0 0;
  padding: 0;
  display: grid;
  gap: 8px;
}
.hit {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  min-height: 56px;
  padding: 10px 12px;
  border: 1px solid var(--line);
  border-radius: 12px;
  color: inherit;
  background: var(--bg-raised);
  cursor: pointer;
  text-align: left;
}
.hit:disabled {
  opacity: 0.6;
}
.hit-main {
  display: grid;
  gap: 3px;
  min-width: 0;
  flex: 1;
}
.hit-main b {
  color: var(--text);
  font-size: 14px;
}
.hit-main small {
  color: var(--text-dim);
  font-size: 11px;
}
.hit-action {
  flex: none;
  color: #9cc1f2;
  font-size: 12px;
  font-weight: 700;
}
.drawer-tip {
  margin: 16px 0 0;
  color: var(--text-faint);
  font-size: 12px;
  line-height: 1.6;
}
/* 媒体库归属：胶囊显示"库名 + 该库里的数量"，库内目录另起一行，方便直接去 Emby 定位。 */
.library-cell {
  max-width: 260px;
}
/* 空态"未入库"：用 text-dim 而不是 text-faint，视觉复核时 text-faint 的对比度约 3.4:1 偏低。 */
.lib-empty {
  color: var(--text-dim);
}
.lib-list {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.lib-chip {
  display: inline-flex;
  align-items: baseline;
  gap: 5px;
  padding: 3px 9px;
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-pill);
  color: var(--text);
  background: var(--surface-hi);
  font-size: 11.5px;
  white-space: nowrap;
}
.lib-chip b {
  color: #9cc1f2;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.lib-path {
  flex-basis: 100%;
  /* 库内目录是"定位用"的次要信息，但 10.5px 下 --text-faint 只有约 3.2:1，
     视觉复核判定偏暗；提到 --text-dim（约 6.7:1）仍然明显弱于胶囊本身。 */
  color: var(--text-dim);
  font-size: 10.5px;
  word-break: break-all;
}
.library-tabs {
  margin-top: -4px;
}
.season-library {
  margin: 6px 0 0;
  color: var(--text-dim);
  font-size: 12px;
  word-break: break-word;
}
.card-libraries {
  color: var(--text-dim);
}
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}
</style>
