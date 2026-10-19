import { describe, expect, it, vi } from "vitest";
import { facetQuery } from "./query-facets";
import { listBody, parameter, result, type Item, type QueryUpstream, type VirtualQueryStore } from "./query-helpers";
import { queryScope } from "./query-scope";

const series = ["a", "b"].map((Id) => ({
  Id,
  Name: Id,
  Type: "Series",
  Genres: ["动画"],
  GenreItems: [{ Name: "动画", Id: "animation" }],
  ProductionYear: 2023,
}));
const seasons = series.map((item) => ({ Id: `${item.Id}-season`, SeriesId: item.Id, Type: "Season" }));
const episodes = series.flatMap((item) =>
  Array.from({ length: 600 }, (_, index) => ({
    Id: `${item.Id}-${index}`,
    SeriesId: item.Id,
    Type: "Episode",
    Genres: ["分集分类"],
    UserData: { PlaybackPositionTicks: 100 },
  })),
);

function store(entries = series): VirtualQueryStore {
  return {
    list: () => [],
    get: () => undefined,
    listItems: () =>
      entries.map((item) => ({ itemId: item.Id, name: item.Name, type: item.Type, year: null, imageTag: null })),
  };
}

function upstreamItems(extra: Item[] = []) {
  const calls: URL[] = [];
  const handler = vi.fn<QueryUpstream>().mockImplementation(async (source) => {
    const url = new URL(source);
    calls.push(url);
    const parent = parameter(url, "ParentId");
    const ids = parameter(url, "Ids")?.split(",");
    const types = parameter(url, "IncludeItemTypes")?.toLowerCase().split(",");
    let items: Item[] = [...series, ...seasons, ...episodes, ...extra];
    if (/NextUp$/.test(url.pathname)) items = episodes.filter((item) => item.SeriesId === parent).slice(0, 1);
    else if (parent === "folder") items = [series[0], seasons[0], ...episodes.slice(0, 600)];
    else if (parent) items = [...seasons, ...episodes].filter((item) => item.SeriesId === parent);
    if (ids) items = items.filter((item) => ids.includes(item.Id!));
    if (types) items = items.filter((item) => types.includes(String(item.Type).toLowerCase()));
    const start = Number(parameter(url, "StartIndex") ?? 0);
    const limit = Number(parameter(url, "Limit") ?? items.length);
    return result({ Items: items.slice(start, start + limit), TotalRecordCount: items.length });
  });
  return { handler, calls };
}

const url = (path: string) => new URL(path, "http://emby");
const scope = (path: string, upstream: QueryUpstream, db = store()) => queryScope(db, "virtual", url(path), upstream);

