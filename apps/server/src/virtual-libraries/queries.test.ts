import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { handleVirtualQuery } from "./queries";
import type { Item, QueryUpstream, VirtualQueryStore } from "./query-helpers";

const library = {
  id: "virtual",
  name: "精选",
  collectionType: "mixed" as const,
  itemCount: 2,
  sortOrder: 0,
  createdAt: "2026-10-17T00:00:00Z",
  updatedAt: "2026-10-17T00:00:00Z",
};
function store(entries: { itemId: string; type?: string }[] = [{ itemId: "a" }, { itemId: "b" }]): VirtualQueryStore {
  return {
    list: () => [{ ...library, itemCount: entries.length }],
    get: (id) => (id === library.id ? { ...library, itemCount: entries.length } : undefined),
    listItems: () =>
      entries.map((entry) => ({ name: entry.itemId, type: "Movie", year: null, imageTag: null, ...entry })),
  };
}
async function run(path: string, upstream: QueryUpstream, db = store(), method = "GET") {
  let body = "";
  const headers: Record<string, unknown> = {};
  const response = {
    statusCode: 0,
    setHeader: (key: string, value: unknown) => {
      headers[key] = value;
    },
    end: (value: string) => {
      body = value;
    },
  } as unknown as ServerResponse;
  const handled = await handleVirtualQuery({
    request: { method } as IncomingMessage,
    response,
    url: new URL(path, "http://localhost"),
    store: db,
    upstream,
  });
  return { handled, status: response.statusCode, body: body ? JSON.parse(body) : undefined, headers };
}
function upstreamItems(items: Item[], maxPage = 200) {
  const calls: URL[] = [];
  const handler = vi.fn<QueryUpstream>().mockImplementation(async (url) => {
    calls.push(new URL(url));
    const get = (key: string) => [...url.searchParams].find(([name]) => name.toLowerCase() === key.toLowerCase())?.[1];
    const ids = get("Ids")?.split(",");
    let selected = items.filter(
      (item) =>
        (!ids || ids.includes(item.Id!)) &&
        (!get("SearchTerm") || String(item.Name).includes(get("SearchTerm")!)) &&
        (!get("IncludeItemTypes") || get("IncludeItemTypes")!.split(",").includes(String(item.Type))) &&
        (!get("Filters")?.includes("IsResumable") ||
          Boolean((item.UserData as { PlaybackPositionTicks?: number })?.PlaybackPositionTicks)),
    );
    if (get("SortBy") === "SortName") selected = selected.sort((a, b) => String(a.Name).localeCompare(String(b.Name)));
    if (get("SortOrder") === "Descending") selected.reverse();
    const start = Number(get("StartIndex") || 0);
    const limit = Math.min(maxPage, Number(get("Limit") ?? 200));
    return {
      status: 200,
      headers: {},
      body: { Items: selected.slice(start, start + limit), TotalRecordCount: selected.length },
    };
  });
  return { handler, calls };
}

