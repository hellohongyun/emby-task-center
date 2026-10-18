import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { handleVirtualQuery } from "./queries";
import { parameter, result, type QueryUpstream, type VirtualQueryStore } from "./query-helpers";

const original = [
  { Id: "real-a", Name: "A", ServerId: "server", CanDelete: true },
  { Id: "real-b", Name: "B", ServerId: "server", UserData: { IsFavorite: true } },
];
const libraries = ["virtual-a", "virtual-b"].map((id) => ({
  id,
  name: id,
  collectionType: "mixed" as const,
  sortOrder: 0,
  itemCount: 0,
  createdAt: "2026-10-19T00:00:00Z",
  updatedAt: "2026-10-19T00:00:00Z",
}));
const store: VirtualQueryStore = {
  list: () => libraries,
  get: (id) => libraries.find((library) => library.id === id),
  listItems: () => [],
};

async function browse(upstream: QueryUpstream, path = "/Users/u/Views") {
  let body = "";
  const response = {
    setHeader: () => {},
    end: (value: string) => {
      body = value;
    },
  } as unknown as ServerResponse;
  await handleVirtualQuery({
    request: { method: "GET" } as IncomingMessage,
    response,
    url: new URL(path, "http://proxy.test"),
    store,
    upstream,
  });
  return JSON.parse(body) as { Items: typeof original; TotalRecordCount: number };
}

function fixture(configuration: unknown) {
  return vi.fn<QueryUpstream>().mockImplementation(async (url) => {
    if (/^\/Users\/[^/]+$/.test(url.pathname)) return result({ Configuration: configuration });
    const start = Number(parameter(url, "StartIndex") ?? 0);
    const limit = Number(parameter(url, "Limit") ?? original.length);
    return result({ Items: original.slice(start, start + limit), TotalRecordCount: original.length });
  });
}
const ids = (body: Awaited<ReturnType<typeof browse>>) => body.Items.map((item) => item.Id);

describe("Emby user library order with virtual views", () => {
  it.each([
    ["virtual-a", "real-a", "real-b", "virtual-b"],
    ["real-a", "virtual-a", "virtual-b", "real-b"],
    ["real-b", "virtual-b", "real-a", "virtual-a"],
  ])("uses saved order %j without changing original DTOs", async (...order) => {
    const body = await browse(fixture({ OrderedViews: order }));
    expect(ids(body)).toEqual(order);
    for (const item of original) expect(body.Items.find((entry) => entry.Id === item.Id)).toEqual(item);
    expect(body.TotalRecordCount).toBe(4);
  });

  it("ignores deleted and duplicate IDs, keeping unspecified libraries in their default order", async () => {
    const upstream = fixture({ OrderedViews: ["deleted", "virtual-b", "virtual-b", 123, null, "real-b"] });
    expect(ids(await browse(upstream))).toEqual(["virtual-b", "real-b", "real-a", "virtual-a"]);
  });

  it.each([undefined, null, {}, { OrderedViews: null }, { OrderedViews: "virtual-a" }, { OrderedViews: [] }])(
    "keeps default order with absent or invalid configuration %j",
    async (configuration) => {
      expect(ids(await browse(fixture(configuration)))).toEqual(["real-a", "real-b", "virtual-a", "virtual-b"]);
    },
  );

  it("applies paging after ordering the complete combined list", async () => {
    const upstream = fixture({ OrderedViews: ["virtual-a", "real-b", "virtual-b", "real-a"] });
    const body = await browse(upstream, "/Users/u/Views?startindex=1&limit=2&api_key=client-key");
    expect(ids(body)).toEqual(["real-b", "virtual-b"]);
    expect(body.TotalRecordCount).toBe(4);
    const viewsUrl = upstream.mock.calls[0][0];
    expect(parameter(viewsUrl, "StartIndex")).toBeUndefined();
    expect(parameter(viewsUrl, "Limit")).toBeUndefined();
    expect(viewsUrl.searchParams.get("api_key")).toBe("client-key");
  });

  it("copies only authentication parameters and bounds preference lookup to 1.5 seconds", async () => {
    const upstream = fixture({ OrderedViews: [] });
    await browse(upstream, "/Users/u/Views?api_key=client-key&SearchTerm=virtual&Limit=1");
    const [preferencesUrl, timeout] = upstream.mock.calls[1];
    expect(preferencesUrl.pathname).toBe("/Users/u");
    expect(Object.fromEntries(preferencesUrl.searchParams)).toEqual({ api_key: "client-key" });
    expect(timeout).toBe(1_500);
  });

  it.each([401, 403, 404, 500])("keeps valid Views when the preference request returns %i", async (status) => {
    const upstream = fixture({ OrderedViews: [] });
    upstream.mockImplementationOnce(async () => result({ Items: original, TotalRecordCount: 2 }));
    upstream.mockImplementationOnce(async () => ({ status, headers: {}, body: "unavailable" }));
    expect(ids(await browse(upstream))).toEqual(["real-a", "real-b", "virtual-a", "virtual-b"]);
  });

  it("falls back after preference timeout or network failure", async () => {
    const upstream = fixture({ OrderedViews: [] });
    upstream.mockImplementationOnce(async () => result({ Items: original, TotalRecordCount: 2 }));
    upstream.mockRejectedValueOnce(new Error("upstream timeout"));
    expect(ids(await browse(upstream))).toEqual(["real-a", "real-b", "virtual-a", "virtual-b"]);
  });

  it("reads the latest order on each refresh rather than caching the old position", async () => {
    const configuration = { OrderedViews: ["virtual-a", "real-a"] };
    const upstream = fixture(configuration);
    expect(ids(await browse(upstream))[0]).toBe("virtual-a");
    configuration.OrderedViews = ["real-a", "virtual-b"];
    expect(ids(await browse(upstream)).slice(0, 2)).toEqual(["real-a", "virtual-b"]);
  });

  it("preserves root Items pagination and avoids any preference lookup there", async () => {
    const upstream = fixture({ OrderedViews: ["virtual-a"] });
    const body = await browse(upstream, "/Users/u/Items?StartIndex=1&Limit=2");
    expect(ids(body)).toEqual(["real-b", "virtual-a"]);
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(parameter(upstream.mock.calls[0][0], "StartIndex")).toBe("1");
  });
});
