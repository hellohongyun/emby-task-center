/**
 * Emby 媒体库 → 库根（media_roots）的实时映射（媒体库改造第 1 步）。
 *
 * 为什么不写死：Emby 侧的库会随时增删改名，所以库根必须由 Emby 现况推导。
 * 认库用 **Emby 的库 Id**（ItemId）：库改名时 Id 不变，因此改名只更新显示名，
 * 不会被当成"删了一个库又加了一个库"。
 *
 * `path` 用合成值 `emby:<库Id>`：应用不再有磁盘路径，但既有的落库/查找逻辑
 * （media_roots.container_path 唯一键、persistScan、rootIdForPath）都靠它做键，
 * 用它保持兼容；真正删掉磁盘语义在第 5 步。
 */
import type { EmbyClient, EmbyLibraryFolder } from "../integrations/emby-client";
import type { LibraryRootConfig } from "./service";

/** 未配置 Emby 时抛出：调用方应提示"Emby 不可达"，而不是把库存当成空的。 */
export const EMBY_LIBRARY_NOT_CONFIGURED = "emby_library_not_configured";

function collectionTypeToMediaType(
  collectionType: EmbyLibraryFolder["collectionType"],
): LibraryRootConfig["mediaType"] {
  if (collectionType === "movies") return "movie";
  if (collectionType === "tvshows") return "tv";
  return "mixed";
}

/** 合成路径：Emby 库没有磁盘路径，用 `emby:<库Id>` 作稳定键。 */
export function embyRootPath(libraryId: string): string {
  return `emby:${libraryId}`;
}

export function libraryFolderToRoot(folder: EmbyLibraryFolder): LibraryRootConfig {
  return {
    id: folder.id,
    name: folder.name,
    mediaType: collectionTypeToMediaType(folder.collectionType),
    path: embyRootPath(folder.id),
  };
}

export interface RootSyncPlan {
  /** Emby 侧新出现的库。 */
  added: LibraryRootConfig[];
  /** 已存在但显示名/类型变了（按 id 匹配；改名属于这里，不是 removed+added）。 */
  updated: LibraryRootConfig[];
  /** Emby 侧已不存在的库根 id：停止扫描并从界面移除（数据库行只置 enabled=false 保留历史）。 */
  removed: string[];
}

/** 比较"当前库根"与"Emby 现况"，得出该增/该改/该停的清单（纯函数，便于测试）。 */
export function planRootSync(
  current: readonly LibraryRootConfig[],
  incoming: readonly LibraryRootConfig[],
): RootSyncPlan {
  const currentById = new Map(current.map((root) => [root.id, root]));
  const incomingIds = new Set(incoming.map((root) => root.id));

  const added: LibraryRootConfig[] = [];
  const updated: LibraryRootConfig[] = [];
  for (const root of incoming) {
    const existing = currentById.get(root.id);
    if (!existing) {
      added.push(root);
      continue;
    }
    if (existing.name !== root.name || existing.mediaType !== root.mediaType || existing.path !== root.path) {
      updated.push(root);
    }
  }

  const removed = current.filter((root) => !incomingIds.has(root.id)).map((root) => root.id);
  return { added, updated, removed };
}

export interface EmbyRootsSource {
  /** 每次调用都重新问 Emby 要库列表（实时映射的根据）。 */
  load(): Promise<readonly LibraryRootConfig[]>;
}

export function createEmbyRootsSource(emby: EmbyClient): EmbyRootsSource {
  return {
    async load() {
      if (!emby.configured || !emby.listLibraryFolders) throw new Error(EMBY_LIBRARY_NOT_CONFIGURED);
      const folders = await emby.listLibraryFolders();
      // 按名称排序，保证界面顺序稳定（Emby 返回顺序不保证）
      return folders.map(libraryFolderToRoot).sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
    },
  };
}
