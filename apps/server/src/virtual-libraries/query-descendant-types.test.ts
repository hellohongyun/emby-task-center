import { expect, it, vi } from "vitest";
import { queryScope } from "./query-scope";
import { listBody, parameter, result, type Item, type QueryUpstream, type VirtualQueryStore } from "./query-helpers";

const series: Item = { Id: "show", Type: "Series", Name: "Original title", ImageTags: { Primary: "poster" } };
const video: Item = { Id: "bonus", Type: "Video", SeriesId: "show" };
const episodes: Item[] = Array.from({ length: 1000 }, (_, index) => ({
  Id: `episode-${index}`,
  Type: "Episode",
  SeriesId: "merged-alias",
  UserData: { Played: false },
}));

function fixture(legacy = false) {
  const store: VirtualQueryStore = {
    list: () => [],
    get: () => undefined,
    listItems: () =>
      [series, ...(legacy ? [{ Id: "folder", Type: "Folder" }] : [])].map((item) => ({
        itemId: item.Id!,
        type: String(item.Type),
        name: "",
        year: null,
        imageTag: null,
      })),
  };
  const childCalls: URL[] = [];
  let returnedChildren = 0;
  const upstream = vi.fn<QueryUpstream>().mockImplementation(async (url) => {
    const parent = parameter(url, "ParentId");
    let items = parent === "show" ? [...episodes, video] : parent ? [] : [series, ...episodes, video];
    const types = parameter(url, "IncludeItemTypes")
      ?.split(",")
      .map((type) => type.trim().toLowerCase());
    if (types) items = items.filter((item) => types.includes(String(item.Type).toLowerCase()));
    const ids = parameter(url, "Ids")?.split(",");
    if (ids) items = items.filter((item) => ids.includes(item.Id!));
    const total = items.length;
    const start = Number(parameter(url, "StartIndex") ?? 0);
    items = items.slice(start, start + Number(parameter(url, "Limit") ?? 200));
    if (parent) {
      childCalls.push(new URL(url));
      returnedChildren += items.length;
    }
    return result({ Items: items, TotalRecordCount: total });
  });
  return { store, upstream, childCalls, returnedChildren: () => returnedChildren };
}

it("filters SenPlayer descendant discovery while retaining legitimate Video children and source filters", async () => {
  const f = fixture();
  const types = "Series,Movie,Video,MusicVideo,MusicAlbum";
  const reply = await queryScope(
    f.store,
    "virtual",
    new URL(
      `http://emby/Users/u/Items?ParentId=virtual&Recursive=true&IncludeItemTypes=${types}&Limit=20&IsPlayed=false&SortBy=DateLastContentAdded,DateCreated,SortName`,
    ),
    f.upstream,
  );
  expect(listBody(reply.body).Items).toEqual([series, video]);
  expect(f.childCalls).toHaveLength(1);
  expect(f.returnedChildren()).toBe(1);
  expect(parameter(f.childCalls[0], "IncludeItemTypes")).toBe(types);
  expect(parameter(f.childCalls[0], "IsPlayed")).toBeUndefined();
  const final = f.upstream.mock.calls.at(-1)![0];
  expect(parameter(final, "IsPlayed")).toBe("false");
  expect(parameter(final, "SortBy")).toBe("DateLastContentAdded,DateCreated,SortName");
});

it("keeps all requested Episode descendants", async () => {
  const f = fixture();
  const reply = await queryScope(
    f.store,
    "virtual",
    new URL("http://emby/Users/u/Items?ParentId=virtual&Recursive=true&IncludeItemTypes=Episode"),
    f.upstream,
  );
  expect(listBody(reply.body).TotalRecordCount).toBe(1000);
  expect(f.returnedChildren()).toBe(1000);
});

it("keeps unfiltered recursive expansion unchanged", async () => {
  const f = fixture();
  const reply = await queryScope(
    f.store,
    "virtual",
    new URL("http://emby/Users/u/Items?ParentId=virtual&Recursive=true"),
    f.upstream,
  );
  expect(listBody(reply.body).TotalRecordCount).toBe(1002);
  expect(f.returnedChildren()).toBe(1001);
  expect(parameter(f.childCalls[0], "IncludeItemTypes")).toBeUndefined();
});

it("keeps Latest parent grouping and original posters despite merged SeriesId aliases", async () => {
  const f = fixture(true);
  const reply = await queryScope(
    f.store,
    "virtual",
    new URL("http://emby/Users/u/Items/Latest?ParentId=virtual&IncludeItemTypes=Episode&Limit=20"),
    f.upstream,
  );
  expect(reply.body).toEqual([series]);
  expect(parameter(f.childCalls[0], "IncludeItemTypes")).toBe("Episode");
});
