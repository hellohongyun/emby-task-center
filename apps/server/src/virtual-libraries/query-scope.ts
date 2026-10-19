import {
  allPages,
  authenticationUrl,
  checked,
  integerParameter,
  itemsPath,
  listBody,
  parameter,
  result,
  setParameter,
  type Item,
  type QueryUpstream,
  type UpstreamJson,
  type VirtualQueryStore,
} from "./query-helpers";
import { idBatches, sortItems, sortingFields } from "./query-sort";
import { groupLatest } from "./latest-grouping";

export async function authenticate(upstream: QueryUpstream, url: URL) {
  const probe = authenticationUrl(url);
  setParameter(probe, "Limit", "1");
  return checked(upstream, probe);
}

async function scopedIds(store: VirtualQueryStore, id: string, url: URL, upstream: QueryUpstream, wholeWorks = false) {
  const mapped = store.listItems(id);
  const ids = new Set(mapped.map((item) => item.itemId));
  const seriesParents = new Map<string, string>();
  // NextUp 本身按真实父项查询；先收集其全部分集不会参与后续范围判断。
  if (wholeWorks || /\/NextUp$/i.test(url.pathname)) return { ids, seriesParents };
  const recursive = parameter(url, "Recursive")?.toLowerCase() === "true" || /\/(Resume|Latest)$/i.test(url.pathname);
  if (!recursive) return { ids, seriesParents };
  const types = parameter(url, "IncludeItemTypes")
    ?.split(",")
    .map((type) => type.trim().toLowerCase());
  // 作品列表已由原始 ID 完整限定，Series 的季和分集不会通过 Movie/Series 筛选。
  // 旧 Folder 等容器仍可能包含作品，Latest/Resume 也仍需保留分集语义。
  if (
    !/\/(Resume|Latest)$/i.test(url.pathname) &&
    types?.length &&
    types.every((type) => type === "movie" || type === "series") &&
    mapped.every((item) => /^(Movie|Series)$/i.test(item.type))
  )
    return { ids, seriesParents };
  for (const item of mapped) {
    if (
      !["Series", "Season", "Folder", "BoxSet", "CollectionFolder", "Playlist", "MusicAlbum", "MusicArtist"].includes(
        item.type,
      )
    )
      continue;
    const children = authenticationUrl(url);
    setParameter(children, "ParentId", item.itemId);
    setParameter(children, "Recursive", "true");
    setParameter(children, "Fields", "ParentId");
    for (const child of await allPages(upstream, children)) {
      if (!child.Id) continue;
      ids.add(child.Id);
      // 合并后的剧集 ID 可能与分集 SeriesId 不同，以实际父范围查询建立归属。
      if (item.type === "Series" && !seriesParents.has(child.Id)) seriesParents.set(child.Id, item.itemId);
    }
  }
  return { ids, seriesParents };
}

export async function queryScope(
  store: VirtualQueryStore,
  id: string,
  source: URL,
  upstream: QueryUpstream,
): Promise<UpstreamJson> {
  const url = new URL(source);
  const latest = /\/Latest$/i.test(url.pathname);
  const nextUp = /\/NextUp$/i.test(url.pathname);
  const resume = /\/Resume$/i.test(url.pathname);
  const types = parameter(url, "IncludeItemTypes")
    ?.split(",")
    .map((type) => type.trim().toLowerCase());
  const wholeWorks =
    latest &&
    parameter(url, "GroupItems")?.toLowerCase() !== "false" &&
    (!types?.length || types.every((type) => ["movie", "series", "episode"].includes(type))) &&
    store.listItems(id).every((item) => /^(Movie|Series)$/i.test(item.type));
  const groupedVideo =
    wholeWorks &&
    parameter(url, "MediaTypes")
      ?.split(",")
      .some((type) => type.trim().toLowerCase() === "video");
  if (groupedVideo) {
    // Native Latest filters video leaves before grouping them into Series.
    // Our direct work lookup already represents those groups, so filtering
    // Series containers by leaf MediaType would incorrectly remove every show.
    setParameter(url, "MediaTypes");
  }
  if (wholeWorks && (types?.includes("episode") || groupedVideo)) {
    setParameter(
      url,
      "IncludeItemTypes",
      [
        ...new Set(
          (types?.length ? types : ["movie", "series"]).map((type) => (type === "movie" ? "Movie" : "Series")),
        ),
      ].join(","),
    );
  }
  const { ids, seriesParents } = await scopedIds(store, id, url, upstream, wholeWorks);
  const explicit = parameter(url, "Ids");
  if (explicit !== undefined) {
    const selected = new Set(explicit.split(","));
    for (const item of ids) if (!selected.has(item)) ids.delete(item);
  }
  const start = integerParameter(url, "StartIndex", 0);
  const limit = integerParameter(url, "Limit", latest ? 20 : Number.MAX_SAFE_INTEGER);
  setParameter(url, "ParentId");
  if (latest || resume) {
    url.pathname = itemsPath(source);
    setParameter(url, "Recursive", "true");
    if (!parameter(url, "SortBy")) setParameter(url, "SortBy", latest ? "DateCreated" : "DatePlayed");
    if (!parameter(url, "SortOrder")) setParameter(url, "SortOrder", "Descending");
    if (resume) {
      const filters = parameter(url, "Filters");
      setParameter(url, "Filters", [filters, "IsResumable"].filter(Boolean).join(","));
    }
  }
  if (!ids.size) {
    await authenticate(upstream, source);
    return result(latest ? [] : { Items: [], TotalRecordCount: 0, StartIndex: start });
  }
  // 小范围完整委托 Emby，保持其排序、筛选与分页语义。
  if (ids.size <= 50 && !nextUp && (!latest || wholeWorks)) {
    setParameter(url, "Ids", [...ids].join(","));
    setParameter(url, "Recursive", "true");
    setParameter(url, "EnableTotalRecordCount", "true");
    const response = await checked(upstream, url);
    return latest ? { ...response, raw: undefined, body: listBody(response.body).Items } : response;
  }
  // 分批限定原始 ID，在每批完整应用上游筛选后合并排序，避免扫描上游全库。
  sortingFields(url);
  const collected: Item[] = [];
  if (nextUp) {
    // NextUp 不支持 Ids；官方协议支持真实 ParentId，按原始映射分别查询。
    for (const mapped of store.listItems(id)) {
      const scoped = new URL(url);
      setParameter(scoped, "ParentId", mapped.itemId);
      if (mapped.type === "Series") setParameter(scoped, "SeriesId", mapped.itemId);
      collected.push(...(await allPages(upstream, scoped)));
    }
  } else {
    setParameter(url, "Recursive", "true");
    for (const batch of idBatches([...ids], url)) {
      const scoped = new URL(url);
      setParameter(scoped, "Ids", batch.join(","));
      collected.push(...(await allPages(upstream, scoped)));
    }
  }
  const seen = new Set<string>();
  let items = collected.filter((item) => {
    const inScope = item.Id && (nextUp || ids.has(item.Id));
    if (!inScope || seen.has(item.Id!)) return false;
    seen.add(item.Id!);
    return true;
  });
  const positions = new Map([...ids].map((itemId, index) => [itemId, index]));
  items = sortItems(items, url, positions);
  if (latest && parameter(source, "GroupItems")?.toLowerCase() !== "false") {
    items = await groupLatest(items, seriesParents, ids, source, upstream);
  }
  const page = items.slice(start, start + limit);
  return result(latest ? page : { Items: page, TotalRecordCount: items.length, StartIndex: start });
}
