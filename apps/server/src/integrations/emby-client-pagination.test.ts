import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmbyClient } from "./emby-client";
import { createEmbyScan } from "../library/emby-scanner";

const config = { baseUrl: "https://emby.test", apiKey: "test-token" };
function json(body: unknown) {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
}

describe("Emby client complete library reads", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each(["library", "episodes"])("loads more than the previous 10,000-item cap for %s", async (kind) => {
    const total = 10_003;
    const fetchMock = vi.fn(async (url: string) => {
      const params = new URL(url).searchParams;
      const offset = Number(params.get("StartIndex"));
      const size = Number(params.get("Limit"));
      expect(size).toBe(500);
      expect(params.get("EnableTotalRecordCount")).toBe("true");
      expect(params.get("ParentId")).toBe(kind === "library" ? "lib-1" : "series-1");
      const Items = Array.from({ length: Math.min(size, total - offset) }, (_, index) => {
        const n = offset + index + 1;
        return kind === "library"
          ? { Id: `m${n}`, Name: `Movie ${n}`, Type: "Movie" }
          : { Id: `e${n}`, Name: `Episode ${n}`, IndexNumber: n, ParentIndexNumber: 1 };
      });
      return json({ Items, TotalRecordCount: total });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = createEmbyClient(config);
    const items =
      kind === "library"
        ? await client.listLibraryItems!({ libraryId: "lib-1" })
        : await client.listItemEpisodes!("series-1");
    expect(items).toHaveLength(total);
    expect(new Set(items.map((item) => item.id)).size).toBe(total);
    expect(items.at(-1)!.id).toBe(kind === "library" ? "m10003" : "e10003");
    expect(fetchMock).toHaveBeenCalledTimes(21);
  });

  it("treats the old limit argument as page size and continues until the certified total", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ Items: [{ Id: "1", Name: "A", Type: "Movie" }], TotalRecordCount: 2 }))
      .mockResolvedValueOnce(json({ Items: [{ Id: "2", Name: "B", Type: "Movie" }], TotalRecordCount: 2 }));
    vi.stubGlobal("fetch", fetchMock);
    expect(
      await createEmbyClient(config).listLibraryItems!({ limit: 1, mediaType: "movie", libraryId: "lib" }),
    ).toHaveLength(2);
    expect(new URL(fetchMock.mock.calls[1]![0]).searchParams.get("StartIndex")).toBe("1");
  });

  it.each([
    { Id: "2", Name: "Wrong type", Type: "BoxSet" },
    { Id: "2", Name: "", Type: "Movie" },
  ])("refuses to silently discard malformed library records %#", async (invalid) => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(json({ Items: [{ Id: "1", Name: "Valid", Type: "Movie" }, invalid], TotalRecordCount: 2 })),
    );
    await expect(createEmbyClient(config).listLibraryItems!()).rejects.toThrow("emby_library_invalid_item");
  });

  it("refuses to silently drop unnumbered episodes from a complete scan", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(json({ Items: [{ Id: "e1", IndexNumber: 1 }, { Id: "e2" }], TotalRecordCount: 2 })),
    );
    await expect(createEmbyClient(config).listItemEpisodes!("series")).rejects.toThrow("emby_episode_invalid_number");
  });

  it("does not produce a completed batch when a later series returns a truncated episode list", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const query = new URL(url).searchParams;
      const parent = query.get("ParentId");
      if (parent === "root")
        return json({
          Items: [
            { Id: "movie", Type: "Movie", Name: "Movie already collected" },
            { Id: "series-a", Type: "Series", Name: "Complete series" },
            { Id: "series-b", Type: "Series", Name: "Truncated series" },
          ],
          TotalRecordCount: 3,
        });
      if (parent === "series-a")
        return json({ Items: [{ Id: "a1", IndexNumber: 1, ParentIndexNumber: 1 }], TotalRecordCount: 1 });
      if (query.get("StartIndex") === "0")
        return json({ Items: [{ Id: "b1", IndexNumber: 1, ParentIndexNumber: 1 }], TotalRecordCount: 2 });
      return json({ Items: [], TotalRecordCount: 2 });
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(createEmbyScan(createEmbyClient(config))("emby:root")).rejects.toThrow("emby_pagination_truncated");
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("certifies a batch only after all library and episode pages complete", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const query = new URL(url).searchParams;
        if (query.get("ParentId") === "root")
          return json({ Items: [{ Id: "series", Type: "Series", Name: "Show" }], TotalRecordCount: 1 });
        const index = Number(query.get("StartIndex"));
        return json({
          Items: [{ Id: `e${index + 1}`, IndexNumber: index + 1, ParentIndexNumber: 1 }],
          TotalRecordCount: 2,
        });
      }),
    );
    const batch = await createEmbyScan(createEmbyClient(config))("emby:root");
    expect(batch.complete).toBe(true);
    expect(batch.items.map((item) => item.embyItemId)).toEqual(["e1", "e2"]);
  });
});
