import { describe, expect, it, vi } from "vitest";
import { discoveryItems } from "./discovery-items";
import { parameter, result, type Item, type QueryUpstream, type VirtualQueryStore } from "./query-helpers";

const library = {
  id: "virtual",
  name: "精选电影",
  collectionType: "movies" as const,
  itemCount: 0,
  sortOrder: 0,
  createdAt: "2026-10-19T00:00:00Z",
  updatedAt: "2026-10-19T00:00:00Z",
};
const store: VirtualQueryStore = {
  list: () => [library],
  get: (id) => (id === library.id ? library : undefined),
  listItems: () => [],
};
const real = [
  { Id: "real-a", Name: "A", Type: "CollectionFolder", ServerId: "server" },
  { Id: "real-b", Name: "B", Type: "CollectionFolder", ServerId: "server" },
];
function fixture(items: Item[] = real, pageSize = 200) {
  return vi.fn<QueryUpstream>().mockImplementation(async (url) => {
    if (/^\/Users\/[^/]+$/.test(url.pathname)) return result({ Configuration: {} });
    const ids = parameter(url, "Ids")?.split(",");
    const search = parameter(url, "SearchTerm")?.toLocaleLowerCase();
    const types = parameter(url, "IncludeItemTypes")?.toLowerCase().split(",");
    const selected = items.filter(
      (item) =>
        (!ids || ids.includes(item.Id!)) &&
        (!search || String(item.Name).toLocaleLowerCase().includes(search)) &&
        (!types || types.includes(String(item.Type).toLowerCase())),
    );
    const start = Number(parameter(url, "StartIndex") ?? 0);
    const limit = Math.min(pageSize, Number(parameter(url, "Limit") ?? pageSize));
    return result({ Items: selected.slice(start, start + limit), TotalRecordCount: selected.length });
  });
}
async function run(path: string, upstream: QueryUpstream) {
  return discoveryItems({ url: new URL(path, "http://proxy"), store, upstream });
}
function body(response: Awaited<ReturnType<typeof run>>) {
  return response?.body as { Items: Item[]; TotalRecordCount: number; StartIndex: number };
}