describe("virtual library Emby queries", () => {
  it("appends mixed virtual views while preserving original library DTOs", async () => {
    const original = { Id: "original", Name: "原库", ServerId: "server", CanDelete: true };
    const upstream = vi
      .fn<QueryUpstream>()
      .mockResolvedValue({ status: 200, headers: {}, body: { Items: [original], TotalRecordCount: 1 } });
    const response = await run("/Users/u/Views", upstream);
    expect(response.body.Items[0]).toEqual(original);
    expect(response.body.Items[1]).toMatchObject({
      Id: "virtual",
      Type: "CollectionFolder",
      CollectionType: null,
      ServerId: "server",
    });
    expect(response.body.Items[1]).not.toHaveProperty("CanDelete");
    expect(response.body.TotalRecordCount).toBe(2);
  });

  it("leaves unscoped top-level Items entirely upstream", async () => {
    const upstream = vi
      .fn<QueryUpstream>()
      .mockResolvedValue({ status: 200, headers: {}, body: { Items: [], TotalRecordCount: 4 } });
    const response = await run("/Users/u/Items?StartIndex=4&Limit=1", upstream);
    expect(response.handled).toBe(false);
    expect(upstream).not.toHaveBeenCalled();
  });

  it.each(["/Users/u/Items?ParentId=root", "/Users/u/Items?ParentId=original", "/Items?parentid=original&UserId=u"])(
    "leaves real parent query %s untouched with no extra upstream reads",
    async (path) => {
      const upstream = vi.fn<QueryUpstream>();
      expect((await run(path, upstream)).handled).toBe(false);
      expect(upstream).not.toHaveBeenCalled();
    },
  );

  it("uses original item IDs and passes all user filters, sorts and pagination upstream", async () => {
    const fixture = [
      { Id: "a", Name: "Alpha", Type: "Movie", CanDelete: true },
      { Id: "b", Name: "Beta", Type: "Movie" },
      { Id: "outside", Name: "Outside", Type: "Movie" },
    ];
    const { handler, calls } = upstreamItems(fixture);
    const response = await run(
      "/Users/u/Items?parentid=virtual&SortBy=SortName&SortOrder=Descending&Limit=1&StartIndex=1&IncludeItemTypes=Movie",
      handler,
    );
    expect(response.body.Items).toEqual([fixture[0]]);
    expect(response.body.TotalRecordCount).toBe(2);
    expect(calls[0].searchParams.has("parentid")).toBe(false);
    expect(calls[0].searchParams.get("Ids")).toBe("a,b");
    expect(calls[0].searchParams.get("IncludeItemTypes")).toBe("Movie");
    expect(calls[0].searchParams.get("SortOrder")).toBe("Descending");
  });

  it("authenticates empty libraries and never submits an empty Ids query", async () => {
    const { handler, calls } = upstreamItems([{ Id: "outside" }]);
    const response = await run("/Users/u/Items?ParentId=virtual", handler, store([]));
    expect(response.body).toMatchObject({ Items: [], TotalRecordCount: 0 });
    expect(calls).toHaveLength(1);
    expect(calls[0].searchParams.get("Limit")).toBe("1");
    expect(calls[0].searchParams.has("ParentId")).toBe(false);
    expect(calls[0].searchParams.has("Ids")).toBe(false);
  });

  it("intersects caller Ids and never widens an empty intersection", async () => {
    const { handler, calls } = upstreamItems([{ Id: "outside" }]);
    expect((await run("/Items?ParentId=virtual&Ids=outside", handler)).body.Items).toEqual([]);
    expect(calls[0].searchParams.get("Limit")).toBe("1");
  });

  it("reads every upstream page for large mappings before applying client pagination", async () => {
    const mapped = Array.from({ length: 173 }, (_, i) => ({ itemId: `item-${String(i).padStart(3, "0")}` }));
    const fixtures = mapped.map((entry) => ({ Id: entry.itemId, Name: entry.itemId, Type: "Movie" }));
    fixtures.splice(1, 0, { Id: "outside", Name: "item-000a", Type: "Movie" });
    const { handler, calls } = upstreamItems(fixtures, 7);
    const response = await run(
      "/Items?ParentId=virtual&SortBy=SortName&StartIndex=165&Limit=8",
      handler,
      store(mapped),
    );
    expect(response.body.Items.map((item: Item) => item.Id)).toEqual(mapped.slice(165).map((entry) => entry.itemId));
    expect(response.body.TotalRecordCount).toBe(173);
    expect(calls.length).toBeGreaterThan(1);
    expect(calls.every((url) => !url.searchParams.has("ParentId"))).toBe(true);
    expect(calls.every((url) => Boolean(url.searchParams.get("Ids")))).toBe(true);
  });

  it("expands mapped Series to original child IDs for recursive Episode and resume queries", async () => {
    const calls: URL[] = [];
    const episode = {
      Id: "episode",
      Name: "第一集",
      Type: "Episode",
      SeriesId: "series",
      UserData: { PlaybackPositionTicks: 100 },
    };
    const upstream = vi.fn<QueryUpstream>().mockImplementation(async (url) => {
      calls.push(new URL(url));
      const children = url.searchParams.get("ParentId") === "series";
      return {
        status: 200,
        headers: {},
        body: {
          Items: children || url.searchParams.get("Ids")?.includes("episode") ? [episode] : [],
          TotalRecordCount: 1,
        },
      };
    });
    const db = store([{ itemId: "series", type: "Series" }]);
    const response = await run("/Users/u/Items/Resume?ParentId=virtual&IncludeItemTypes=Episode", upstream, db);
    expect(response.body.Items).toEqual([episode]);
    expect(calls[0].searchParams.get("ParentId")).toBe("series");
    expect(calls[1].pathname).toBe("/Users/u/Items");
    expect(calls[1].searchParams.get("Filters")).toContain("IsResumable");
    expect(calls[1].searchParams.get("Ids")).toContain("episode");
    expect(calls.every((url) => url.searchParams.get("ParentId") !== "virtual")).toBe(true);
  });

  it("returns Latest arrays, scoped facets and a virtual detail without changing media IDs", async () => {
    const { handler } = upstreamItems([
      {
        Id: "a",
        Name: "A",
        Type: "Movie",
        Genres: ["剧情"],
        GenreItems: [{ Id: "genre", Name: "剧情" }],
        ProductionYear: 2025,
      },
    ]);
    expect((await run("/Users/u/Items/Latest?ParentId=virtual", handler)).body[0].Id).toBe("a");
    expect((await run("/Items/Filters2?ParentId=virtual", handler)).body).toMatchObject({
      Genres: [{ Id: "genre", Name: "剧情" }],
      Years: [2025],
    });
    expect((await run("/Users/u/Items/virtual", handler)).body).toMatchObject({ Id: "virtual", Name: "精选" });
  });

  it.each(["/Users/u/Views", "/Users/u/Items/virtual", "/Users/u/Items?ParentId=virtual"])(
    "preserves upstream authentication failures for %s",
    async (path) => {
      const upstream = vi
        .fn<QueryUpstream>()
        .mockResolvedValue({ status: 401, headers: { "www-authenticate": "Emby" }, body: { Message: "Unauthorized" } });
      const response = await run(path, upstream, store([]));
      expect(response.status).toBe(401);
      expect(response.headers["www-authenticate"]).toBe("Emby");
      expect(response.body).toEqual({ Message: "Unauthorized" });
    },
  );

  it("passes DELETE and all original media details to the transport unchanged", async () => {
    const upstream = vi.fn<QueryUpstream>();
    expect((await run("/Items/a", upstream, store(), "DELETE")).handled).toBe(false);
    expect((await run("/Users/u/Items/a", upstream)).handled).toBe(false);
    expect(upstream).not.toHaveBeenCalled();
  });

  it.each(["/Videos/a/stream?Static=true", "/Sessions", "/System/Info", "/Unknown?ParentId=original"])(
    "leaves unrelated endpoint %s to transparent transport",
    async (path) => {
      const upstream = vi.fn<QueryUpstream>();
      expect((await run(path, upstream)).handled).toBe(false);
      expect(upstream).not.toHaveBeenCalled();
    },
  );

  it.each(["/Users/u/Views", "/Items", "/Users/u/Items?ParentId=real"])(
    "leaves %s fully transparent when no virtual libraries exist",
    async (path) => {
      const upstream = vi.fn<QueryUpstream>();
      const db: VirtualQueryStore = { list: () => [], get: () => undefined, listItems: () => [] };
      expect((await run(path, upstream, db)).handled).toBe(false);
      expect(upstream).not.toHaveBeenCalled();
    },
  );

  it("keeps each original Series DTO when grouping Latest", async () => {
    const series = { Id: "series", Name: "原剧集", Type: "Series", IsFolder: true, DateCreated: "2020-01-01" };
    const episode = { Id: "episode", Name: "原分集", Type: "Episode", SeriesId: "series", DateCreated: "2026-01-01" };
    const { handler } = upstreamItems([series, episode]);
    const response = await run(
      "/Users/u/Items/Latest?ParentId=virtual",
      handler,
      store([{ itemId: "series", type: "Series" }]),
    );
    expect(response.body).toEqual([series]);
  });

  it("queries NextUp against real mapped parents without scanning the upstream root", async () => {
    const episode = { Id: "episode", Name: "原分集", SeriesId: "series" };
    const upstream = vi.fn<QueryUpstream>().mockImplementation(async (url) => {
      expect(url.pathname).toBe("/Shows/NextUp");
      expect(url.searchParams.get("ParentId")).toBe("series");
      expect(url.searchParams.get("SeriesId")).toBe("series");
      return { status: 200, headers: {}, body: { Items: [episode], TotalRecordCount: 1 } };
    });
    expect(
      (await run("/Shows/NextUp?ParentId=virtual&UserId=u", upstream, store([{ itemId: "series", type: "Series" }])))
        .body.Items,
    ).toEqual([episode]);
  });
});
