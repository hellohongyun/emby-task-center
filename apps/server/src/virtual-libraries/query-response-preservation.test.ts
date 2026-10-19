import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { handleVirtualQuery } from "./queries";
import { type QueryUpstream, type VirtualQueryStore } from "./query-helpers";

const library = {
  id: "virtual",
  name: "Virtual",
  collectionType: "movies" as const,
  sortOrder: 0,
  itemCount: 1,
  createdAt: "2026-10-19T00:00:00Z",
  updatedAt: "2026-10-19T00:00:00Z",
};
const store: VirtualQueryStore = {
  list: () => [library],
  get: (id) => (id === library.id ? library : undefined),
  listItems: () => [{ itemId: "movie", name: "Movie", type: "Movie", year: null, imageTag: null }],
};
async function run(path: string, upstream: QueryUpstream) {
  const end = vi.fn();
  const setHeader = vi.fn();
  const response = { end, setHeader } as unknown as ServerResponse;
  const handled = await handleVirtualQuery({
    request: { method: "GET" } as IncomingMessage,
    response,
    url: new URL(path, "http://proxy.test"),
    store,
    upstream,
  });
  return { handled, payload: end.mock.calls[0]?.[0], setHeader, response };
}

describe("virtual query raw response preservation", () => {
  it("returns unexpected successful discovery bodies byte for byte", async () => {
    const raw = Buffer.from("<!doctype html>\n<h1>Upstream login</h1>\n");
    const upstream = vi.fn<QueryUpstream>().mockResolvedValue({
      status: 200,
      headers: { "content-type": "text/html", "x-ttd-state": "retained" },
      body: raw.toString(),
      raw,
    });
    const response = await run("/Users/alice/Views", upstream);
    expect(response.handled).toBe(true);
    expect(response.payload).toBe(raw);
    expect(response.setHeader).toHaveBeenCalledWith("content-type", "text/html");
    expect(response.setHeader).toHaveBeenCalledWith("x-ttd-state", "retained");
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it("serializes appended owned entries instead of returning the stale upstream raw body", async () => {
    const original = { Id: "ttd", Name: "TTD", Opaque: { preserve: true } };
    const raw = Buffer.from(JSON.stringify({ Items: [original], TotalRecordCount: 1 }));
    const upstream = vi.fn<QueryUpstream>().mockResolvedValue({
      status: 200,
      headers: { "content-type": "application/json", "content-length": String(raw.length), etag: "old" },
      body: JSON.parse(raw.toString()),
      raw,
    });
    const response = await run("/Library/MediaFolders", upstream);
    expect(JSON.parse(response.payload).Items).toEqual([original, expect.objectContaining({ Id: "virtual" })]);
    expect(response.setHeader.mock.calls.some(([key]) => key === "etag" || key === "content-length")).toBe(false);
  });

  it("returns Latest as a mapped array even when the upstream supplies an envelope with raw bytes", async () => {
    const movie = { Id: "movie", Type: "Movie", Name: "Movie" };
    const envelope = { Items: [movie], TotalRecordCount: 1 };
    const upstream = vi.fn<QueryUpstream>().mockResolvedValue({
      status: 200,
      headers: { "content-type": "application/json" },
      body: envelope,
      raw: Buffer.from(JSON.stringify(envelope)),
    });
    const response = await run("/Users/alice/Items/Latest?ParentId=virtual", upstream);
    expect(JSON.parse(response.payload)).toEqual([movie]);
    expect(upstream).toHaveBeenCalledTimes(1);
  });
});
