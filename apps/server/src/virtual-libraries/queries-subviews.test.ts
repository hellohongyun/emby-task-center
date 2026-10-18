import type { IncomingMessage, ServerResponse } from "node:http";
import { expect, it, vi } from "vitest";
import type { VirtualLibraryCollectionType } from "@emby-task-center/contracts/virtual-library";
import { handleVirtualQuery } from "./queries";
import type { Item, QueryUpstream, VirtualQueryStore } from "./query-helpers";

const cases: Array<{ type: VirtualLibraryCollectionType; subviews: string[] }> = [
  { type: "movies", subviews: ["movies", "genres", "folders"] },
  { type: "tvshows", subviews: ["series", "genres", "folders"] },
  { type: "mixed", subviews: ["movies", "series", "genres", "folders"] },
];

it.each(cases)("provides Emby client subviews for $type libraries at every entry point", async ({ type, subviews }) => {
  const library = {
    id: "virtual",
    name: "精选",
    collectionType: type,
    sortOrder: 0,
    itemCount: 0,
    createdAt: "2026-10-17T00:00:00Z",
    updatedAt: "2026-10-17T00:00:00Z",
  };
  const store: VirtualQueryStore = {
    list: () => [library],
    get: (id) => (id === library.id ? library : undefined),
    listItems: () => [],
  };
  const original = { Id: "original", Name: "原库", ServerId: "server", Subviews: ["movies"] };
  const upstream = vi.fn<QueryUpstream>().mockResolvedValue({
    status: 200,
    headers: {},
    body: { Items: [original], TotalRecordCount: 1 },
  });

  for (const path of ["/Users/u/Views", "/Users/u/Items", "/Users/u/Items/virtual"]) {
    let body = "";
    const response = {
      setHeader: () => {},
      end: (value: string) => {
        body = value;
      },
    } as unknown as ServerResponse;
    expect(
      await handleVirtualQuery({
        request: { method: "GET" } as IncomingMessage,
        response,
        url: new URL(path, "http://localhost"),
        store,
        upstream,
      }),
    ).toBe(true);
    const result = JSON.parse(body) as Item & { Items?: Item[] };
    const item = result.Items?.find((entry) => entry.Id === library.id) ?? result;

    // Emby 4.10's videos view calls Subviews.includes directly while building tabs.
    expect(() => (item.Subviews as string[]).includes("series")).not.toThrow();
    expect(item.Subviews).toEqual(subviews);
    if (result.Items) expect(result.Items[0]).toEqual(original);
  }
});
