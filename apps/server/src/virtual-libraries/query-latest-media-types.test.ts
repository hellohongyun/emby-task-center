import { describe, expect, it, vi } from "vitest";
import { listBody, parameter, result, type Item, type QueryUpstream, type VirtualQueryStore } from "./query-helpers";
import { queryScope } from "./query-scope";

const movie: Item = {
  Id: "movie",
  Name: "Original movie",
  Type: "Movie",
  MediaType: "Video",
  ImageTags: { Primary: "original-movie-poster" },
};
const series: Item = {
  Id: "series",
  Name: "Original series",
  Type: "Series",
  ImageTags: { Primary: "original-series-poster" },
};
const episode: Item = {
  Id: "episode",
  Name: "Episode title",
  Type: "Episode",
  MediaType: "Video",
  SeriesId: "series",
  ImageTags: { Primary: "episode-frame" },
};
const store: VirtualQueryStore = {
  list: () => [],
  get: () => undefined,
  listItems: () =>
    [movie, series].map((item) => ({
      itemId: item.Id!,
      name: String(item.Name),
      type: String(item.Type),
      year: null,
      imageTag: null,
    })),
};
const values = (value?: string) => value?.split(",").map((entry) => entry.trim().toLowerCase());

function fixture() {
  const calls: URL[] = [];
  const upstream = vi.fn<QueryUpstream>().mockImplementation(async (source) => {
    const url = new URL(source);
    calls.push(url);
    const parent = parameter(url, "ParentId");
    let items = parent === "series" ? [episode] : parent ? [] : [movie, series, episode];
    const ids = parameter(url, "Ids")?.split(",");
    const types = values(parameter(url, "IncludeItemTypes"));
    const mediaTypes = values(parameter(url, "MediaTypes"));
    if (ids) items = items.filter((item) => ids.includes(item.Id!));
    if (types) items = items.filter((item) => types.includes(String(item.Type).toLowerCase()));
    // Real Emby Series containers lack MediaType, while Movie and Episode are Video.
    if (mediaTypes) items = items.filter((item) => mediaTypes.includes(String(item.MediaType).toLowerCase()));
    const start = Number(parameter(url, "StartIndex") ?? 0);
    const limit = Number(parameter(url, "Limit") ?? 200);
    return result({ Items: items.slice(start, start + limit), TotalRecordCount: items.length });
  });
  return { calls, upstream };
}

async function latest(query: string) {
  const fixtureData = fixture();
  const source = new URL(`http://emby/Users/u/Items/Latest?ParentId=virtual&${query}`);
  const reply = await queryScope(store, "virtual", source, fixtureData.upstream);
  return { ...fixtureData, source, reply };
}

describe("grouped latest video filters with Series containers", () => {
  it.each(["Video", "video", " Video "])("returns original movie and Series DTOs for MediaTypes=%s", async (type) => {
    const { calls, source, reply } = await latest(`GroupItems=true&MediaTypes=${encodeURIComponent(type)}&Limit=16`);
    expect(reply.body).toEqual([movie, series]);
    expect((reply.body as Item[])[1]).toBe(series);
    expect(calls).toHaveLength(1);
    expect(parameter(calls[0], "MediaTypes")).toBeUndefined();
    expect(values(parameter(calls[0], "IncludeItemTypes"))).toEqual(expect.arrayContaining(["movie", "series"]));
    expect(parameter(calls[0], "Ids")).toBe("movie,series");
    expect(parameter(source, "MediaTypes")).toBe(type);
  });

  it("retains the mapped Series poster when an Episode video request is grouped", async () => {
    const { reply, calls } = await latest("GroupItems=true&MediaTypes=Video&IncludeItemTypes=Episode");
    expect(reply.body).toEqual([series]);
    expect(parameter(calls[0], "IncludeItemTypes")).toBe("Series");
    expect(parameter(calls[0], "MediaTypes")).toBeUndefined();
  });

  it("continues applying Audio-only filters", async () => {
    const { reply, calls } = await latest("GroupItems=true&MediaTypes=Audio");
    expect(reply.body).toEqual([]);
    expect(parameter(calls[0], "MediaTypes")).toBe("Audio");
  });

  it("retains explicit ungrouped Episode video queries and their frame", async () => {
    const { reply, calls } = await latest("GroupItems=false&MediaTypes=Video&IncludeItemTypes=Episode");
    expect(reply.body).toEqual([episode]);
    const contentQueries = calls.filter((url) => parameter(url, "Ids"));
    expect(contentQueries).toHaveLength(1);
    expect(parameter(contentQueries[0], "MediaTypes")).toBe("Video");
    expect(parameter(contentQueries[0], "IncludeItemTypes")).toBe("Episode");
  });

  it("leaves MediaTypes unchanged for ordinary Series browsing", async () => {
    const { calls, upstream } = fixture();
    const source = new URL("http://emby/Users/u/Items?ParentId=virtual&IncludeItemTypes=Series&MediaTypes=Video");
    const reply = await queryScope(store, "virtual", source, upstream);
    expect(listBody(reply.body).Items).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(parameter(calls[0], "MediaTypes")).toBe("Video");
    expect(parameter(calls[0], "IncludeItemTypes")).toBe("Series");
  });
});
