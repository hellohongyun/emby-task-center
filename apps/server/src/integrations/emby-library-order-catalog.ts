import type { EmbyLibraryOrderSession } from "./emby-library-order-client";
import { viewIdentity, type LibraryOrderSnapshot } from "./emby-library-order-plan";
import { aliasesFor, readLibraryOrderSide, type CatalogEntry } from "./emby-library-order-side";

export type Account = { id: string; name: string; isAdministrator: boolean; isDisabled: boolean };
type Catalog = {
  entries: CatalogEntry[];
  users: Account[];
  warnings: string[];
  suggestedOrder: string[];
  snapshots: Map<string, LibraryOrderSnapshot>;
  proxySnapshots: Map<string, LibraryOrderSnapshot>;
  incomplete: boolean;
  proxyUnavailable: boolean;
};

export function aliasMap(entries: CatalogEntry[]): Map<string, CatalogEntry> {
  const map = new Map<string, CatalogEntry>();
  for (const entry of entries) for (const alias of entry.aliases) map.set(alias, entry);
  return map;
}

export function resolveOrder(savedOrder: string[], entries: CatalogEntry[], fallbackOrder: string[] = []): string[] {
  const aliases = aliasMap(entries);
  const seen = new Set<string>();
  const order: string[] = [];
  for (const token of [...savedOrder, ...fallbackOrder]) {
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
  proxySession: EmbyLibraryOrderSession | null,
): Promise<Catalog> {
  const users = await session.listUsers();
  const [direct, proxy] = await Promise.all([
    readLibraryOrderSide(session, users, ownedVirtualLibraries, true),
    proxySession ? readLibraryOrderSide(proxySession, users, ownedVirtualLibraries, false) : undefined,
  ]);
  const proxyUnavailable = !proxy || (proxy.warnings.length > 0 && proxy.snapshots.size === 0);
  const warnings = [...direct.warnings, ...(proxy?.warnings ?? [])];
  if (proxyUnavailable) warnings.push("无法确认反代上游的媒体库顺序，请检查反代上游后重试。");

  const entries = [...direct.entries];
  const byAlias = aliasMap(entries);
  if (proxy && !proxyUnavailable) {
    for (const proxyEntry of proxy.entries) {
      const directEntry = [...proxyEntry.aliases]
        .map((alias) => byAlias.get(alias))
        .find((entry) => entry !== undefined);
      if (!directEntry) {
        entries.push(proxyEntry);
        for (const alias of proxyEntry.aliases) byAlias.set(alias, proxyEntry);
        continue;
      }
      directEntry.proxy = true;
      if (!directEntry.guid && proxyEntry.guid) {
        directEntry.guid = proxyEntry.guid;
        directEntry.id = viewIdentity(proxyEntry.guid);
      }
      for (const alias of proxyEntry.aliases) {
        directEntry.aliases.add(alias);
        byAlias.set(alias, directEntry);
      }
      for (const user of proxyEntry.visibleUsers) directEntry.visibleUsers.add(user);
    }
  }
  for (const entry of entries) {
    if (!entry.direct) entry.kind = "proxy";
    else if (entry.kind === "virtual") entry.direct = false;
  }

  const virtualCount = entries.filter((entry) => entry.kind === "virtual").length;
  if (virtualCount) {
    warnings.push(`${virtualCount} 个非原生媒体库仅由本项目反代按模板排序。`);
  }
  const proxyOnly = entries.filter((entry) => entry.kind === "proxy").length;
  if (proxyOnly) {
    warnings.push(
      `${proxyOnly} 个媒体库只存在于反代上游，Emby 直连不会保存它们的顺序；请让客户端使用本项目反代，反代会按同一份模板排序。`,
    );
  }

  for (const library of ownedVirtualLibraries) {
    const id = viewIdentity(library.id);
    entries.push({
      id,
      name: library.name,
      kind: "owned",
      aliases: new Set([id]),
      visibleUsers: new Set(
        [...direct.snapshots.entries()]
          .filter(([, snapshot]) => !snapshot.hiddenViews.some((key) => viewIdentity(key) === id))
          .map(([userId]) => userId),
      ),
      inOrderedViews: false,
      direct: false,
      proxy: true,
    });
  }

  // Start a first-time user from the client-facing order, not the raw Emby list:
  // that is the order the administrator sees in Emby Web and it includes upstream
  // proxy-injected libraries. The saved global order always wins later.
  const adminRead = users.find((user) => user.Policy?.IsAdministrator === true);
  const suggestedOrder: string[] = [];
  const suggested = new Set<string>();
  if (adminRead) {
    const adminViews =
      (proxySession !== session ? proxy?.snapshots.get(adminRead.Id)?.visible : undefined) ??
      direct.snapshots.get(adminRead.Id)?.templateOrder ??
      [];
    for (const view of adminViews) {
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

  return {
    entries,
    users: accounts,
    warnings,
    suggestedOrder,
    snapshots: direct.snapshots,
    proxySnapshots: proxy?.snapshots ?? new Map(),
    incomplete: proxyUnavailable || direct.warnings.length > 0 || Boolean(proxy?.warnings.length),
    proxyUnavailable,
  };
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
        direct: entry.direct,
        proxy: entry.proxy,
      },
    ];
  });
}
