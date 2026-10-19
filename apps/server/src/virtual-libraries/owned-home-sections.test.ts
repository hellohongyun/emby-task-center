import { describe, expect, it, vi } from "vitest";
import { appendOwnedHomeSections, ownedLatestSectionId } from "./owned-home-sections";
import { homeSectionItems } from "./home-sections";
import { parameter, result, type Item, type QueryUpstream, type VirtualQueryStore } from "./query-helpers";

const libraries = ["movies", "tvshows"].map((type, index) => ({
  id: `own-${index}`,
  name: `Library ${index}`,
  collectionType: type as "movies" | "tvshows",
  sortOrder: index,
  itemCount: 1,
  createdAt: "2026-10-19T00:00:00Z",
  updatedAt: "2026-10-19T00:00:00Z",
}));
const content = [
  { Id: "movie", Type: "Movie", Name: "Original movie", ImageTags: { Primary: "movie-poster" } },
  { Id: "series", Type: "Series", Name: "Original series", ImageTags: { Primary: "series-poster" } },
];
const store: VirtualQueryStore = {
  list: () => libraries,
  get: (id) => libraries.find((library) => library.id === id),
  listItems: (id) => {
    const item = content[id === "own-0" ? 0 : 1];
    return [{ itemId: item.Id, name: item.Name, type: item.Type, imageTag: null, year: null }];
  },
};
const original = [
  { Id: "media-row", SectionType: "userviews", PrivateExtension: { preserve: true } },
  { Id: "resume", SectionType: "resume" },
  {
    Id: "latestmedia_original",
    Name: "Original latest",
    SectionType: "latestmedia",
    CollectionType: "tvshows",
    Monitor: ["markplayed", "videoplayback"],
    ParentItem: { Id: "original", ServerId: "server" },
    ParentId: "original",
    Query: { StudioIds: ["private-studio"], TagIds: ["private-tag"], IsPlayed: false },
    Opaque: "unchanged",
  },
];
const url = new URL("http://proxy/Users/alice/HomeSections?displayMode=mobile,desktop&api_key=client");

function upstream(configuration: Record<string, unknown> = {}) {
  return vi.fn<QueryUpstream>().mockImplementation(async (request) => {
    if (request.pathname === "/Users/alice") return result({ Configuration: configuration });
    const requested = parameter(request, "Ids")?.split(",");
    const items = content.filter((item) => requested?.includes(item.Id));
    return result({ Items: items, TotalRecordCount: items.length });
  });
}

