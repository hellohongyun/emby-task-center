import {
  integerParameter,
  itemsPath,
  listBody,
  parameter,
  result,
  setParameter,
  type Item,
  type QueryUpstream,
  type VirtualQueryStore,
} from "./query-helpers";
import { queryScope } from "./query-scope";

function strings(items: Item[], field: string) {
  return [
    ...new Set(
      items.flatMap((item) =>
        Array.isArray(item[field]) ? item[field].filter((entry): entry is string => typeof entry === "string") : [],
      ),
    ),
  ].sort();
}
function pairs(items: Item[], field: string, fallback: string) {
  const found = new Map<string, { Name: string; Id: string }>();
  for (const item of items) {
    const values = item[field];
    if (Array.isArray(values))
      for (const value of values) {
        if (value && typeof value.Name === "string" && value.Id !== undefined) {
          found.set(value.Name, { Name: value.Name, Id: String(value.Id) });
        }
      }
  }
  for (const name of strings(items, fallback)) if (!found.has(name)) found.set(name, { Name: name, Id: name });
  return [...found.values()].sort((a, b) => a.Name.localeCompare(b.Name));
}

export async function facetQuery(store: VirtualQueryStore, id: string, source: URL, upstream: QueryUpstream) {
  const url = new URL(source);
  url.pathname = itemsPath(source);
  setParameter(url, "StartIndex");
  setParameter(url, "Limit");
  setParameter(url, "Recursive", "true");
  // 作品库的筛选项取电影/整部剧资料即可；Counts 仍需统计全部分集。
  const mapped = store.listItems(id);
  if (
    !/\/Counts\/?$/i.test(source.pathname) &&
    parameter(url, "IncludeItemTypes") === undefined &&
    mapped.length &&
    mapped.every((item) => /^(Movie|Series)$/i.test(item.type))
  ) {
    setParameter(url, "IncludeItemTypes", [...new Set(mapped.map((item) => item.type))].join(","));
  }
  setParameter(
    url,
    "Fields",
    [parameter(url, "Fields"), "Genres,GenreItems,Tags,TagItems,Studios,OfficialRating,ProductionYear"]
      .filter(Boolean)
      .join(","),
  );
  const items = listBody((await queryScope(store, id, url, upstream)).body).Items;
  const genres = pairs(items, "GenreItems", "Genres");
  const tags = pairs(items, "TagItems", "Tags");
  const studios = pairs(items, "Studios", "Studios");
  const years = [
    ...new Set(items.flatMap((item) => (typeof item.ProductionYear === "number" ? [item.ProductionYear] : []))),
  ].sort((a, b) => b - a);
  const ratings = [
    ...new Set(items.flatMap((item) => (typeof item.OfficialRating === "string" ? [item.OfficialRating] : []))),
  ].sort();
  if (/\/Filters2?\/?$/i.test(source.pathname)) {
    return result({
      Genres: /Filters2/i.test(source.pathname) ? genres : genres.map((item) => item.Name),
      Tags: /Filters2/i.test(source.pathname) ? tags : tags.map((item) => item.Name),
      Years: years,
      OfficialRatings: ratings,
    });
  }
  if (/\/Counts\/?$/i.test(source.pathname)) {
    const count = (type: string) => items.filter((item) => item.Type === type).length;
    return result({
      MovieCount: count("Movie"),
      SeriesCount: count("Series"),
      EpisodeCount: count("Episode"),
      SongCount: count("Audio"),
      AlbumCount: count("MusicAlbum"),
      MusicVideoCount: count("MusicVideo"),
      BoxSetCount: count("BoxSet"),
      BookCount: count("Book"),
      ItemCount: items.length,
    });
  }
  const name = source.pathname.replace(/\//g, "").toLowerCase();
  const values =
    name === "genres"
      ? genres
      : name === "tags"
        ? tags
        : name === "studios"
          ? studios
          : years.map((year) => ({ Name: String(year), Id: String(year) }));
  const start = integerParameter(source, "StartIndex", 0);
  const limit = integerParameter(source, "Limit", values.length);
  return result({
    Items: values.slice(start, start + limit).map((item) => ({
      ...item,
      Type: name === "genres" ? "Genre" : name === "studios" ? "Studio" : name === "tags" ? "Tag" : "Year",
    })),
    TotalRecordCount: values.length,
  });
}
