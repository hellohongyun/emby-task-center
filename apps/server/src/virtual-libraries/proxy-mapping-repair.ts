import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { normalizeVirtualLibraryTmdbId, type VirtualLibraryItem } from "@emby-task-center/contracts/virtual-library";
import { repairVirtualMappings } from "./mapping-repair";
import { authenticationUrl, checked, listBody, setParameter, type Item, type QueryUpstream } from "./query-helpers";
import type { VirtualLibraryStore } from "./store";

function normalize(item: Item): VirtualLibraryItem | null {
  if (typeof item.Id !== "string" || typeof item.Name !== "string" || typeof item.Type !== "string") return null;
  const providers = item.ProviderIds as Record<string, unknown> | undefined;
  const tmdbId = normalizeVirtualLibraryTmdbId(providers?.Tmdb ?? providers?.tmdb);
  const tags = item.ImageTags as Record<string, unknown> | undefined;
  return {
    itemId: item.Id,
    name: item.Name,
    type: item.Type,
    year: typeof item.ProductionYear === "number" ? item.ProductionYear : null,
    imageTag: typeof tags?.Primary === "string" ? tags.Primary : null,
    ...(tmdbId ? { tmdbId } : {}),
  };
}

/** Client repair uses only that request's upstream credentials, never the admin key. */
export function proxyMappingSource(url: URL, upstream: QueryUpstream) {
  async function query(params: Record<string, string>) {
    const target = authenticationUrl(url);
    setParameter(target, "Recursive", "true");
    setParameter(target, "Fields", "ProviderIds,ProductionYear");
    for (const [key, value] of Object.entries(params)) setParameter(target, key, value);
    return listBody((await checked(upstream, target)).body).Items.flatMap((item) => {
      const result = normalize(item);
      return result ? [result] : [];
    });
  }
  return {
    async lookupItems(ids: string[]) {
      const items: VirtualLibraryItem[] = [];
      for (let offset = 0; offset < ids.length; offset += 50) {
        const batch = ids.slice(offset, offset + 50);
        const selected = new Set(batch);
        items.push(
          ...(await query({ Ids: batch.join(","), Limit: String(batch.length) })).filter((item) =>
            selected.has(item.itemId),
          ),
        );
      }
      return items;
    },
    async findByTmdb(type: string, tmdbId: string) {
      const matches = new Map<string, VirtualLibraryItem>();
      const pages = new Set<string>();
      for (let offset = 0; ; offset += 100) {
        const page = await query({
          AnyProviderIdEquals: `Tmdb.${tmdbId}`,
          IncludeItemTypes: type,
          Limit: "100",
          StartIndex: String(offset),
          EnableTotalRecordCount: "true",
        });
        const signature = JSON.stringify(page.map((item) => item.itemId));
        if (pages.has(signature)) throw new Error("Emby 未正确处理身份查询分页");
        pages.add(signature);
        if (page.some((item) => item.type !== type || normalizeVirtualLibraryTmdbId(item.tmdbId) !== tmdbId))
          throw new Error("Emby 未正确处理作品身份筛选");
        for (const item of page) matches.set(item.itemId, item);
        // More than one proven candidate is already ambiguous; never choose a convenient first result.
        if (matches.size > 1 || page.length < 100) return [...matches.values()];
      }
    },
  };
}

export function createProxyMappingRepair(store: VirtualLibraryStore) {
  type Check = { expires: number; task: Promise<boolean> };
  const pending = new Map<string, Check>();
  const signature = (items: VirtualLibraryItem[]) =>
    items.map((item) => [item.itemId, item.type, normalizeVirtualLibraryTmdbId(item.tmdbId)]);
  return async (
    id: string,
    request: IncomingMessage,
    url: URL,
    upstreamBase: string,
    upstream: QueryUpstream,
    signal?: AbortSignal,
  ) => {
    const auth = authenticationUrl(url);
    const parameters = [...auth.searchParams]
      .map(([key, value]) => [key.toLowerCase(), value])
      .sort(([a], [b]) => a!.localeCompare(b!));
    const credentials = parameters.filter(([key]) => key !== "userid");
    const headers = Object.entries(request.headers)
      .filter(([key]) => /authorization|token|api[-_]?key|cookie|user[-_]?id/i.test(key))
      .map(([key, value]) => [key.toLowerCase(), value])
      .sort(([a], [b]) => String(a).localeCompare(String(b)));
    const users = [
      /^\/Users\/([^/]+)\//i.exec(url.pathname)?.[1] ?? null,
      ...parameters.filter(([key]) => key === "userid").map(([, value]) => value),
    ].filter((value) => value !== null);
    const context = JSON.stringify({ id, upstreamBase, users: [...new Set(users)], credentials, headers });
    const keyFor = (items: VirtualLibraryItem[]) =>
      createHash("sha256")
        .update(context)
        .update(JSON.stringify(signature(items)))
        .digest("hex");
    const before = store.listItems(id);
    const key = keyFor(before);
    const cached = pending.get(key);
    if (cached && cached.expires > Date.now()) {
      if (await cached.task) return;
      // A canceled owner must not poison another live request sharing the check.
      if (signal?.aborted || request.aborted) return;
      if (pending.get(key) === cached) pending.delete(key);
      return await check();
    }
    await check();

    async function check() {
      const shared = pending.get(key);
      if (shared && shared.expires > Date.now()) return void (await shared.task);
      const verified = new Map<string, VirtualLibraryItem>();
      const source = proxyMappingSource(url, upstream);
      const record = async (task: Promise<VirtualLibraryItem[]>) => {
        const items = await task;
        for (const item of items) verified.set(item.itemId, item);
        return items;
      };
      const entry: Check = { expires: Infinity, task: Promise.resolve(false) };
      entry.task = (async () => {
        try {
          const result = await repairVirtualMappings(store, id, {
            lookupItems: (ids) => record(source.lookupItems(ids)),
            findByTmdb: (type, tmdbId) => record(source.findByTmdb(type, tmdbId)),
          });
          if (signal?.aborted || request.aborted || result.issues.some((issue) => issue.reason === "unavailable"))
            return false;
          entry.expires = Date.now() + 30_000;
          // Cache the repaired snapshot only when every current mapping was actually checked.
          const current = store.listItems(id);
          if (
            current.every((item) => {
              const checked = verified.get(item.itemId);
              return (
                checked?.type === item.type &&
                normalizeVirtualLibraryTmdbId(checked.tmdbId) === normalizeVirtualLibraryTmdbId(item.tmdbId)
              );
            })
          )
            pending.set(keyFor(current), entry);
          return true;
        } finally {
          if (entry.expires === Infinity && pending.get(key) === entry) pending.delete(key);
        }
      })();
      pending.set(key, entry);
      if (pending.size > 500) pending.delete(pending.keys().next().value!);
      await entry.task;
    }
  };
}
