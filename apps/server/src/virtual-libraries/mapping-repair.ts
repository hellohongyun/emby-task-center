import {
  normalizeVirtualLibraryTmdbId,
  type VirtualLibraryItem,
  type VirtualLibraryMappingIssue,
} from "@emby-task-center/contracts/virtual-library";
import type { VirtualLibraryStore } from "./store";

export interface MappingSource {
  lookupItems(ids: string[]): Promise<VirtualLibraryItem[]>;
  findByTmdb(type: string, tmdbId: string): Promise<VirtualLibraryItem[]>;
}

/** Repair only a proven work identity; never infer a replacement from a title. */
export async function repairVirtualMappings(store: VirtualLibraryStore, libraryId: string, source: MappingSource) {
  const deadline = Date.now() + 10_000;
  async function checkedWithinDeadline<T>(query: () => Promise<T>): Promise<T> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("关联检查超时");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        query(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("关联检查超时")), remaining);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  const before = store.listItems(libraryId);
  const issues: VirtualLibraryMappingIssue[] = [];
  const issue = (item: VirtualLibraryItem, reason: VirtualLibraryMappingIssue["reason"], text: string) =>
    issues.push({ itemId: item.itemId, reason, message: `《${item.name}》：${text}` });
  if (!before.length) return { items: before, issues };
  let found: VirtualLibraryItem[];
  try {
    found = await checkedWithinDeadline(() => source.lookupItems(before.map((item) => item.itemId)));
  } catch {
    for (const item of before) issue(item, "unavailable", "暂时无法检查 Emby 关联，请稍后刷新重试。");
    const items = store.listItems(libraryId);
    return { items, issues: issues.filter((entry) => items.some((item) => item.itemId === entry.itemId)) };
  }
  const byId = new Map(found.map((item) => [item.itemId, item]));
  for (const item of before) {
    const tmdbId = normalizeVirtualLibraryTmdbId(item.tmdbId);
    const current = byId.get(item.itemId);
    const sameType = current?.type === item.type;
    if (current && sameType && (!tmdbId || normalizeVirtualLibraryTmdbId(current.tmdbId) === tmdbId)) {
      const refreshed = { ...current, year: current.year ?? item.year };
      if (JSON.stringify(refreshed) !== JSON.stringify(item))
        store.replaceItem(libraryId, item.itemId, refreshed, item);
      continue;
    }
    if (!tmdbId || !["Movie", "Series"].includes(item.type)) {
      issue(
        item,
        current ? "identity_mismatch" : "unidentified",
        current
          ? "原条目的类型已变化，无法确认作品，请从 Emby 重新选择。"
          : "原 Emby ID 已失效，缺少可验证的作品身份，请从 Emby 重新选择。",
      );
      continue;
    }
    try {
      const candidates = await checkedWithinDeadline(() => source.findByTmdb(item.type, tmdbId));
      const unique = new Map(
        candidates
          .filter(
            (candidate) => candidate.type === item.type && normalizeVirtualLibraryTmdbId(candidate.tmdbId) === tmdbId,
          )
          .map((candidate) => [candidate.itemId, candidate]),
      );
      if (unique.size === 1) {
        const replacement = [...unique.values()][0]!;
        const applied = store.replaceItem(
          libraryId,
          item.itemId,
          { ...replacement, year: replacement.year ?? item.year },
          item,
        );
        if (!applied && store.listItems(libraryId).some((entry) => entry.itemId === item.itemId))
          issue(item, "identity_mismatch", "关联在检查期间已变化，未覆盖现有记录，请刷新重试。");
      } else if (unique.size > 1) {
        issue(item, "ambiguous", "找到多个同 TMDB 的来源，未自动重新关联，请从 Emby 选择需要的条目。");
      } else {
        issue(item, "missing", "原关联已失效，当前未找到同类型、同 TMDB 的作品，请稍后刷新或重新选择。");
      }
    } catch {
      issue(item, "unavailable", "重新检查作品身份失败，已保留原关联，请稍后刷新重试。");
    }
  }
  const items = store.listItems(libraryId);
  const remaining = new Set(items.map((item) => item.itemId));
  return { items, issues: issues.filter((entry) => remaining.has(entry.itemId)) };
}
