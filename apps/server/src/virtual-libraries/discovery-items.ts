import {
  allPages,
  checked,
  integerParameter,
  listBody,
  parameter,
  result,
  setParameter,
  UpstreamQueryError,
  type Item,
  type QueryUpstream,
  type UpstreamJson,
  type VirtualQueryStore,
} from "./query-helpers";
import { authenticate } from "./query-scope";
import { idBatches, sortItems, sortingFields } from "./query-sort";
import { libraryDto } from "./library-dto";
import { orderUserViews } from "./view-order";

interface DiscoveryContext {
  url: URL;
  store: VirtualQueryStore;
  upstream: QueryUpstream;
}

function identity(value: unknown): string {
  if (typeof value !== "string") return "";
  return /^[a-f\d]{32}$/i.test(value) || /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(value)
    ? value.replaceAll("-", "").toLowerCase()
    : value;
}

function matches(item: Item, requested: Set<string>) {
  return [item.Id, item.Guid].some((value) => requested.has(identity(value)));
}

function matchesVirtual(item: Item, url: URL) {
  const types = parameter(url, "IncludeItemTypes")
    ?.split(",")
    .map((value) => value.trim().toLowerCase());
  if (types?.length && !types.includes(String(item.Type).toLowerCase())) return false;
  const search = parameter(url, "SearchTerm")?.toLocaleLowerCase();
  return !search || String(item.Name).toLocaleLowerCase().includes(search);
}

function unpaged(url: URL) {
  const target = new URL(url);
  setParameter(target, "StartIndex");
  setParameter(target, "Limit");
  sortingFields(target);
  return target;
}

function page(items: Item[], url: URL): UpstreamJson {
  const start = integerParameter(url, "StartIndex", 0);
  const limit = integerParameter(url, "Limit", Number.MAX_SAFE_INTEGER);
  return result({ Items: items.slice(start, start + limit), TotalRecordCount: items.length, StartIndex: start });
}

/** Some upstream proxies ignore invalid Ids and return their default library page. */
async function requestedItems(url: URL, ids: string[], upstream: QueryUpstream) {
  const items: Item[] = [];
  const seen = new Set<string>();
  for (const batch of idBatches(ids, url)) {
    const requested = new Set(batch.map(identity));
    const target = unpaged(url);
    setParameter(target, "Ids", batch.join(","));
    setParameter(target, "Limit", String(batch.length));
    setParameter(target, "EnableTotalRecordCount", "true");
    for (let offset = 0; ;) {
      setParameter(target, "StartIndex", String(offset));
      const body = listBody((await checked(upstream, target)).body);
      const selected = body.Items.filter((item) => matches(item, requested));
      let added = 0;
      for (const item of selected) {
        const key = identity(item.Id) || identity(item.Guid);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        items.push(item);
        added++;
      }
      // Do not scan unrelated pages when Ids was ignored, or loop on ignored paging.
      if (!added || selected.length !== body.Items.length) break;
      offset += body.Items.length;
      if (offset >= batch.length || (typeof body.TotalRecordCount === "number" && offset >= body.TotalRecordCount))
        break;
    }
  }
  return items;
}

export async function discoveryItems({ url, store, upstream }: DiscoveryContext): Promise<UpstreamJson | undefined> {
  const folders = /^\/Library\/MediaFolders\/?$/i.test(url.pathname);
  const byIds = /^\/(?:Users\/[^/]+\/)?Items\/?$/i.test(url.pathname);
  if (!folders && (!byIds || parameter(url, "ParentId") !== undefined || !parameter(url, "Ids"))) return undefined;
  const ids = [...new Set((parameter(url, "Ids") ?? "").split(",").filter(Boolean))];
  const libraries = new Map(store.list().map((library) => [identity(library.id), library.id]));
  const virtualIds = [...new Set(ids.map((id) => libraries.get(identity(id))).filter((id): id is string => !!id))];
  if (!folders && (!byIds || !virtualIds.length)) return undefined;
  if (!store.list().length) return undefined;
  try {
    if (folders) {
      const original = await allPages(upstream, unpaged(url));
      const serverId = original.find((item) => item.ServerId)?.ServerId;
      const additions = store.list().map((library) => libraryDto(store, library.id, serverId));
      const originalIds = new Set(original.map((item) => item.Id));
      const items = [
        ...original,
        ...additions.filter((item) => !originalIds.has(item.Id) && matchesVirtual(item, url)),
      ];
      const positions = new Map(items.map((item, index) => [item.Id!, index]));
      sortItems(items, url, positions);
      return page(await orderUserViews(url, items, upstream), url);
    }
    const realIds = ids.filter((id) => !libraries.has(identity(id)));
    const original = realIds.length ? await requestedItems(url, realIds, upstream) : [];
    // An empty Ids query would broaden scope to the full upstream library.
    const probe = realIds.length ? undefined : await authenticate(upstream, url);
    const serverId =
      original.find((item) => item.ServerId)?.ServerId ??
      (probe ? listBody(probe.body).Items.find((item) => item.ServerId)?.ServerId : undefined);
    const additions = virtualIds
      .map((id) => libraryDto(store, id, serverId))
      .filter((item) => matchesVirtual(item, url));
    const items = [...original, ...additions];
    const requestedPositions = new Map(ids.map((id, index) => [identity(id), index]));
    const positions = new Map(
      items.map((item) => [
        item.Id!,
        requestedPositions.get(identity(item.Id)) ?? requestedPositions.get(identity(item.Guid)) ?? ids.length,
      ]),
    );
    return page(sortItems(items, url, positions), url);
  } catch (error) {
    if (error instanceof UpstreamQueryError) return error.result;
    throw error;
  }
}
