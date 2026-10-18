/**
 * 媒体库筛选/排序（P4：从 LibraryView.vue 抽出，纯函数可单测）。
 *
 * 筛选条件集中在 LibraryFilterValues 里，`applyLibraryFilters` 负责过滤 + 排序，
 * `countActiveFilters` 负责"已启用 N 项"提示——UI 只负责绑定输入。
 */
import type { WorkGroup } from "../library/work-groups";

export type LibraryTypeFilter = "all" | "movie" | "tv";
export type LibraryStatusFilter = "all" | "matched" | "unresolved";
export type LibrarySortFilter = "latest" | "title" | "year";

export interface LibraryFilterValues {
  type: LibraryTypeFilter;
  status: LibraryStatusFilter;
  resolution: string;
  codec: string;
  genre: string;
  year: string;
  query: string;
  sort: LibrarySortFilter;
}

export const EMPTY_LIBRARY_FILTERS: LibraryFilterValues = {
  type: "all",
  status: "all",
  resolution: "all",
  codec: "all",
  genre: "all",
  year: "all",
  query: "",
  sort: "title",
};

/** 排序不算"筛选项"，query 算。 */
export function countActiveFilters(values: LibraryFilterValues): number {
  let count = 0;
  if (values.type !== "all") count += 1;
  if (values.status !== "all") count += 1;
  if (values.resolution !== "all") count += 1;
  if (values.codec !== "all") count += 1;
  if (values.genre !== "all") count += 1;
  if (values.year !== "all") count += 1;
  if (values.query.trim()) count += 1;
  return count;
}

function sortGroups(groups: WorkGroup[], sort: LibrarySortFilter): WorkGroup[] {
  if (sort === "year")
    return groups.sort((a, b) => (b.year ?? 0) - (a.year ?? 0) || a.title.localeCompare(b.title, "zh-CN"));
  if (sort === "latest") {
    // 曾经这里按片名倒序（标签写着"最近入库"但行为不符）；现在用真实入库时间。
    // 没有时间的作品排在最后，内部按片名稳定排序。
    return groups.sort((a, b) => {
      if (a.addedAt && b.addedAt) return b.addedAt.localeCompare(a.addedAt) || a.title.localeCompare(b.title, "zh-CN");
      if (a.addedAt) return -1;
      if (b.addedAt) return 1;
      return a.title.localeCompare(b.title, "zh-CN");
    });
  }
  return groups.sort((a, b) => a.title.localeCompare(b.title, "zh-CN"));
}

/** 按当前筛选条件过滤并排序（返回新数组引用，调用方不要依赖原数组顺序）。 */
export function applyLibraryFilters(groups: WorkGroup[], values: LibraryFilterValues): WorkGroup[] {
  const needle = values.query.trim().toLocaleLowerCase();
  const filtered = groups.filter((group) => {
    if (values.type === "movie" && group.isTv) return false;
    if (values.type === "tv" && !group.isTv) return false;
    const groupMatched = group.items.some((item) => item.recognitionStatus === "matched");
    if (values.status === "matched" && !groupMatched) return false;
    if (values.status === "unresolved" && groupMatched) return false;
    if (values.resolution !== "all" && !group.tags.includes(values.resolution)) return false;
    if (values.codec !== "all" && !group.tags.includes(values.codec)) return false;
    if (values.genre !== "all" && !group.genres.includes(values.genre)) return false;
    if (values.year !== "all" && group.year !== Number(values.year)) return false;
    if (needle && !group.title.toLocaleLowerCase().includes(needle)) return false;
    return true;
  });
  return sortGroups(filtered, values.sort);
}
