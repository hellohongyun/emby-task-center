import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { handleVirtualQuery } from "./queries";
import { result, type Item, type QueryUpstream, type VirtualQueryStore } from "./query-helpers";

const library = {
  id: "local-virtual",
  name: "Our virtual library",
  collectionType: "mixed" as const,
  sortOrder: 0,
  itemCount: 0,
  createdAt: "2026-10-19T00:00:00Z",
  updatedAt: "2026-10-19T00:00:00Z",
};
const store: VirtualQueryStore = {
  list: () => [library],
  get: (id) => (id === library.id ? library : undefined),
  listItems: () => [],
};
const originals: Item[] = [
  { Id: "native-first", Guid: "native-guid", Name: "Z native", ServerId: "server", Type: "CollectionFolder" },
  {
    Id: "ttd-virtual",
    Guid: "ttd-guid",
    Name: "TTD injected library",
    Type: "CollectionFolder",
    CollectionType: null,
    Subviews: ["movies", "tvshows"],
    Ttd: { route: "/special", opaque: [1, "keep"] },
    UserData: { IsFavorite: true },
    ImageTags: { Primary: "ttd-poster" },
  },
  { Id: "native-last", Name: "A native", Type: "CollectionFolder", Extra: { keep: true } },
];
const discoveryPaths = [
  "/Users/alice/Views",
  "/Users/alice/Sections/library-row/Items",
  "/Library/MediaFolders?UserId=alice",
];

async function run(path: string, upstream: QueryUpstream) {
  let body: unknown;
  const response = {
    setHeader: vi.fn(),
    end: (value: string) => {
      body = JSON.parse(value);
    },
  } as unknown as ServerResponse;
  const handled = await handleVirtualQuery({
    request: { method: "GET" } as IncomingMessage,
    response,
    url: new URL(path, "http://proxy.test"),
    store,
    upstream,
    homeSections: [{ Id: "library-row", SectionType: "userviews" }],
  });
  return { handled, body: body as { Items: Item[]; Marker?: unknown } | undefined };
}

function fixture(configuration: Record<string, unknown> = {}, expectedListUrl?: URL) {
  const listCalls: URL[] = [];
  const upstream = vi.fn<QueryUpstream>().mockImplementation(async (url) => {
    if (url.pathname === "/Users/alice") return result({ Configuration: configuration });
    listCalls.push(new URL(url));
    // TTD injects its virtual libraries only for the client's exact discovery request.
    const matches = !expectedListUrl || url.search === expectedListUrl.search;
    return result({
      Items: structuredClone(matches ? originals : originals.filter((item) => item.Id !== "ttd-virtual")),
      TotalRecordCount: originals.length,
      Marker: { opaqueUpstreamField: true },
    });
  });
  return { upstream, listCalls };
}

describe("virtual libraries preserve upstream ownership", () => {
  it("removes only owned IDs from mixed lookup and retains opaque TTD parameters and DTOs", async () => {
    const requested = new URL(
      "/Users/alice/Items?ids=local-virtual,unknown-ttd-alias,native-first&limit=80&startindex=0&Fields=A&Fields=B&OpaqueTtdOption=keep%2Bthis",
      "http://proxy.test",
    );
    const upstream = vi.fn<QueryUpstream>().mockResolvedValue(
      result({
        Items: originals,
        TotalRecordCount: 3,
        Marker: { opaqueUpstreamField: true },
      }),
    );
    const response = await run(`${requested.pathname}${requested.search}`, upstream);
    expect(upstream).toHaveBeenCalledTimes(1);
    const target = upstream.mock.calls[0][0];
    const untouched = (url: URL) => [...url.searchParams].filter(([key]) => key.toLowerCase() !== "ids");
    expect(untouched(target)).toEqual(untouched(requested));
    expect(target.searchParams.get("Ids")).toBe("unknown-ttd-alias,native-first");
    expect(response.body?.Items.filter((item) => item.Id !== library.id)).toEqual(originals);
    expect(response.body?.Items.map((item) => item.Id)).toContain(library.id);
    expect(response.body?.Marker).toEqual({ opaqueUpstreamField: true });
  });

  it.each(discoveryPaths)("preserves all original DTOs and their relative order at %s", async (path) => {
    const { upstream } = fixture({
      OrderedViews: ["local-virtual", "native-last", "ttd-guid", "native-guid"],
      MyMediaExcludes: ["ttd-guid", "native-last"],
    });
    const response = await run(path, upstream);
    expect(response.handled).toBe(true);
    expect(response.body?.Items.filter((item) => item.Id !== library.id)).toEqual(originals);
    expect(response.body?.Marker).toEqual({ opaqueUpstreamField: true });
    expect(response.body?.Items.map((item) => item.Id)).toContain(library.id);
  });

  it.each(discoveryPaths)("only hides our own virtual libraries at %s", async (path) => {
    const { upstream } = fixture({
      OrderedViews: ["native-last", "local-virtual", "ttd-guid", "native-guid"],
      MyMediaExcludes: ["local-virtual", "ttd-guid"],
    });
    const response = await run(path, upstream);
    expect(response.body?.Items).toEqual(originals);
  });

  it.each(discoveryPaths)(
    "retains the complete original discovery query without refetching pages at %s",
    async (path) => {
      const url = new URL(path, "http://proxy.test");
      url.searchParams.append("limit", "80");
      url.searchParams.append("startindex", "0");
      url.searchParams.append("Fields", "PrimaryImageAspectRatio,Path");
      url.searchParams.append("Fields", "CustomTtdField");
      url.searchParams.append("SortBy", "SortName");
      url.searchParams.append("SortOrder", "Ascending");
      url.searchParams.append("EnableTotalRecordCount", "false");
      url.searchParams.append("OpaqueTtdOption", "keep+this");
      const { upstream, listCalls } = fixture({}, url);
      const response = await run(`${url.pathname}${url.search}`, upstream);
      expect(listCalls).toHaveLength(1);
      expect([...listCalls[0].searchParams]).toEqual([...url.searchParams]);
      expect(response.body?.Items.filter((item) => item.Id !== library.id)).toEqual(originals);
    },
  );

  it.each([
    "/Users/alice/Items?ParentId=ttd-root&Limit=50",
    "/Items?Ids=ttd-virtual,native-first&UserId=alice",
    "/Users/alice/Items?IncludeItemTypes=CollectionFolder&Limit=50",
    "/Users/alice/Items?Limit=50",
    "/Items?UserId=alice&IncludeItemTypes=Folder&StartIndex=0",
  ])("leaves nonlocal Hills and root Items requests untouched: %s", async (path) => {
    const { upstream } = fixture();
    expect(await run(path, upstream)).toEqual({ handled: false, body: undefined });
    expect(upstream).not.toHaveBeenCalled();
  });
});
