import { describe, expect, it, vi } from "vitest";
import { overlayLibraries } from "./owned-library-overlay";
import { result, type Item, type QueryUpstream, type UpstreamJson, type VirtualQueryStore } from "./query-helpers";

const localIds = ["local-a", "local-b", "local-c"];
const libraries = localIds.map((id, index) => ({
  id,
  name: id,
  collectionType: "mixed" as const,
  sortOrder: index,
  itemCount: 0,
  createdAt: "2026-10-19T00:00:00Z",
  updatedAt: "2026-10-19T00:00:00Z",
}));
const store: VirtualQueryStore = {
  list: () => libraries,
  get: (id) => libraries.find((library) => library.id === id),
  listItems: () => [],
};
const originals: Item[] = [
  { Id: "native-a", Guid: "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA", Type: "CollectionFolder", ServerId: "s" },
  { Id: "ttd", Name: "TTD", TtdPrivate: { arbitrary: ["preserved"] } },
  { Id: "native-b", UserData: { IsFavorite: true } },
];

function fixture(configuration: Record<string, unknown> = {}) {
  return vi.fn<QueryUpstream>().mockResolvedValue(result({ Configuration: configuration }));
}

async function apply(
  options: {
    query?: string;
    reply?: UpstreamJson;
    configuration?: Record<string, unknown>;
    onlyIds?: string[];
    upstream?: QueryUpstream;
  } = {},
) {
  const upstream = options.upstream ?? fixture(options.configuration);
  const reply = options.reply ?? result({ Items: originals, TotalRecordCount: originals.length, Extra: "keep" });
  const response = await overlayLibraries({
    url: new URL(`/Users/alice/Views${options.query ?? ""}`, "http://proxy.test"),
    store,
    upstream,
    reply,
    onlyIds: options.onlyIds,
  });
  return { response, upstream, body: response.body as { Items: Item[]; TotalRecordCount: number } };
}

describe("owned library insertion", () => {
  it("anchors local entries using Guid/Id while preserving every upstream object and relative order", async () => {
    const { body } = await apply({
      configuration: {
        OrderedViews: ["local-a", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "native-b", "local-b", "ttd"],
        MyMediaExcludes: ["ttd", "native-a", "local-c"],
      },
    });
    expect(body.Items.map((item) => item.Id)).toEqual(["local-a", "native-a", "local-b", "ttd", "native-b"]);
    expect(body.Items.filter((item) => !localIds.includes(item.Id!))).toEqual(originals);
    for (const item of originals) expect(body.Items).toContain(item);
    expect(body).toMatchObject({ Extra: "keep", TotalRecordCount: 5 });
  });

  it("IncludeHidden affects only new local entries and onlyIds bounds additions", async () => {
    const { body } = await apply({
      query: "?IncludeHidden=true",
      configuration: { MyMediaExcludes: ["ttd", "local-a"] },
      onlyIds: ["local-a"],
    });
    expect(body.Items.map((item) => item.Id)).toEqual([...originals.map((item) => item.Id), "local-a"]);
  });

  it("does not replace any upstream DTO even when its Id collides with an owned library", async () => {
    const collision = { Id: "local-a", Name: "Upstream owns this response", Private: true };
    const { body } = await apply({ reply: result({ Items: [collision], TotalRecordCount: 1 }) });
    expect(body.Items[0]).toBe(collision);
    expect(body.Items.filter((item) => item.Id === "local-a")).toEqual([collision]);
  });

  it("reads only same-client preferences with a bounded timeout, never refetches the list", async () => {
    const upstream = fixture();
    await apply({ query: "?limit=8&Fields=Private&api_key=client&Opaque=keep", upstream });
    expect(upstream).toHaveBeenCalledTimes(1);
    const [url, timeout] = upstream.mock.calls[0];
    expect(url.pathname).toBe("/Users/alice");
    expect([...url.searchParams]).toEqual([["api_key", "client"]]);
    expect(timeout).toBe(1_500);
  });

  it("keeps browsing operational when preferences fail", async () => {
    const upstream = vi.fn<QueryUpstream>().mockRejectedValue(new Error("unavailable"));
    const { body } = await apply({ upstream });
    expect(body.Items.slice(0, originals.length)).toEqual(originals);
  });

  it("does not insert or slice upstream items before the final upstream page", async () => {
    const { body } = await apply({
      query: "?Limit=3&StartIndex=0",
      reply: result({ Items: originals, TotalRecordCount: 10 }),
    });
    expect(body.Items).toBe(originals);
    expect(body.TotalRecordCount).toBe(13);
  });

  it("fills available capacity on the final upstream page without reordering it", async () => {
    const last = [originals[2]];
    const { body } = await apply({
      query: "?Limit=3&StartIndex=9",
      reply: result({ Items: last, TotalRecordCount: 10 }),
      configuration: { OrderedViews: ["local-a", "native-b"] },
    });
    expect(body.Items.map((item) => item.Id)).toEqual(["native-b", "local-a", "local-b"]);
    expect(body.TotalRecordCount).toBe(13);
  });

  it("locates the correct owned subpage after the upstream end", async () => {
    const { body } = await apply({
      query: "?limit=2&startindex=11",
      reply: result({ Items: [], TotalRecordCount: 10 }),
    });
    expect(body.Items.map((item) => item.Id)).toEqual(["local-b", "local-c"]);
    expect(body.TotalRecordCount).toBe(13);
  });

  it("keeps over-limit TTD results intact and inserts all owned entries", async () => {
    const { body } = await apply({ query: "?Limit=1" });
    expect(body.Items.filter((item) => !localIds.includes(item.Id!))).toEqual(originals);
    expect(body.Items).toHaveLength(6);
  });

  it("does not guess whether an unknown-total full page has more upstream items", async () => {
    const reply = result({ Items: originals, Extra: "no-total" });
    const { response } = await apply({ query: "?Limit=3", reply });
    expect(response).toBe(reply);
  });

  it("can append after an unknown-total short page", async () => {
    const { body } = await apply({ query: "?Limit=4", reply: result({ Items: originals }) });
    expect(body.Items).toHaveLength(4);
    expect(body.Items.slice(0, 3)).toEqual(originals);
    expect(body.TotalRecordCount).toBe(6);
  });

  it.each([result("opaque"), result({ Unexpected: true }), { status: 403, headers: {}, body: "denied" }])(
    "returns errors and non-list payloads unchanged: %j",
    async (reply) => {
      const upstream = fixture();
      expect((await apply({ reply, upstream })).response).toBe(reply);
      expect(upstream).not.toHaveBeenCalled();
    },
  );

  it("retains status, headers, body metadata and array response shape", async () => {
    const headers = { "x-private": "keep" };
    const { response } = await apply({ reply: { status: 206, headers, body: originals } });
    expect(response.status).toBe(206);
    expect(response.headers).toBe(headers);
    expect(Array.isArray(response.body)).toBe(true);
    expect((response.body as Item[]).slice(0, 3)).toEqual(originals);
  });
});
