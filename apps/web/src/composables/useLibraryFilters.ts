import { computed, ref, type ComputedRef, type Ref } from "vue";

import { EMPTY_LIBRARY_FILTERS, countActiveFilters, type LibraryFilterValues } from "../library/filters";
import type { FilterOption, LibraryItem, LibraryScan } from "../types";

export const SORT_FILTER_OPTIONS: FilterOption[] = [
  { value: "latest", label: "最近入库" },
  { value: "title", label: "按片名" },
  { value: "year", label: "按年份" },
];

/** 类型筛选：与其它组一致的胶囊按钮（全部 + 电影 + 剧集）。 */
export const TYPE_FILTER_OPTIONS: FilterOption[] = [
  { value: "movie", label: "电影" },
  { value: "tv", label: "剧集" },
];

/** 状态筛选：只看已匹配 / 只看未匹配。 */
export const STATUS_FILTER_OPTIONS: FilterOption[] = [
  { value: "matched", label: "已匹配" },
  { value: "unresolved", label: "未匹配" },
];

export interface UseLibraryFiltersOptions {
  /** 全部扫描结果（用于派生年份/类型等动态选项）。 */
  scans: ComputedRef<Record<string, LibraryScan | undefined>>;
  resolutionOptions: readonly string[];
  codecOptions: readonly string[];
  genreOptions: ComputedRef<string[]>;
  yearOptions: ComputedRef<number[]>;
}

/**
 * 媒体库的筛选状态（P4：从 LibraryView.vue 抽出）。
 * 输入是各筛选 ref，输出是可直接绑定到 FilterChipRow 的选项与"已启用 N 项"。
 */
export function useLibraryFilters(options: UseLibraryFiltersOptions) {
  const type = ref<LibraryFilterValues["type"]>("all");
  const status = ref<LibraryFilterValues["status"]>("all");
  const resolution = ref("all");
  const codec = ref("all");
  const genre = ref("all");
  const year = ref("all");
  const sort = ref<LibraryFilterValues["sort"]>("title");
  const query = ref("");

  const resolutionFilterOptions = computed<FilterOption[]>(() =>
    options.resolutionOptions.map((value) => ({ value, label: value })),
  );
  const codecFilterOptions = computed<FilterOption[]>(() =>
    options.codecOptions.map((value) => ({ value, label: value })),
  );
  const genreFilterOptions = computed<FilterOption[]>(() =>
    options.genreOptions.value.map((value) => ({ value, label: value })),
  );
  const yearFilterOptions = computed<FilterOption[]>(() =>
    options.yearOptions.value.map((value) => ({ value: String(value), label: String(value) })),
  );

  /** 当前筛选值快照（给纯函数用）。 */
  const values = computed<LibraryFilterValues>(() => ({
    type: type.value,
    status: status.value,
    resolution: resolution.value,
    codec: codec.value,
    genre: genre.value,
    year: year.value,
    query: query.value,
    sort: sort.value,
  }));

  const activeFilterCount = computed(() => countActiveFilters(values.value));
  const hasActiveFilters = computed(() => activeFilterCount.value > 0);

  function clear(): void {
    type.value = EMPTY_LIBRARY_FILTERS.type;
    status.value = EMPTY_LIBRARY_FILTERS.status;
    resolution.value = EMPTY_LIBRARY_FILTERS.resolution;
    codec.value = EMPTY_LIBRARY_FILTERS.codec;
    genre.value = EMPTY_LIBRARY_FILTERS.genre;
    year.value = EMPTY_LIBRARY_FILTERS.year;
    query.value = EMPTY_LIBRARY_FILTERS.query;
  }

  return {
    type,
    status,
    resolution,
    codec,
    genre,
    year,
    sort,
    query,
    values,
    resolutionFilterOptions,
    codecFilterOptions,
    genreFilterOptions,
    yearFilterOptions,
    sortFilterOptions: SORT_FILTER_OPTIONS,
    typeFilterOptions: TYPE_FILTER_OPTIONS,
    statusFilterOptions: STATUS_FILTER_OPTIONS,
    activeFilterCount,
    hasActiveFilters,
    clear,
  };
}

/** 供 UI 复用的扫描结果类型别名。 */
export type LibraryScanMap = Record<string, LibraryScan | undefined>;
export type { LibraryItem, Ref };
