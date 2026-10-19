import { describe, expect, it, vi } from "vitest";
import { homeSectionItems } from "./home-sections";
import { parameter, result, type QueryUpstream, type VirtualQueryStore } from "./query-helpers";

const library = {
  id: "virtual-a",
  name: "Virtual library",
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
const real = { Id: "real-a", Guid: "guid-a", Name: "Real", ServerId: "server", UserData: { IsFavorite: true } };
const sections = [{ Id: "dynamic-library-row-981", SectionType: "userviews" }];
const path = "/Users/alice/Sections/dynamic-library-row-981/Items";

function fixture(sectionBody: unknown = sections) {
  return vi.fn<QueryUpstream>().mockImplementation(async (url) => {
    if (url.pathname.endsWith("/HomeSections")) return result(sectionBody);
    if (url.pathname === "/Users/alice") {
      return result({ Configuration: { OrderedViews: ["virtual-a", "guid-a"] } });
    }
    return result({ Items: [real], TotalRecordCount: 1, Marker: "retained" });
  });
}

async function browse(upstream: QueryUpstream, requestPath = path, homeSections?: unknown) {
  return homeSectionItems({ url: new URL(requestPath, "http://proxy.test"), store, upstream, homeSections });
}

describe("Emby 4.10 home section library discovery", () => {
  it("uses known classification without repeating HomeSections, while reading authenticated items", async () => {
    const upstream = fixture();
    expect((await browse(upstream, path, sections))?.body).toMatchObject({ TotalRecordCount: 2 });
    expect(upstream.mock.calls.map(([url]) => url.pathname)).toEqual([path, "/Users/alice"]);
    upstream.mockClear();
    expect(await browse(upstream, path, [])).toBeUndefined();
    expect(upstream).not.toHaveBeenCalled();
  });

  it("counts only visible libraries after filtering a hidden virtual library", async () => {
    const upstream = fixture();
    upstream.mockResolvedValueOnce(result({ Items: [real], TotalRecordCount: 1 }));
    upstream.mockResolvedValueOnce(
      result({ Configuration: { OrderedViews: ["virtual-a"], MyMediaExcludes: ["virtual-a"] } }),
    );
    const response = await browse(upstream, path, sections);
    expect(response?.body).toMatchObject({ Items: [real], TotalRecordCount: 1 });
  });

  it("discovers a dynamically named userviews section and preserves original fields", async () => {
    const response = await browse(fixture());
    expect(response?.body).toMatchObject({
      Items: [{ Id: "virtual-a" }, real],
      TotalRecordCount: 2,
      Marker: "retained",
    });
  });

  it("preserves upstream paging without trimming its returned row", async () => {
    const upstream = fixture();
    const response = await browse(upstream, `${path}?startindex=1&limit=1&RandomSeed=99&api_key=client`);
    expect(response?.body).toMatchObject({ Items: [real], TotalRecordCount: 2 });
    const itemsUrl = upstream.mock.calls[1][0];
    expect(parameter(itemsUrl, "StartIndex")).toBe("1");
    expect(parameter(itemsUrl, "Limit")).toBe("1");
    expect(itemsUrl.searchParams.get("RandomSeed")).toBe("99");
    expect(itemsUrl.searchParams.get("api_key")).toBe("client");
  });

  it("uses only the same request authentication and bounds section lookup", async () => {
    const upstream = fixture();
    await browse(upstream, `${path}?Limit=1&api_key=client&RandomSeed=42`);
    expect(upstream.mock.calls[0][0].pathname).toBe("/Users/alice/HomeSections");
    expect(Object.fromEntries(upstream.mock.calls[0][0].searchParams)).toEqual({ api_key: "client" });
    expect(upstream.mock.calls[0][1]).toBe(1_500);
    expect(upstream.mock.calls.every(([url]) => !url.pathname.includes("Configuration"))).toBe(true);
  });

  it.each(["resume", "latestmedia", "ttd-private", "nextup"])("leaves %s sections entirely upstream", async (type) => {
    const upstream = fixture([{ Id: sections[0].Id, SectionType: type }]);
    expect(await browse(upstream)).toBeUndefined();
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it.each([null, {}, { Items: sections }, [], [{ Id: "another-id", SectionType: "userviews" }]])(
    "leaves an unknown or malformed section registry upstream: %j",
    async (body) => {
      const upstream = fixture(body);
      expect(await browse(upstream)).toBeUndefined();
      expect(upstream).toHaveBeenCalledTimes(1);
    },
  );

  it.each([401, 403, 404, 500])("does not inject when section lookup returns %i", async (status) => {
    const upstream = fixture();
    upstream.mockResolvedValueOnce({ status, headers: {}, body: "unavailable" });
    expect(await browse(upstream)).toBeUndefined();
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it("falls back to normal forwarding on a section lookup timeout", async () => {
    const upstream = fixture();
    upstream.mockRejectedValueOnce(new Error("timeout"));
    expect(await browse(upstream)).toBeUndefined();
  });

  it("retains a section items authentication rejection without additions", async () => {
    const upstream = fixture();
    const denied = { status: 401, headers: { "www-authenticate": "Emby" }, body: "denied" };
    upstream.mockResolvedValueOnce(result(sections)).mockResolvedValueOnce(denied);
    expect(await browse(upstream)).toBe(denied);
    expect(upstream).toHaveBeenCalledTimes(2);
  });

  it("does not probe unrelated routes", async () => {
    const upstream = fixture();
    expect(await browse(upstream, "/Users/alice/Views")).toBeUndefined();
    expect(upstream).not.toHaveBeenCalled();
  });
});
