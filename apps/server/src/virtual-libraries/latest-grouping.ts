import { allPages, authenticationUrl, parameter, setParameter, type Item, type QueryUpstream } from "./query-helpers";
import { idBatches } from "./query-sort";

export async function groupLatest(
  items: Item[],
  parents: Map<string, string>,
  scopeIds: Set<string>,
  source: URL,
  upstream: QueryUpstream,
) {
  const series = new Map(items.filter((item) => item.Type === "Series").map((item) => [item.Id!, item]));
  const groupId = (item: Item) =>
    parents.get(item.Id!) ?? (typeof item.SeriesId === "string" ? item.SeriesId : item.Id!);
  const missing = new Set(
    items
      .map((item) => parents.get(item.Id!))
      .filter((id): id is string => !!id && scopeIds.has(id) && !series.has(id)),
  );
  if (missing.size) {
    // 分集筛选可能没有返回整部剧；只补读已匹配分集所属的原剧集，保留原海报与标题。
    const url = authenticationUrl(source);
    for (const key of ["Fields", "ImageTypeLimit", "EnableImageTypes", "EnableImages", "EnableUserData"]) {
      const value = parameter(source, key);
      if (value !== undefined) setParameter(url, key, value);
    }
    setParameter(url, "IncludeItemTypes", "Series");
    for (const batch of idBatches([...missing], url)) {
      const scoped = new URL(url);
      setParameter(scoped, "Ids", batch.join(","));
      for (const item of await allPages(upstream, scoped)) {
        if (item.Id && missing.has(item.Id) && item.Type === "Series") series.set(item.Id, item);
      }
    }
  }
  const groups = new Set<string>();
  return items.flatMap((item) => {
    const key = groupId(item);
    if (groups.has(key)) return [];
    groups.add(key);
    return [series.get(key) ?? item];
  });
}