describe("virtual library query scope performance", () => {
  it("reads recursive Series lists once regardless of 1200 mapped descendant episodes", async () => {
    const { handler, calls } = upstreamItems();
    const response = await scope(
      "/Users/u/Items?ParentId=virtual&Recursive=true&IncludeItemTypes=Series&SortBy=SortName&SortOrder=Descending&StartIndex=1&Limit=1&Filters=IsFavorite&Fields=Overview&UserId=u&api_key=user-key",
      handler,
    );
    expect(listBody(response.body)).toMatchObject({ Items: [series[1]], TotalRecordCount: 2 });
    expect(calls).toHaveLength(1);
    expect(Object.fromEntries(calls[0].searchParams)).toMatchObject({
      Ids: "a,b",
      Recursive: "true",
      IncludeItemTypes: "Series",
      SortBy: "SortName",
      SortOrder: "Descending",
      StartIndex: "1",
      Limit: "1",
      Filters: "IsFavorite",
      Fields: "Overview",
      UserId: "u",
      api_key: "user-key",
    });
    expect(calls[0].searchParams.has("ParentId")).toBe(false);
  });

  it.each(["Filters", "Filters2", "Genres", "Studios", "Tags", "Years"])(
    "reads %s once from whole-work metadata without loading descendants",
    async (facet) => {
      const { handler, calls } = upstreamItems();
      const path = /Filters/.test(facet) ? `/Items/${facet}` : `/${facet}`;
      const response = await facetQuery(store(), "virtual", url(`${path}?ParentId=virtual&UserId=u`), handler);
      expect(calls).toHaveLength(1);
      expect(calls[0].searchParams.get("IncludeItemTypes")).toBe("Series");
      expect(calls[0].searchParams.get("Ids")).toBe("a,b");
      expect(calls[0].searchParams.has("ParentId")).toBe(false);
      if (facet === "Filters2") {
        expect(response.body).toMatchObject({ Genres: [{ Name: "动画", Id: "animation" }], Years: [2023] });
      }
    },
  );

  it.each(["Movie", "movie, SERIES"])("keeps mixed work scope and explicit Ids for %s", async (type) => {
    const movie = { ...series[0], Id: "movie", Type: "Movie" };
    const { handler, calls } = upstreamItems([movie]);
    const response = await scope(
      `/Items?ParentId=virtual&recursive=true&includeitemtypes=${type}&Ids=movie,outside`,
      handler,
      store([...series, movie]),
    );
    expect(listBody(response.body).Items).toEqual([movie]);
    expect(calls).toHaveLength(1);
    expect(calls[0].searchParams.get("Ids")).toBe("movie");
    expect(calls[0].searchParams.has("ParentId")).toBe(false);
    expect(parameter(calls[0], "IncludeItemTypes")).toBe(type);
  });

  it.each(["Episode", "Season"])("still expands descendants for explicit %s queries", async (type) => {
    const { handler, calls } = upstreamItems();
    const response = await scope(`/Items?ParentId=virtual&Recursive=true&IncludeItemTypes=${type}`, handler);
    expect(listBody(response.body).TotalRecordCount).toBe(type === "Episode" ? 1200 : 2);
    expect(calls.some((call) => call.searchParams.get("ParentId") === "a")).toBe(true);
    expect(calls.some((call) => call.searchParams.get("ParentId") === "b")).toBe(true);
    expect(calls.every((call) => call.searchParams.get("ParentId") !== "virtual")).toBe(true);
  });

  it("preserves legacy container descendants even when only Series are requested", async () => {
    const { handler, calls } = upstreamItems();
    const db = store([{ ...series[0], Id: "folder", Type: "Folder" }]);
    const response = await scope("/Items?ParentId=virtual&Recursive=true&IncludeItemTypes=Series", handler, db);
    expect(listBody(response.body).Items).toEqual([series[0]]);
    expect(calls[0].searchParams.get("ParentId")).toBe("folder");
  });

  it("keeps descendant facets for legacy containers", async () => {
    const { handler, calls } = upstreamItems();
    const db = store([{ ...series[0], Id: "folder", Type: "Folder" }]);
    const response = await facetQuery(db, "virtual", url("/Items/Filters2?ParentId=virtual"), handler);
    expect(response.body).toMatchObject({
      Genres: expect.arrayContaining([
        { Name: "分集分类", Id: "分集分类" },
        { Name: "动画", Id: "animation" },
      ]),
    });
    expect(calls[0].searchParams.get("ParentId")).toBe("folder");
    expect(calls.every((call) => !call.searchParams.has("IncludeItemTypes"))).toBe(true);
  });

  it("keeps complete episode statistics for Counts without a type filter", async () => {
    const { handler, calls } = upstreamItems();
    const response = await facetQuery(store(), "virtual", url("/Items/Counts?ParentId=virtual"), handler);
    expect(response.body).toMatchObject({ SeriesCount: 2, EpisodeCount: 1200, ItemCount: 1204 });
    expect(calls.some((call) => call.searchParams.has("ParentId"))).toBe(true);
  });

  it("uses the work fast path for explicitly filtered Counts", async () => {
    const { handler, calls } = upstreamItems();
    const response = await facetQuery(
      store(),
      "virtual",
      url("/Items/Counts?ParentId=virtual&IncludeItemTypes=Series"),
      handler,
    );
    expect(response.body).toMatchObject({ SeriesCount: 2, EpisodeCount: 0, ItemCount: 2 });
    expect(calls).toHaveLength(1);
  });

  it("queries NextUp directly by original parents even with Recursive=true", async () => {
    const { handler, calls } = upstreamItems();
    const response = await scope("/Shows/NextUp?ParentId=virtual&UserId=u&Recursive=true", handler);
    expect(listBody(response.body).Items.map((item) => item.Id)).toEqual(["a-0", "b-0"]);
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.pathname === "/Shows/NextUp")).toBe(true);
    expect(calls.map((call) => call.searchParams.get("ParentId"))).toEqual(["a", "b"]);
  });

  it.each(["Resume"])("retains descendant expansion for %s", async (path) => {
    const { handler, calls } = upstreamItems();
    await scope(`/Users/u/Items/${path}?ParentId=virtual&IncludeItemTypes=Series`, handler);
    expect(calls[0].searchParams.get("ParentId")).toBe("a");
    expect(calls.some((call) => call.searchParams.get("ParentId") === "b")).toBe(true);
  });

  it("reads grouped Latest from whole-work IDs without expanding descendants", async () => {
    const { handler, calls } = upstreamItems();
    const response = await scope("/Users/u/Items/Latest?ParentId=virtual&IncludeItemTypes=Episode", handler);
    expect(response.body).toEqual(series);
    expect(calls).toHaveLength(1);
    expect(calls[0].searchParams.get("IncludeItemTypes")).toBe("Series");
    expect(calls[0].searchParams.get("Ids")).toBe("a,b");
    expect(calls[0].searchParams.has("ParentId")).toBe(false);
  });

  it("bounds grouped Latest work queries for 113 mappings instead of scanning each show's episodes", async () => {
    const many = Array.from({ length: 113 }, (_, i) => ({ ...series[0], Id: `show-${i}`, Name: `show-${i}` }));
    const { handler, calls } = upstreamItems(many);
    const response = await scope(
      "/Users/u/Items/Latest?ParentId=virtual&Limit=20&IncludeItemTypes=Episode",
      handler,
      store(many),
    );
    expect(response.body).toHaveLength(20);
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => !call.searchParams.has("ParentId"))).toBe(true);
    expect(calls.every((call) => call.searchParams.get("IncludeItemTypes") === "Series")).toBe(true);
    expect(calls.reduce((count, call) => count + call.searchParams.get("Ids")!.split(",").length, 0)).toBe(113);
  });

  it("leaves ordinary non-recursive scope queries unchanged", async () => {
    const { handler, calls } = upstreamItems();
    const response = await scope("/Users/u/Items?ParentId=virtual&Limit=20", handler);
    expect(listBody(response.body).Items).toEqual(series);
    expect(calls).toHaveLength(1);
    expect(calls[0].searchParams.get("Ids")).toBe("a,b");
    expect(calls[0].searchParams.has("IncludeItemTypes")).toBe(false);
  });
});
