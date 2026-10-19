import { describe, expect, it, vi } from "vitest";
import { parameter, result, type Item, type QueryUpstream, type VirtualQueryStore } from "./query-helpers";
import { queryScope } from "./query-scope";

const roots: Item[] = [
  { Id: "merged-a", Name: "整部剧", Type: "Series", ImageTags: { Primary: "poster-a" }, DateCreated: "2020-01-01" },
  { Id: "merged-b", Name: "整部剧", Type: "Series", ImageTags: { Primary: "poster-b" }, DateCreated: "2020-01-01" },
  { Id: "movie", Name: "电影", Type: "Movie", ImageTags: { Primary: "movie-poster" }, DateCreated: "2026-01-01" },
];
const episodes: Item[] = roots.slice(0, 2).map((root, i) => ({
  Id: `episode-${i}`,
  Name: `第 ${i + 1} 集`,
  Type: "Episode",
  SeriesId: `source-alias-${i}`,
  ImageTags: { Primary: `video-frame-${i}` },
  DateCreated: `2026-03-0${i + 1}`,
  UserData: { PlaybackPositionTicks: 100 },
  originalParent: root.Id,
}));
const store: VirtualQueryStore = {
  list: () => [],
  get: () => undefined,
  listItems: () =>
    roots.map((root) => ({
      itemId: root.Id!,
      name: String(root.Name),
      type: String(root.Type),
      year: null,
      imageTag: null,
    })),
};
const legacyStore: VirtualQueryStore = {
  ...store,
  listItems: () => [
    ...store.listItems("virtual"),
    { itemId: "legacy", name: "旧目录", type: "Folder", year: null, imageTag: null },
  ],
};
function fixture() {
  const calls: URL[] = [];
  const upstream = vi.fn<QueryUpstream>().mockImplementation(async (source) => {
    const url = new URL(source);
    calls.push(url);
    const parent = parameter(url, "ParentId");
    let items = parent ? episodes.filter((item) => item.originalParent === parent) : [...roots, ...episodes];
    const ids = parameter(url, "Ids")?.split(",");
    const types = parameter(url, "IncludeItemTypes")?.split(",");
    if (ids) items = items.filter((item) => ids.includes(item.Id!));
    if (types) items = items.filter((item) => types.includes(String(item.Type)));
    if (parameter(url, "Filters")?.includes("IsResumable")) items = items.filter((item) => item.Type === "Episode");
    const start = Number(parameter(url, "StartIndex") ?? 0);
    const limit = Number(parameter(url, "Limit") ?? 200);
    return result({ Items: items.slice(start, start + limit), TotalRecordCount: items.length });
  });
  return { calls, upstream };
}

describe("virtual library latest whole-work content", () => {
  it("groups source-alias SeriesId through the actual mapped parent and keeps original series DTOs", async () => {
    const { upstream } = fixture();
    const reply = await queryScope(
      legacyStore,
      "virtual",
      new URL("http://emby/Users/u/Items/Latest?ParentId=virtual"),
      upstream,
    );
    expect(reply.body).toEqual([roots[1], roots[0], roots[2]]);
    expect((reply.body as Item[]).every((item) => item.Type !== "Episode")).toBe(true);
  });

  it("hydrates only matched original parents when Latest filters out Series metadata", async () => {
    const { upstream, calls } = fixture();
    const reply = await queryScope(
      legacyStore,
      "virtual",
      new URL(
        "http://emby/Users/u/Items/Latest?ParentId=virtual&IncludeItemTypes=Episode&Fields=Overview&ImageTypeLimit=1&EnableUserData=true&UserId=u&api_key=client&Limit=1",
      ),
      upstream,
    );
    expect(reply.body).toEqual([roots[1]]);
    const hydration = calls.filter((url) => parameter(url, "IncludeItemTypes") === "Series");
    expect(hydration).toHaveLength(1);
    expect(Object.fromEntries(hydration[0].searchParams)).toMatchObject({
      Ids: "merged-b,merged-a",
      UserId: "u",
      api_key: "client",
      Fields: "Overview",
      ImageTypeLimit: "1",
      EnableUserData: "true",
    });
    expect(hydration[0].searchParams.has("ParentId")).toBe(false);
  });

  it("keeps explicit ungrouped Latest episodes and their original images", async () => {
    const { upstream, calls } = fixture();
    const reply = await queryScope(
      store,
      "virtual",
      new URL("http://emby/Users/u/Items/Latest?ParentId=virtual&IncludeItemTypes=Episode&GroupItems=false"),
      upstream,
    );
    expect(reply.body).toEqual([episodes[1], episodes[0]]);
    expect(calls.some((url) => parameter(url, "IncludeItemTypes") === "Series")).toBe(false);
  });

  it("does not regroup explicit Episode lists or Resume", async () => {
    for (const path of [
      "/Items?Recursive=true&IncludeItemTypes=Episode",
      "/Users/u/Items/Resume?IncludeItemTypes=Episode",
    ]) {
      const { upstream } = fixture();
      const url = new URL(`http://emby${path}`);
      url.searchParams.set("ParentId", "virtual");
      const reply = await queryScope(store, "virtual", url, upstream);
      expect(reply.body).toMatchObject({ Items: expect.arrayContaining(episodes) });
    }
  });
});
