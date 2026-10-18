import { computed, ref, watch } from "vue";
import type {
  MissingEpisodesDeleteResult,
  MissingEpisodesPayload,
  MissingEpisodesSeason,
  MissingEpisodesShow,
} from "../types";
import { generatedText } from "./missing-episode-format";
export interface MissingViewProps {
  payload: MissingEpisodesPayload | null;
  loading?: boolean;
  selectedRootId?: string;
  deleting?: boolean;
  scanStarting?: boolean;
  error?: string;
  actionMessage?: string;
  deleteShows?: (mediaItemIds: number[], rootId: string) => Promise<MissingEpisodesDeleteResult | null>;
  triggerScan?: () => Promise<void>;
}
export interface MissingViewEmits {
  refresh: [];
  "select-library": [rootId: string];
}
export function useMissingEpisodesView(
  props: MissingViewProps,
  emit: (event: "select-library", rootId: string) => void,
) {
  /**
   * 缺集总览—— 逐集列出当前启用库中"TMDB 已播但库里没有"的集。
   *
   * 数据来自当前库库存与共享 TMDB 缓存的重算（不依赖任务中心建过任务）；集号/季号口径与任务看板一致：
   * 库内没有对应季号的季、编号体系疑似不一致的季都不臆造缺集，单独提示。
   * 这里只做展示、筛选与批量删除（删除调 Emby 接口）。
   */

  const search = ref("");
  const inventoryNotice = computed(() => {
    if (props.payload?.inventoryIssue === "scan_failed")
      return "当前媒体库库存同步失败，结果可能不完整。请在媒体库页面查看扫描状态并重试。";
    if (props.payload?.inventoryIssue === "not_scanned")
      return "当前媒体库尚未完成库存扫描，暂不能确认缺集。请先在媒体库页面刷新目录。";
    return "";
  });
  type SortKey = "missing" | "title";
  const sortKey = ref<SortKey>("missing");
  /** 媒体库筛选：必须落在某个库上看（没有「不限媒体库」）；默认选第一个库。 */
  const libraryFilter = ref("");
  /** 勾选待删除的剧（mediaItemId）。 */
  const selected = ref<Set<number>>(new Set());
  const confirmOpen = ref(false);
  const scopedLibraries = ref<MissingEpisodesPayload["libraries"]>();
  watch(
    () => props.payload?.libraries,
    (libraries) => {
      if (libraries) scopedLibraries.value = libraries;
    },
    { immediate: true },
  );

  /** 「在 Emby 查看」链接：`webBaseUrl` + item Id（+ serverId）；没配置 Emby 网页地址时返回 null。 */
  function embyItemUrl(itemId: string | null | undefined): string | null {
    const config = props.payload?.emby;
    if (!config?.webBaseUrl || !itemId) return null;
    const base = `${config.webBaseUrl.replace(/\/+$/, "")}/web/index.html#!/item?id=${encodeURIComponent(itemId)}`;
    return config.serverId ? `${base}&serverId=${encodeURIComponent(config.serverId)}` : base;
  }

  /**
   * 「今日更新」的集号文案：E12、E13（多季时带上季号，避免只看到集号不知道是哪一季）。
   *
   * 这些集已播出、但还在入库宽限期内（默认次日 0 点前），所以**不计缺集**：
   * 当天 18 点更新、20 点才入库，白天看到"缺集"是误报。
   */
  /** 带「在 Emby 查看」链接的展示季：链接按季条目 Id 拼，缺季 Id 时回落到剧集条目。 */
  type DisplaySeason = MissingEpisodesSeason & { embyUrl: string | null };
  type DisplayShow = Omit<MissingEpisodesShow, "seasons"> & { seasons: DisplaySeason[] };

  const shows = computed<DisplayShow[]>(() =>
    (props.payload?.shows ?? []).map((show) => ({
      ...show,
      seasons: show.seasons.map((season) => ({
        ...season,
        embyUrl: season.embyUrl ?? show.embyUrl ?? embyItemUrl(season.embySeasonId ?? show.embySeriesId),
      })),
    })),
  );
  const libraryTabs = computed(() => {
    if (scopedLibraries.value)
      return scopedLibraries.value.map((library) => ({
        id: library.rootId,
        name: library.name,
        count: undefined,
      }));
    const counts = new Map<string, { id: string; name: string; count: number }>();
    for (const show of shows.value) {
      for (const library of show.libraries) {
        const entry = counts.get(library.rootId) ?? { id: library.rootId, name: library.name, count: 0 };
        entry.count += 1;
        counts.set(library.rootId, entry);
      }
    }
    return [...counts.values()].sort((left, right) => left.name.localeCompare(right.name, "zh-Hans-CN"));
  });

  /** 选中的库：选过就在选中项里；刷新后库消失（或还没选）就回到第一个库。 */
  const activeLibrary = computed(
    () =>
      props.selectedRootId ??
      props.payload?.rootId ??
      (libraryTabs.value.some((tab) => tab.id === libraryFilter.value)
        ? libraryFilter.value
        : (libraryTabs.value[0]?.id ?? "")),
  );

  function selectLibrary(id: string) {
    if (props.deleting || id === activeLibrary.value) return;
    selected.value = new Set();
    confirmOpen.value = false;
    libraryFilter.value = id;
    if (scopedLibraries.value) emit("select-library", id);
  }

  const visibleShows = computed(() => {
    const keyword = search.value.trim().toLowerCase();
    const selectedLibrary = activeLibrary.value;
    const list = shows.value.filter(
      (show) =>
        (!keyword || show.title.toLowerCase().includes(keyword)) &&
        (!selectedLibrary || show.libraries.some((library) => library.rootId === selectedLibrary)),
    );
    return list.sort((left, right) =>
      sortKey.value === "title"
        ? left.title.localeCompare(right.title, "zh-Hans-CN")
        : right.missingCount - left.missingCount || left.title.localeCompare(right.title, "zh-Hans-CN"),
    );
  });

  const selectedShows = computed(() =>
    shows.value.filter((show) => show.missingCount > 0 && selected.value.has(show.mediaItemId)),
  );

  watch(activeLibrary, () => {
    selected.value = new Set();
    confirmOpen.value = false;
  });

  /** 列表刷新后，已经不存在的剧从勾选里去掉（例如刚被删除）。 */
  watch(
    () => props.payload,
    () => {
      const ids = new Set(shows.value.filter((show) => show.missingCount > 0).map((show) => show.mediaItemId));
      if ([...selected.value].some((id) => !ids.has(id))) {
        selected.value = new Set([...selected.value].filter((id) => ids.has(id)));
        if (!selected.value.size) confirmOpen.value = false;
      }
    },
  );

  /** 筛选后的空态文案：区分"搜不到"和"这个库下没有缺集"。 */
  const emptyHint = computed(() => {
    const keyword = search.value.trim();
    if (keyword) return `没有匹配「${keyword}」的剧。`;
    if (activeLibrary.value) return "这个媒体库下没有缺集。";
    return "没有符合条件的缺集。";
  });

  /** 头部状态：正在检测 → 进度；否则显示上次检测时间。 */
  const scanStateText = computed(() => {
    if (props.payload?.scanning) {
      const progress = props.payload.progress;
      return progress ? `检测中 ${progress.processed}/${progress.total}` : "检测中…";
    }
    if (props.payload?.lastScanAt) return `上次检测 ${generatedText(props.payload.lastScanAt)}`;
    return "还没检测过";
  });

  function toggleSelect(mediaItemId: number) {
    const next = new Set(selected.value);
    if (next.has(mediaItemId)) next.delete(mediaItemId);
    else next.add(mediaItemId);
    selected.value = next;
  }

  /** 全选当前筛选结果（而不是全部缺集，避免误删被筛选隐藏的剧）。 */
  function selectVisible() {
    const next = new Set(selected.value);
    // 只选真正有缺集的剧：仅"今日更新待入库"的剧缺 0 集，不在删除范围。
    for (const show of visibleShows.value) if (show.missingCount > 0) next.add(show.mediaItemId);
    selected.value = next;
  }

  function clearSelection() {
    selected.value = new Set();
  }

  async function confirmDelete() {
    const ids = selectedShows.value.map((show) => show.mediaItemId);
    if (!ids.length || !props.deleteShows) return;
    if (!activeLibrary.value) return;
    const result = await props.deleteShows(ids, activeLibrary.value);
    if (result) {
      selected.value = new Set();
      confirmOpen.value = false;
    }
  }

  return {
    search,
    inventoryNotice,
    sortKey,
    selectLibrary,
    selected,
    confirmOpen,
    embyItemUrl,
    shows,
    libraryTabs,
    activeLibrary,
    visibleShows,
    selectedShows,
    emptyHint,
    scanStateText,
    toggleSelect,
    selectVisible,
    clearSelection,
    confirmDelete,
  };
}
