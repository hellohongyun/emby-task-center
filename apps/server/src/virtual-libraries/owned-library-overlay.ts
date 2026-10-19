import { anchorOwnedViews } from "./view-order";
import { libraryDto } from "./library-dto";
import {
  authenticationUrl,
  integerParameter,
  parameter,
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
  if (!Array.isArray(original) || original.some((item) => !item || typeof item !== "object")) return reply;
  const existing = new Set(original.flatMap(keys));
  const only = onlyIds ? new Set(onlyIds.map(identity)) : undefined;
  const configuration = onlyIds ? {} : await preferences(context);
  const order = Array.isArray(configuration.OrderedViews)
    ? configuration.OrderedViews.filter((id): id is string => typeof id === "string").map(identity)
    : [];
  const hidden = new Set(
    Array.isArray(configuration.MyMediaExcludes) ? configuration.MyMediaExcludes.map(identity) : [],
  );
  const includeHidden = parameter(url, "IncludeHidden")?.toLowerCase() === "true";
  const search = parameter(url, "SearchTerm")?.toLocaleLowerCase();
  const types = parameter(url, "IncludeItemTypes")?.toLowerCase().split(",");
  const serverId = original.find((item) => item.ServerId)?.ServerId ?? context.serverId;
  const additions = store
    .list()
    .filter((library) => !only || only.has(identity(library.id)))
    .filter((library) => !existing.has(identity(library.id)))
    .filter((library) => includeHidden || !hidden.has(identity(library.id)))
    .filter((library) => !search || library.name.toLocaleLowerCase().includes(search))
    .map((library) => libraryDto(store, library.id, serverId))
    .filter((item) => !types || types.includes(String(item.Type).toLowerCase()));
  if (!additions.length) return reply;
  const total = typeof body?.TotalRecordCount === "number" ? body.TotalRecordCount : undefined;
  const start = integerParameter(url, "StartIndex", 0);
  const limit = integerParameter(url, "Limit", Number.MAX_SAFE_INTEGER);
  const limited = parameter(url, "Limit") !== undefined;
  let items: Item[];
  if (!limited || original.length > limit) {
    items = anchorOwnedViews(original, additions, order);
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
