import { authenticationUrl, parameter, type Item, type QueryUpstream } from "./query-helpers";

function identity(value: string) {
  return /^(?:[a-f\d]{32}|[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12})$/i.test(value)
    ? value.replaceAll("-", "").toLowerCase()
    : value;
}

/** Emby stores the complete view order in the user's Configuration.OrderedViews. */
export async function orderUserViews(url: URL, items: Item[], upstream: QueryUpstream): Promise<Item[]> {
  const user = /^\/Users\/([^/]+)\//i.exec(url.pathname)?.[1] ?? parameter(url, "UserId");
  if (!user) return items;
  try {
    const path = `/Users/${encodeURIComponent(decodeURIComponent(user))}`;
    const response = await upstream(authenticationUrl(url, path), 1_500);
    if (response.status < 200 || response.status >= 300) return items;
    const body = response.body as { Configuration?: { OrderedViews?: unknown; MyMediaExcludes?: unknown } } | null;
    const order = body?.Configuration?.OrderedViews;
    const positions = new Map<string, number>();
    for (const id of Array.isArray(order) ? order : []) {
      if (typeof id === "string" && !positions.has(identity(id))) positions.set(identity(id), positions.size);
    }
    const position = (item: Item) =>
      (typeof item.Guid === "string" ? positions.get(identity(item.Guid)) : undefined) ??
      positions.get(identity(item.Id ?? "")) ??
      positions.size;
    const excludes = body?.Configuration?.MyMediaExcludes;
    const hidden = Array.isArray(excludes)
      ? new Set(excludes.filter((id): id is string => typeof id === "string").map(identity))
      : new Set<string>();
    const includeHidden = parameter(url, "IncludeHidden")?.toLowerCase() === "true";
    return items
      .filter(
        (item) =>
          includeHidden || ![item.Guid, item.Id].some((id) => typeof id === "string" && hidden.has(identity(id))),
      )
      .sort((a, b) => position(a) - position(b));
  } catch {
    // A missing/unavailable preferences endpoint must not break otherwise valid browsing.
    return items;
  }
}