describe("owned Emby 4.10 latest-content home sections", () => {
  it("appends namespaced rows and leaves every upstream section object and field unchanged", async () => {
    const query = upstream({ OrderedViews: ["own-1", "own-0"], HidePlayedInLatest: true });
    const reply = { ...result(original), raw: Buffer.from("upstream bytes") };
    const response = await appendOwnedHomeSections({ url, store, upstream: query, reply });
    const rows = response.body as Item[];
    expect(rows.slice(0, original.length)).toEqual(original);
    original.forEach((section, index) => expect(rows[index]).toBe(section));
    expect(rows.slice(original.length).map((row) => row.Id)).toEqual([
      ownedLatestSectionId("own-1"),
      ownedLatestSectionId("own-0"),
    ]);
    expect(rows[3]).toMatchObject({
      SectionType: "latestmedia",
      CollectionType: "tvshows",
      ParentId: "own-1",
      ParentItem: { Id: "own-1", Type: "CollectionFolder", ServerId: "server" },
      Query: { StudioIds: [], TagIds: [], GenreIds: [], CollectionTypes: [], IsPlayed: false },
    });
    expect(JSON.stringify(rows.slice(3))).not.toContain("private-studio");
    expect(JSON.stringify(rows.slice(3))).not.toContain("private-tag");
    expect(response.raw).toBeUndefined();
    expect(query.mock.calls[0][0].pathname).toBe("/Users/alice");
    expect(Object.fromEntries(query.mock.calls[0][0].searchParams)).toEqual({ api_key: "client" });
    expect(query.mock.calls[0][1]).toBe(1_500);
    expect(url.searchParams.get("displayMode")).toBe("mobile,desktop");
  });

  it.each(["MyMediaExcludes", "LatestItemsExcludes"])("applies %s only to added rows", async (setting) => {
    const query = upstream({ [setting]: ["own-0", "original"] });
    const response = await appendOwnedHomeSections({ url, store, upstream: query, reply: result(original) });
    const rows = response.body as Item[];
    expect(rows.slice(0, 3)).toEqual(original);
    expect(rows.slice(3).map((row) => row.Id)).toEqual([ownedLatestSectionId("own-1")]);
  });

  it("does not duplicate already emitted rows", async () => {
    const query = upstream();
    const first = await appendOwnedHomeSections({ url, store, upstream: query, reply: result(original) });
    expect(await appendOwnedHomeSections({ url, store, upstream: query, reply: first })).toBe(first);
  });

  it.each([
    { status: 401, body: original },
    { status: 403, body: original },
    { status: 200, body: { Items: original } },
    { status: 200, body: null },
    { status: 200, body: [null, ...original] },
    { status: 200, body: original.slice(0, 2) },
    { status: 200, body: [] },
  ])("retains non-success, unknown or template-free replies exactly: %j", async ({ status, body }) => {
    const query = upstream();
    const reply = { status, body, headers: {}, raw: Buffer.from("original bytes") };
    expect(await appendOwnedHomeSections({ url, store, upstream: query, reply })).toBe(reply);
    expect(query).not.toHaveBeenCalled();
  });

  it.each([0, 1])("serves own section %i using existing mapped movie/whole-series latest queries", async (index) => {
    const query = upstream({ HidePlayedInLatest: true });
    const request = new URL(
      `http://proxy/Users/alice/Sections/${encodeURIComponent(ownedLatestSectionId(`own-${index}`))}/Items?Limit=8&Fields=Overview&api_key=client`,
    );
    const response = await homeSectionItems({ url: request, store, upstream: query });
    expect(response?.body).toEqual({ Items: [content[index]], TotalRecordCount: 1 });
    const itemsUrl = query.mock.calls.find(([target]) => target.pathname === "/Users/alice/Items")![0];
    expect(parameter(itemsUrl, "Ids")).toBe(content[index].Id);
    expect(parameter(itemsUrl, "ParentId")).toBeUndefined();
    expect(parameter(itemsUrl, "Fields")).toBe("Overview");
    expect(parameter(itemsUrl, "api_key")).toBe("client");
    expect(parameter(itemsUrl, "Limit")).toBe("8");
    expect(parameter(itemsUrl, "IsPlayed")).toBe("false");
    expect(query.mock.calls.every(([target]) => !target.pathname.includes("/Sections/"))).toBe(true);
    expect(query.mock.calls.every(([target]) => !parameter(target, "ParentId"))).toBe(true);
  });

  it("keeps original latestmedia and unknown owned-looking sections upstream", async () => {
    const query = upstream();
    for (const id of ["latestmedia_original", ownedLatestSectionId("deleted-library")]) {
      const request = new URL(`http://proxy/Users/alice/Sections/${encodeURIComponent(id)}/Items`);
      expect(await homeSectionItems({ url: request, store, upstream: query, homeSections: original })).toBeUndefined();
    }
    expect(query).not.toHaveBeenCalled();
  });

  it("does not turn denied own-content requests into successful rows", async () => {
    const query = upstream();
    query.mockResolvedValue({ status: 401, headers: {}, body: { error: "unauthorized" } });
    const request = new URL(
      `http://proxy/Users/alice/Sections/${encodeURIComponent(ownedLatestSectionId("own-1"))}/Items`,
    );
    await expect(homeSectionItems({ url: request, store, upstream: query })).rejects.toMatchObject({
      result: { status: 401, body: { error: "unauthorized" } },
    });
  });
});
