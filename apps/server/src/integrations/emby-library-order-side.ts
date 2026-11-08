import type { EmbyLibraryOrderSession } from "./emby-library-order-client";
import { libraryOrderSnapshot, viewIdentity, type LibraryOrderSnapshot } from "./emby-library-order-plan";

type LibraryKind = "native" | "virtual" | "proxy" | "unknown" | "owned";
export type CatalogEntry = {
  id: string;
  guid?: string;
  name: string;
  kind: LibraryKind;
  aliases: Set<string>;
  visibleUsers: Set<string>;
  inOrderedViews: boolean;
  /** 可直接写入 Emby 的 OrderedViews。 */
  direct: boolean;
  /** 出现在客户端实际访问的反代上游目录中。 */
  proxy: boolean;
};

export async function inBatches<T, R>(items: T[], process: (item: T) => Promise<R>): Promise<R[]> {
  const result: R[] = [];
  for (let offset = 0; offset < items.length; offset += 4) {
    result.push(...(await Promise.all(items.slice(offset, offset + 4).map(process))));
  }
  return result;
}

export function aliasesFor(view: { id: string; guid?: string }): string[] {
  return [...new Set([view.id, view.guid || view.id].map(viewIdentity).filter(Boolean))];
}

interface Side {
  entries: CatalogEntry[];
  snapshots: Map<string, LibraryOrderSnapshot>;
  warnings: string[];
}

/**
 * 读取一个 Emby 兼容端点的媒体库目录。
 *
 * `direct` 为 true 时同时读取 VirtualFolders，用来区分真实库和上游反代动态注入的库。
 * 反代上游只需要 Views/MediaFolders，不需要 VirtualFolders。
 */
export async function readLibraryOrderSide(
  session: EmbyLibraryOrderSession,
  users: Awaited<ReturnType<EmbyLibraryOrderSession["listUsers"]>>,
  ownedVirtualLibraries: Array<{ id: string; name: string }>,
  direct: boolean,
): Promise<Side> {
  const ownedIds = new Set(ownedVirtualLibraries.map(({ id }) => viewIdentity(id)));
  const warnings: string[] = [];
  let native: Awaited<ReturnType<EmbyLibraryOrderSession["listServerLibraries"]>> | null = null;
  if (direct) {
    try {
      native = await session.listServerLibraries();
    } catch {
      warnings.push("无法读取 Emby 原生媒体库列表，暂时无法区分原生库和虚拟库。");
    }
  }
  let mediaFolders: Awaited<ReturnType<EmbyLibraryOrderSession["listMediaFolders"]>> | null = null;
  try {
    mediaFolders = await session.listMediaFolders();
  } catch {
    warnings.push(
      direct
        ? "无法读取 Emby 媒体库合集，部分未分配给任何账号的库可能不会显示。"
        : "无法读取反代上游的媒体库合集，部分反代库可能不会显示。",
    );
  }

  const reads = await inBatches(users, async (user) => {
    try {
      const [preferences, views] = await Promise.all([
        session.getUserPreferences(user.Id),
        direct ? session.listUserViews(user.Id) : session.listUserViews(user.Id, { includeHidden: true }),
      ]);
      const snapshot = libraryOrderSnapshot(preferences, views, ownedIds);
      return { user, snapshot };
    } catch {
      return { user, snapshot: null };
    }
  });
  const failedUsers = reads.filter((item) => !item.snapshot).length;
  if (failedUsers) {
    warnings.push(
      direct
        ? `${failedUsers} 个 Emby 账号的媒体库顺序读取失败，预览时会单独标注。`
        : `${failedUsers} 个反代账号的媒体库列表读取失败，反代顺序可能不完整。`,
    );
  }

  const entries: CatalogEntry[] = [];
  const byAlias = new Map<string, CatalogEntry>();
  const addView = (view: { id: string; guid?: string; name: string }) => {
    const aliases = aliasesFor(view);
    let entry = aliases.map((alias) => byAlias.get(alias)).find((item) => item !== undefined);
    if (!entry) {
      entry = {
        id: view.guid ? viewIdentity(view.guid) : viewIdentity(view.id),
        ...(view.guid ? { guid: view.guid } : {}),
        name: view.name,
        kind: "unknown",
        aliases: new Set(aliases),
        visibleUsers: new Set<string>(),
        inOrderedViews: false,
        direct,
        proxy: !direct,
      };
      entries.push(entry);
    } else if (!entry.guid && view.guid) {
      entry.guid = view.guid;
      entry.id = viewIdentity(view.guid);
    }
    if (direct) entry.direct = true;
    else entry.proxy = true;
    for (const alias of aliases) {
      entry.aliases.add(alias);
      byAlias.set(alias, entry);
    }
    return entry;
  };

  for (const { user, snapshot } of reads) {
    if (!snapshot) continue;
    const ordered = new Set(snapshot.orderedViews.map(viewIdentity));
    for (const view of snapshot.visible) {
      const entry = addView(view);
      if (aliasesFor(view).some((alias) => ordered.has(alias))) entry.inOrderedViews = true;
      entry.visibleUsers.add(user.Id);
    }
  }

  // Include libraries that no account currently sees. They still belong to the
  // catalog and must be orderable for future accounts.
  for (const folder of mediaFolders ?? []) {
    const aliases = aliasesFor(folder);
    if (aliases.some((id) => ownedIds.has(id))) continue;
    addView(folder);
  }

  const nativeIds = new Set((native ?? []).map((library) => viewIdentity(library.id)));
  for (const entry of entries) {
    if (direct) {
      if ([...entry.aliases].some((alias) => nativeIds.has(alias))) {
        entry.kind = "native";
        for (const alias of entry.aliases) nativeIds.add(alias);
      } else {
        entry.kind = native ? "virtual" : "unknown";
      }
    }
  }
  for (const library of native ?? []) {
    const id = viewIdentity(library.id);
    if (ownedIds.has(id)) continue;
    if (entries.some((entry) => entry.aliases.has(id))) continue;
    entries.push({
      id,
      name: library.name,
      kind: "native",
      aliases: new Set([id]),
      visibleUsers: new Set<string>(),
      inOrderedViews: false,
      direct: true,
      proxy: false,
    });
  }

  return {
    entries,
    snapshots: new Map(reads.flatMap(({ user, snapshot }) => (snapshot ? [[user.Id, snapshot]] : []))),
    warnings,
  };
}
