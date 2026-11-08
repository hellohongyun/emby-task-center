import { anchorOwnedViews, applyAdminLibraryOrder } from "./view-order";
import { libraryDto } from "./library-dto";
import type { OwnedViewAnchor } from "./owned-view-preferences";
import {
  authenticationUrl,
  integerParameter,
  parameter,
  setParameter,
  type Item,
  type QueryUpstream,
  type UpstreamJson,
  type VirtualQueryStore,
} from "./query-helpers";

interface OverlayContext {
  url: URL;
  store: VirtualQueryStore;
  upstream: QueryUpstream;
  reply: UpstreamJson;
  onlyIds?: string[];
  serverId?: unknown;
  ownedOrder?: OwnedViewAnchor[];
  adminOrder?: readonly string[];
  collectionFoldersOnly?: boolean;
}

function identity(value: unknown): string {
  if (typeof value !== "string") return "";
  return /^(?:[a-f\d]{32}|[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12})$/i.test(value)
    ? value.replaceAll("-", "").toLowerCase()
    : value;
}

function keys(item: Item) {
  return [identity(item.Id), identity(item.Guid)].filter(Boolean);
}

function validItems(value: unknown, collectionFoldersOnly?: boolean): value is Item[] {
  return (
    Array.isArray(value) &&
    value.every(
      (item) => item && typeof item === "object" && (!collectionFoldersOnly || item.Type === "CollectionFolder"),
    )
  );
}

function itemTotal(body: unknown): number | undefined {
  const total = (body as { TotalRecordCount?: unknown } | null)?.TotalRecordCount;
  return typeof total === "number" && Number.isInteger(total) && total >= 0 ? total : undefined;
}

async function completeLibraryList(
  { url, upstream, collectionFoldersOnly }: OverlayContext,
  original: Item[],
  total: number | undefined,
  start: number,
  limit: number,
): Promise<Item[] | undefined> {
  if (start === 0 && (total !== undefined ? original.length >= total : original.length !== limit)) return original;
  const unpaged = new URL(url);
  setParameter(unpaged, "StartIndex");
  setParameter(unpaged, "Limit");
  if (unpaged.href === url.href) return undefined;
  try {
    const complete = await upstream(unpaged);
    const items = Array.isArray(complete.body) ? complete.body : (complete.body as { Items?: unknown } | null)?.Items;
    if (complete.status < 200 || complete.status >= 300 || !validItems(items, collectionFoldersOnly)) return undefined;
    if (items.length < Math.max(itemTotal(complete.body) ?? total ?? 0, original.length)) return undefined;
    return items;
  } catch {
    return undefined;
  }
}

async function preferences({ url, upstream }: OverlayContext) {
  const user = /^\/Users\/([^/]+)\//i.exec(url.pathname)?.[1] ?? parameter(url, "UserId");
  if (!user) return {};
  try {
    const reply = await upstream(
      authenticationUrl(url, `/Users/${encodeURIComponent(decodeURIComponent(user))}`),
      1_500,
    );
    if (reply.status < 200 || reply.status >= 300) return {};
    const body = reply.body as { Configuration?: Record<string, unknown> } | null;
    return body?.Configuration ?? {};
  } catch {
    return {};
  }
}

export async function overlayLibraries(context: OverlayContext): Promise<UpstreamJson> {
  const { url, store, reply, onlyIds } = context;
  if (reply.status < 200 || reply.status >= 300) return reply;
  const array = Array.isArray(reply.body);
  const body = reply.body as { Items?: unknown; TotalRecordCount?: unknown } | null;
  const original = array ? (reply.body as Item[]) : body?.Items;
  if (!validItems(original, context.collectionFoldersOnly)) return reply;
  const total = itemTotal(reply.body);
  const start = integerParameter(url, "StartIndex", 0);
  const limit = integerParameter(url, "Limit", Number.MAX_SAFE_INTEGER);
  const adminOrder = onlyIds ? undefined : context.adminOrder;
  const source = adminOrder ? await completeLibraryList(context, original, total, start, limit) : original;
  if (!source) return reply;
  const existing = new Set(source.flatMap(keys));
  const only = onlyIds ? new Set(onlyIds.map(identity)) : undefined;
  const libraries = store.list();
  const configuration = onlyIds || !libraries.length ? {} : await preferences(context);
  const hidden = new Set(
    Array.isArray(configuration.MyMediaExcludes) ? configuration.MyMediaExcludes.map(identity) : [],
  );
  const includeHidden = parameter(url, "IncludeHidden")?.toLowerCase() === "true";
  const search = parameter(url, "SearchTerm")?.toLocaleLowerCase();
  const types = parameter(url, "IncludeItemTypes")
    ?.split(",")
    .map((type) => type.trim().toLowerCase());
  const serverId = source.find((item) => item.ServerId)?.ServerId ?? context.serverId;
  const additions = libraries
    .filter((library) => !only || only.has(identity(library.id)))
    .filter((library) => !existing.has(identity(library.id)))
    .filter((library) => includeHidden || !hidden.has(identity(library.id)))
    .filter((library) => !search || library.name.toLocaleLowerCase().includes(search))
    .map((library) => libraryDto(store, library.id, serverId))
    .filter((item) => !types || types.includes(String(item.Type).toLowerCase()));
  if (adminOrder) {
    const ordered = applyAdminLibraryOrder([...source, ...additions], adminOrder, keys);
    // Some upstreams ignore pagination and return the complete list even with Limit.
    const items =
      original.length > limit && original.length >= source.length ? ordered : ordered.slice(start, start + limit);
    return {
      ...reply,
      raw: undefined,
      body: array ? items : { ...body, Items: items, TotalRecordCount: ordered.length },
    };
  }
  if (!additions.length) return reply;
  const order = Array.isArray(configuration.OrderedViews)
    ? configuration.OrderedViews.filter((id): id is string => typeof id === "string").map(identity)
    : [];
  const limited = parameter(url, "Limit") !== undefined;
  let items: Item[];
  const completeFirstPage =
    start === 0 && total !== undefined && original.length >= total && original.length + additions.length <= limit;
  if (!limited || original.length > limit || completeFirstPage) {
    items = anchorOwnedViews(original, additions, order, onlyIds ? [] : context.ownedOrder);
  } else {
    if (total === undefined && original.length >= limit) return reply;
    const upstreamTotal = total ?? start + original.length;
    const nextPage = start + original.length < upstreamTotal;
    const offset = Math.max(0, start - upstreamTotal);
    items = nextPage
      ? original
      : [...original, ...additions.slice(offset, offset + Math.max(0, limit - original.length))];
  }
  return {
    ...reply,
    raw: undefined,
    body: array
      ? items
      : { ...body, Items: items, TotalRecordCount: (total ?? start + original.length) + additions.length },
  };
}
