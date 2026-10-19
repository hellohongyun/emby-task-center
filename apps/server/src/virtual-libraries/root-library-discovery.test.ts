import { describe, expect, it, vi } from "vitest";
import { isRootLibraryDiscovery, rootLibraryDiscovery } from "./root-library-discovery";
import { result, type QueryUpstream, type VirtualQueryStore } from "./query-helpers";

const library = {
  id: "owned",
  name: "精选电影",
  collectionType: "movies" as const,
  itemCount: 1,
  sortOrder: 0,
  createdAt: "2026-10-19T00:00:00Z",
  updatedAt: "2026-10-19T00:00:00Z",
};
const store: VirtualQueryStore = {
  list: () => [library],
  get: (id) => (id === library.id ? library : undefined),
  listItems: () => [],
};
const original = [
  { Id: "native", Type: "CollectionFolder", ServerId: "server", Extension: { keep: true } },
  { Id: "ttd", Type: "CollectionFolder", Guid: "ttd-guid", ImageTags: { Primary: "ttd" }, Ttd: ["opaque"] },
];
const actualPath = "/Users/alice/Items?ExcludeItemTypes=Audio,Book,MusicVideo,Game,MusicAlbum,Photo";
const url = (path: string) => new URL(path, "http://proxy");
const reply = () => ({
  ...result({ Items: structuredClone(original), TotalRecordCount: 2, Opaque: "keep" }),
  raw: Buffer.from("original"),
});
const upstream = () => vi.fn<QueryUpstream>().mockResolvedValue(result({ Configuration: {} }));

describe("confirmed root library discovery", () => {
  it("appends owned libraries to the actual player request while retaining upstream fields and order", async () => {
    const query = url(actualPath);
    const before = query.href;
    const source = reply();
    const fetch = upstream();
    const output = await rootLibraryDiscovery({ url: query, store, upstream: fetch, reply: source });
    expect(output.body).toEqual({
      Items: [...original, expect.objectContaining({ Id: "owned", Type: "CollectionFolder", ServerId: "server" })],
      TotalRecordCount: 3,
      Opaque: "keep",
    });
    expect(source.body).toEqual({ Items: original, TotalRecordCount: 2, Opaque: "keep" });
    expect(query.href).toBe(before);
    expect(output.raw).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0].pathname).toBe("/Users/alice");
  });

  it.each([
    actualPath,
    "/Items?UserId=alice&ExcludeItemTypes=Audio",
    "/users/alice/items?recursive=FALSE&IsFolder=true",
    "/Users/alice/Items?IncludeItemTypes=CollectionFolder&Fields=Path&SortBy=Name&SortOrder=Ascending&Limit=100",
  ])("accepts user-scoped library candidate %s", async (path) => {
    expect(isRootLibraryDiscovery(url(path))).toBe(true);
    const output = await rootLibraryDiscovery({ url: url(path), store, upstream: upstream(), reply: reply() });
    expect((output.body as { Items: { Id: string }[] }).Items.map((item) => item.Id)).toEqual([
      "native",
      "ttd",
      "owned",
    ]);
  });

  it.each([
    "/Items",
    "/Users/alice/Items",
    "/Items?UserId=alice",
    "/users/alice/items?recursive=FALSE",
    "/Items?UserId=",
    "/Users/alice/Views",
    "/Users/alice/Items?ParentId=",
    "/Users/alice/Items?ParentId=native",
    "/Users/alice/Items?Ids=",
    "/Users/alice/Items?Ids=native",
    "/Users/alice/Items?Recursive=true",
    "/Users/alice/Items?Recursive=",
    "/Users/alice/Items?SearchTerm=film",
    "/Users/alice/Items?Genres=Animation",
    "/Users/alice/Items?Filters=IsFavorite",
    "/Users/alice/Items?MediaTypes=Video",
    "/Users/alice/Items?IsFolder=false",
    "/Users/alice/Items?IncludeItemTypes=Movie",
    "/Users/alice/Items?IncludeItemTypes=Folder",
    "/Users/alice/Items?IncludeItemTypes=Folder,Movie",
    "/Users/alice/Items?ExcludeItemTypes=CollectionFolder",
    "/Users/alice/Items?ExcludeItemTypes=Folder",
    "/Users/alice/Items?ExcludeItemTypes=Audio,COLLECTIONFOLDER",
    "/Users/alice/Items?Recursive=false&recursive=true",
    "/Users/alice/Items?ExcludeItemTypes=Audio&excludeitemtypes=CollectionFolder",
  ])("leaves searches, explicit scopes and incompatible filters untouched: %s", async (path) => {
    const source = reply();
    const fetch = upstream();
    expect(isRootLibraryDiscovery(url(path))).toBe(false);
    expect(await rootLibraryDiscovery({ url: url(path), store, upstream: fetch, reply: source })).toBe(source);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    result({ Items: [], TotalRecordCount: 0 }),
    result({ Items: [{ Id: "movie", Type: "Movie" }] }),
    result({ Items: [original[0], { Id: "episode", Type: "Episode" }] }),
    result({ Items: [null] }),
    result({ Items: "unknown" }),
    result(original),
    { ...reply(), status: 401 },
    { ...reply(), status: 500 },
  ])("does not infer library discovery from empty, media, malformed or failed responses", async (source) => {
    const fetch = upstream();
    expect(await rootLibraryDiscovery({ url: url(actualPath), store, upstream: fetch, reply: source })).toBe(source);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps upstream paging intact and fills only available capacity", async () => {
    const source = reply();
    const output = await rootLibraryDiscovery({
      url: url(`${actualPath}&Limit=2&StartIndex=0`),
      store,
      upstream: upstream(),
      reply: source,
    });
    expect(output.body).toEqual({ Items: original, TotalRecordCount: 3, Opaque: "keep" });
  });

  it("applies user hiding only to the owned addition", async () => {
    const fetch = vi
      .fn<QueryUpstream>()
      .mockResolvedValue(result({ Configuration: { MyMediaExcludes: ["owned", "ttd"] } }));
    const source = reply();
    expect(await rootLibraryDiscovery({ url: url(actualPath), store, upstream: fetch, reply: source })).toBe(source);
  });
});
