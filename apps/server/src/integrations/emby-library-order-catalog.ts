import type { EmbyLibraryOrderSession } from "./emby-library-order-client";
import { libraryOrderSnapshot, viewIdentity, type LibraryOrderSnapshot } from "./emby-library-order-plan";

type LibraryKind = "native" | "virtual" | "unknown" | "owned";
export type Account = { id: string; name: string; isAdministrator: boolean; isDisabled: boolean };
type CatalogEntry = {
  id: string;
  guid?: string;
  name: string;
  kind: LibraryKind;
  aliases: Set<string>;
  visibleUsers: Set<string>;
  inOrderedViews: boolean;
};
type Catalog = {
  entries: CatalogEntry[];
  users: Account[];
  warnings: string[];
  suggestedOrder: string[];
  snapshots: Map<string, LibraryOrderSnapshot>;
};

export async function inBatches<T, R>(items: T[], process: (item: T) => Promise<R>): Promise<R[]> {
  const result: R[] = [];
  for (let offset = 0; offset < items.length; offset += 4) {
    result.push(...(await Promise.all(items.slice(offset, offset + 4).map(process))));
  }
  return result;
}

function aliasesFor(view: { id: string; guid?: string }): string[] {
  return [...new Set([view.id, view.guid || view.id].map(viewIdentity).filter(Boolean))];
}

export function aliasMap(entries: CatalogEntry[]): Map<string, CatalogEntry> {
  const map = new Map<string, CatalogEntry>();
  for (const entry of entries) for (const alias of entry.aliases) map.set(alias, entry);
  return map;
}

export function resolveOrder(savedOrder: string[], entries: CatalogEntry[]): string[] {
  const aliases = aliasMap(entries);
  const seen = new Set<string>();
  const order: string[] = [];
  for (const token of savedOrder) {
    const entry = aliases.get(viewIdentity(token));
    if (!entry || seen.has(entry.id)) continue;
    seen.add(entry.id);
    order.push(entry.id);
  }
  for (const entry of entries) {
    if (!seen.has(entry.id)) order.push(entry.id);
  }
  return order;
}

