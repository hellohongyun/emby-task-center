import { authenticationUrl, type Item, type QueryUpstream } from "./query-helpers";

/** Emby stores the complete view order in the user's Configuration.OrderedViews. */
export async function orderUserViews(url: URL, items: Item[], upstream: QueryUpstream): Promise<Item[]> {
  const user = /^\/Users\/([^/]+)\/Views\/?$/i.exec(url.pathname)?.[1];
  if (!user) return items;
  try {
    const path = `/Users/${encodeURIComponent(decodeURIComponent(user))}`;
    const response = await upstream(authenticationUrl(url, path), 1_500);
    if (response.status < 200 || response.status >= 300) return items;
    const body = response.body as { Configuration?: { OrderedViews?: unknown } } | null;
    const order = body?.Configuration?.OrderedViews;
    if (!Array.isArray(order)) return items;
    const positions = new Map<string, number>();
    for (const id of order) {
      if (typeof id === "string" && !positions.has(id)) positions.set(id, positions.size);
    }
    return [...items].sort(
      (a, b) => (positions.get(a.Id ?? "") ?? positions.size) - (positions.get(b.Id ?? "") ?? positions.size),
    );
  } catch {
    // A missing/unavailable preferences endpoint must not break otherwise valid browsing.
    return items;
  }
}
