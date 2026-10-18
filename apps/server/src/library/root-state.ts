import { eq } from "drizzle-orm";
import type { AppDatabase } from "@emby-task-center/database/client";
import { mediaRoots } from "@emby-task-center/database/schema";
import type { RootSyncPlan } from "./emby-roots";
import type { LibraryRootConfig, LibraryInventoryItem } from "./service";
/** 把计划应用到内存列表：新增追加、更新替换、删除移除，保持原有顺序稳定。 */
export function applyRootPlan(
  current: readonly LibraryRootConfig[],
  incoming: readonly LibraryRootConfig[],
  plan: RootSyncPlan,
): LibraryRootConfig[] {
  const byId = new Map(incoming.map((root) => [root.id, root]));
  const kept = current.filter((root) => !plan.removed.includes(root.id)).map((root) => byId.get(root.id) ?? root);
  const keptIds = new Set(kept.map((root) => root.id));
  const appended = incoming.filter((root) => plan.added.some((added) => added.id === root.id) && !keptIds.has(root.id));
  const removedSet = new Set(plan.removed);
  // 顺序：原顺序中保留下来的 + 新出现的（都按 Emby 返回顺序，来源侧已排序）
  const ordered = [...kept];
  for (const root of appended) ordered.push(root);
  return ordered.filter((root) => !removedSet.has(root.id));
}

/** Emby 已不存在的库根：置 enabled=false，保留行以便回看历史扫描记录。 */
export function disableMissingRoots(database: AppDatabase, activePaths: ReadonlySet<string>): void {
  const rows = database.select().from(mediaRoots).all();
  const timestamp = new Date().toISOString();
  for (const row of rows) {
    if (activePaths.has(row.containerPath) || !row.enabled) continue;
    database.update(mediaRoots).set({ enabled: false, updatedAt: timestamp }).where(eq(mediaRoots.id, row.id)).run();
  }
}

export function isSameMedia(candidate: LibraryInventoryItem, selected: LibraryInventoryItem): boolean {
  if (selected.mediaItemId !== null && selected.mediaItemId !== undefined) {
    return candidate.mediaItemId === selected.mediaItemId;
  }
  return candidate.sourceTitle === selected.sourceTitle && candidate.sourceYear === selected.sourceYear;
}

export function synchronizeRoots(database: AppDatabase, roots: readonly LibraryRootConfig[]): void {
  const timestamp = new Date().toISOString();
  for (const root of roots) {
    const existing = database.select().from(mediaRoots).where(eq(mediaRoots.name, root.name)).get();
    if (existing && existing.containerPath !== root.path) {
      // Same name with a different path: update the persisted row so the unique
      // name constraint is not violated when the admin changes a root location.
      database
        .update(mediaRoots)
        .set({
          containerPath: root.path,
          mediaType: root.mediaType,
          enabled: true,
          updatedAt: timestamp,
        })
        .where(eq(mediaRoots.id, existing.id))
        .run();
      continue;
    }
    database
      .insert(mediaRoots)
      .values({
        name: root.name,
        mediaType: root.mediaType,
        containerPath: root.path,
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .onConflictDoUpdate({
        target: mediaRoots.containerPath,
        set: { name: root.name, mediaType: root.mediaType, enabled: true, updatedAt: timestamp },
      })
      .run();
  }
}