export async function readCatalog(
  session: EmbyLibraryOrderSession,
  ownedVirtualLibraries: Array<{ id: string; name: string }>,
): Promise<Catalog> {
  const users = await session.listUsers();
  const ownedIds = new Set(ownedVirtualLibraries.map(({ id }) => viewIdentity(id)));
  const warnings: string[] = [];
  let native: Awaited<ReturnType<EmbyLibraryOrderSession["listServerLibraries"]>> | null = null;
  try {
    native = await session.listServerLibraries();
  } catch {
    warnings.push("无法读取 Emby 原生媒体库列表，暂时无法区分原生库和虚拟库。");
  }
  let mediaFolders: Awaited<ReturnType<EmbyLibraryOrderSession["listMediaFolders"]>> | null = null;
  try {
    mediaFolders = await session.listMediaFolders();
  } catch {
    warnings.push("无法读取 Emby 媒体库合集，部分未分配给任何账号的库可能不会显示。");
  }

  const reads = await inBatches(users, async (user) => {
    try {
      const [preferences, views] = await Promise.all([
        session.getUserPreferences(user.Id),
        session.listUserViews(user.Id),
      ]);
      const snapshot = libraryOrderSnapshot(preferences, views, ownedIds);
      return { user, snapshot };
    } catch {
      return { user, snapshot: null };
    }
  });
  const failedUsers = reads.filter((item) => !item.snapshot).length;
  if (failedUsers) warnings.push(`${failedUsers} 个 Emby 账号的媒体库顺序读取失败，预览时会单独标注。`);

  const entries: CatalogEntry[] = [];
  const byAlias = new Map<string, CatalogEntry>();
  for (const { user, snapshot } of reads) {
    if (!snapshot) continue;
    const ordered = new Set(snapshot.orderedViews.map(viewIdentity));
    for (const view of snapshot.visible) {
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
        };
        entries.push(entry);
      } else if (!entry.guid && view.guid) {
        entry.guid = view.guid;
        entry.id = viewIdentity(view.guid);
      }
      for (const alias of aliases) {
        entry.aliases.add(alias);
        byAlias.set(alias, entry);
      }
      if (aliases.some((alias) => ordered.has(alias))) entry.inOrderedViews = true;
      entry.visibleUsers.add(user.Id);
    }
  }

  // Include libraries that no account currently sees. They still belong to the
  // server catalog and must be orderable for future accounts.
  for (const folder of mediaFolders ?? []) {
    const aliases = aliasesFor(folder);
    if (aliases.some((id) => ownedIds.has(id))) continue;
    let entry = aliases.map((alias) => byAlias.get(alias)).find((item) => item !== undefined);
    if (!entry) {
      entry = {
        id: folder.guid ? viewIdentity(folder.guid) : viewIdentity(folder.id),
        ...(folder.guid ? { guid: folder.guid } : {}),
        name: folder.name,
        kind: "unknown",
        aliases: new Set(aliases),
        visibleUsers: new Set<string>(),
        inOrderedViews: false,
      };
      entries.push(entry);
    } else if (!entry.guid && folder.guid) {
      entry.guid = folder.guid;
      entry.id = viewIdentity(folder.guid);
    }
    for (const alias of aliases) {
      entry.aliases.add(alias);
      byAlias.set(alias, entry);
    }
  }

  const nativeIds = new Set((native ?? []).map((library) => viewIdentity(library.id)));
  for (const entry of entries) {
    if ([...entry.aliases].some((alias) => nativeIds.has(alias))) {
      entry.kind = "native";
      for (const alias of entry.aliases) nativeIds.add(alias);
    } else {
      entry.kind = native ? "virtual" : "unknown";
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
    });
  }

  const virtualCount = entries.filter((entry) => entry.kind === "virtual").length;
  if (virtualCount) {
    warnings.push(
      `${virtualCount} 个非原生媒体库不在 Emby Library/VirtualFolders 中，写入 OrderedViews 后可能不生效。`,
    );
  }

  // Start a first-time user from the administrator's actual OrderedViews rather
  // than the raw /Views fallback order. The saved global order always wins later.
  const adminRead = reads.find(({ user, snapshot }) => user.Policy?.IsAdministrator === true && snapshot);
  const suggestedOrder: string[] = [];
  const suggested = new Set<string>();
  if (adminRead?.snapshot) {
    for (const view of adminRead.snapshot.templateOrder) {
      const entry = aliasesFor(view)
        .map((alias) => byAlias.get(alias))
        .find((item) => item !== undefined);
      if (entry && !suggested.has(entry.id)) {
        suggested.add(entry.id);
        suggestedOrder.push(entry.id);
      }
    }
  }

  const accounts = users.map((user) => ({
    id: user.Id,
    name: user.Name,
    isAdministrator: user.Policy?.IsAdministrator === true,
    isDisabled: user.Policy?.IsDisabled === true,
  }));
  for (const library of ownedVirtualLibraries) {
    const id = viewIdentity(library.id);
    entries.push({
      id,
      name: library.name,
      kind: "owned",
      aliases: new Set([id]),
      visibleUsers: new Set(
        reads.flatMap(({ user, snapshot }) =>
          snapshot && !snapshot.hiddenViews.some((key) => viewIdentity(key) === id) ? [user.Id] : [],
        ),
      ),
      inOrderedViews: false,
    });
  }
  const snapshots = new Map(reads.flatMap(({ user, snapshot }) => (snapshot ? [[user.Id, snapshot]] : [])));
  return { entries, users: accounts, warnings, suggestedOrder, snapshots };
}

export function publicLibraries(entries: CatalogEntry[], order: string[]) {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  return order.flatMap((id) => {
    const entry = byId.get(id);
    if (!entry) return [];
    return [
      {
        id: entry.id,
        name: entry.name,
        kind: entry.kind,
        visibleUsers: entry.visibleUsers.size,
        inOrderedViews: entry.inOrderedViews,
      },
    ];
  });
}