describe("virtual library discovery endpoints", () => {
  it("does not read the virtual library store for ordinary GET endpoints", async () => {
    const list = vi.fn(store.list);
    const upstream = fixture();
    for (const path of ["/Videos/real/stream", "/Items/real/Images/Primary", "/web/index.html", "/Items"])
      expect(
        await discoveryItems({ url: new URL(path, "http://proxy"), store: { ...store, list }, upstream }),
      ).toBeUndefined();
    expect(list).not.toHaveBeenCalled();
    expect(upstream).not.toHaveBeenCalled();
  });

  it("keeps explicit parent scope untouched even when requested IDs contain a virtual library", async () => {
    const list = vi.fn(store.list);
    const upstream = fixture();
    for (const parent of ["real-parent", "virtual"])
      expect(
        await discoveryItems({
          url: new URL(`/Users/u/Items?Ids=virtual,real-a&parentid=${parent}`, "http://proxy"),
          store: { ...store, list },
          upstream,
        }),
      ).toBeUndefined();
    expect(list).not.toHaveBeenCalled();
    expect(upstream).not.toHaveBeenCalled();
  });

  it.each(["/Items?Ids=real-a", "/Library/VirtualFolders", "/Library/VirtualFolders/Query", "/Items?ParentId=real-a"])(
    "does not touch unrelated discovery request %s",
    async (path) => {
      const upstream = fixture();
      expect(await run(path, upstream)).toBeUndefined();
      expect(upstream).not.toHaveBeenCalled();
    },
  );

  it("keeps MediaFolders upstream page and fills only unused capacity", async () => {
    const upstream = fixture(real, 1);
    const output = body(await run("/Library/MediaFolders?StartIndex=1&Limit=2", upstream));
    expect(output.Items.map((item) => item.Id)).toEqual(["real-b", "virtual"]);
    expect(output.TotalRecordCount).toBe(3);
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(parameter(upstream.mock.calls[0][0], "StartIndex")).toBe("1");
    expect(output.Items[0]).toEqual(real[1]);
    expect(output.Items[1]).toMatchObject({
      Type: "CollectionFolder",
      ServerId: "server",
      Subviews: expect.any(Array),
    });
  });

  it("includes matching virtual folders after an empty upstream search result", async () => {
    const output = body(
      await run("/library/mediafolders?searchterm=精选&IncludeItemTypes=collectionfolder", fixture()),
    );
    expect(output.Items.map((item) => item.Id)).toEqual(["virtual"]);
    expect(output.TotalRecordCount).toBe(1);
    expect(body(await run("/Library/MediaFolders?IncludeItemTypes=Movie", fixture())).Items).toEqual([]);
  });

  it("removes only owned IDs while preserving upstream pagination", async () => {
    const upstream = fixture();
    const output = body(await run("/users/u/items?ids=virtual,real-b,real-a&startindex=1&limit=1", upstream));
    expect(output.Items).toEqual([real[1]]);
    expect(output.TotalRecordCount).toBe(3);
    expect(parameter(upstream.mock.calls[0][0], "Ids")).toBe("real-b,real-a");
    expect(parameter(upstream.mock.calls[0][0], "Limit")).toBe("1");
    expect(parameter(upstream.mock.calls[0][0], "StartIndex")).toBe("1");
  });

  it("authenticates virtual-only queries without submitting an empty Ids query", async () => {
    const upstream = fixture();
    const output = body(await run("/Users/u/Items?Ids=virtual&api_key=client-token", upstream));
    expect(output.Items.map((item) => item.Id)).toEqual(["virtual"]);
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(parameter(upstream.mock.calls[0][0], "Ids")).toBeUndefined();
    expect(parameter(upstream.mock.calls[0][0], "Limit")).toBe("1");
    expect(parameter(upstream.mock.calls[0][0], "api_key")).toBe("client-token");
  });

  it.each(["/Items?Ids=virtual", "/Items?Ids=virtual,real-a", "/Library/MediaFolders"])(
    "preserves the upstream unauthorized response for %s",
    async (path) => {
      const failure = { status: 401, headers: { "www-authenticate": "Emby" }, body: { error: "unauthorized" } };
      const upstream = vi.fn<QueryUpstream>().mockResolvedValue(failure);
      expect(await run(path, upstream)).toBe(failure);
      expect(upstream).toHaveBeenCalledTimes(1);
    },
  );

  it("preserves opaque upstream results without guessing unknown ID ownership", async () => {
    const unexpected = Array.from({ length: 25 }, (_, index) => ({ Id: `unrelated-${index}`, Type: "Movie" }));
    const upstream = vi.fn<QueryUpstream>().mockResolvedValue(result({ Items: unexpected, TotalRecordCount: 50_000 }));
    const output = body(await run("/Items?Ids=missing,virtual", upstream));
    expect(output.Items).toEqual([...unexpected, expect.objectContaining({ Id: "virtual" })]);
    expect(output.TotalRecordCount).toBe(50_001);
    expect(parameter(upstream.mock.calls[0][0], "Ids")).toBe("missing");
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it("preserves Guid aliases and opaque TTD results alongside owned additions", async () => {
    const guid = "12345678-1234-1234-1234-123456789abc";
    const expected = { Id: "123", Guid: guid, Name: "A" };
    const upstream = vi.fn<QueryUpstream>().mockResolvedValue(result({ Items: [expected, { Id: "outside" }] }));
    const output = body(await run(`/Items?Ids=virtual,${guid.replaceAll("-", "").toUpperCase()}`, upstream));
    expect(output.Items.map((item) => item.Id)).toEqual(["123", "outside", "virtual"]);
    expect(output.Items[0]).toEqual(expected);
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it("does not fetch extra pages of an upstream ID query", async () => {
    const upstream = fixture(real, 1);
    const output = body(await run("/Items?Ids=real-a,virtual,real-b", upstream));
    expect(output.Items.map((item) => item.Id)).toEqual(["real-a", "virtual"]);
    expect(output.TotalRecordCount).toBe(3);
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it("makes one request even when upstream pagination is opaque", async () => {
    const upstream = vi.fn<QueryUpstream>().mockResolvedValue(result({ Items: [real[0]], TotalRecordCount: 2 }));
    const output = body(await run("/Items?Ids=real-a,real-b,virtual", upstream));
    expect(output.Items.map((item) => item.Id)).toEqual(["real-a", "virtual"]);
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it("preserves filtering for real queries and filters virtual DTOs by name and type", async () => {
    const upstream = fixture();
    const output = body(
      await run("/Items?Ids=real-a,virtual&SearchTerm=A&IncludeItemTypes=CollectionFolder", upstream),
    );
    expect(output.Items).toEqual([real[0]]);
    expect(parameter(upstream.mock.calls[0][0], "SearchTerm")).toBe("A");
    const movieOnly = body(await run("/Items?Ids=virtual&IncludeItemTypes=Movie", fixture()));
    expect(movieOnly.Items).toEqual([]);
  });

  it("delegates MediaFolders sorting and paging unchanged", async () => {
    const output = body(await run("/Library/MediaFolders?SortBy=Name&SortOrder=Descending&Limit=1", fixture()));
    expect(output.Items).toEqual([real[0]]);
    expect(output.TotalRecordCount).toBe(3);
  });

  it("never hides or displaces upstream MediaFolders using local preferences", async () => {
    const upstream = fixture();
    const base = upstream.getMockImplementation()!;
    upstream.mockImplementation(async (url, timeout) =>
      /^\/Users\/u$/.test(url.pathname)
        ? result({ Configuration: { OrderedViews: ["virtual", "real-b", "real-a"], MyMediaExcludes: ["real-a"] } })
        : base(url, timeout),
    );
    const output = body(await run("/Library/MediaFolders?UserId=u&Limit=1", upstream));
    expect(output.Items).toEqual([real[0]]);
    expect(output.TotalRecordCount).toBe(3);
    expect(body(await run("/Library/MediaFolders?UserId=u&IncludeHidden=true", upstream)).TotalRecordCount).toBe(3);
  });

  it("recognizes a virtual GUID supplied in dashed uppercase form", async () => {
    const id = "12345678123412341234123456789abc";
    const guidStore: VirtualQueryStore = {
      ...store,
      list: () => [{ ...library, id }],
      get: (requested) => (requested === id ? { ...library, id } : undefined),
    };
    const upstream = fixture();
    const output = body(
      await discoveryItems({
        url: new URL("http://proxy/Items?Ids=12345678-1234-1234-1234-123456789ABC"),
        store: guidStore,
        upstream,
      }),
    );
    expect(output.Items.map((item) => item.Id)).toEqual([id]);
    expect(parameter(upstream.mock.calls[0][0], "Ids")).toBeUndefined();
  });
});
