import { describe, expect, it, vi } from "vitest";
import { fetchAllEmbyItems } from "./emby-pagination";

const item = (id: string) => ({ Id: id });

describe("complete Emby pagination", () => {
  it("continues from the received count when the server caps a page below the requested limit", async () => {
    const query = new URLSearchParams({ ParentId: "library", IncludeItemTypes: "Movie,Series" });
    const get = vi
      .fn()
      .mockResolvedValueOnce({ Items: [item("1"), item("2")], TotalRecordCount: 3 })
      .mockResolvedValueOnce({ Items: [item("3")], TotalRecordCount: 3 });
    expect(await fetchAllEmbyItems(get, query, 100)).toEqual([item("1"), item("2"), item("3")]);
    expect(get.mock.calls.map(([params]) => params.get("StartIndex"))).toEqual(["0", "2"]);
    for (const [params] of get.mock.calls) {
      expect(params.get("Limit")).toBe("100");
      expect(params.get("EnableTotalRecordCount")).toBe("true");
      expect(params.get("ParentId")).toBe("library");
      expect(params.get("IncludeItemTypes")).toBe("Movie,Series");
      expect(params.get("SortBy")).toBe("SortName");
    }
    expect(query.has("StartIndex")).toBe(false);
  });

  it("accepts an explicitly empty complete listing", async () => {
    expect(await fetchAllEmbyItems(async () => ({ Items: [], TotalRecordCount: 0 }), new URLSearchParams())).toEqual(
      [],
    );
  });

  it.each([
    [null, "invalid_response"],
    [[], "invalid_response"],
    [{ TotalRecordCount: 0 }, "invalid_items"],
    [{ Items: [] }, "invalid_total"],
    [{ Items: [], TotalRecordCount: "0" }, "invalid_total"],
    [{ Items: [], TotalRecordCount: -1 }, "invalid_total"],
    [{ Items: [], TotalRecordCount: 0.5 }, "invalid_total"],
    [{ Items: [], TotalRecordCount: 1_000_001 }, "limit_exceeded"],
    [{ Items: [], TotalRecordCount: 1 }, "truncated"],
    [{ Items: [item("1")], TotalRecordCount: 0 }, "count_mismatch"],
    [{ Items: [item("1")], TotalRecordCount: 1, StartIndex: 3 }, "offset_mismatch"],
    [{ Items: [null], TotalRecordCount: 1 }, "invalid_item"],
    [{ Items: [{ Name: "missing ID" }], TotalRecordCount: 1 }, "invalid_id"],
    [{ Items: [item(" ")], TotalRecordCount: 1 }, "invalid_id"],
    [{ Items: [item("1"), item("1")], TotalRecordCount: 2 }, "duplicate_id"],
  ])("rejects an uncertifiable response %# without returning partial items", async (body, error) => {
    await expect(fetchAllEmbyItems(async () => body, new URLSearchParams())).rejects.toThrow(
      `emby_pagination_${error}`,
    );
  });

  it.each([
    [{ Items: [], TotalRecordCount: 4 }, "truncated"],
    [{ Items: [item("1"), item("2")], TotalRecordCount: 4 }, "duplicate_id"],
    [{ Items: [item("2"), item("3")], TotalRecordCount: 4 }, "duplicate_id"],
    [{ Items: [item("3"), item("4")], TotalRecordCount: 5 }, "total_changed"],
    [{ Items: [item("3"), item("4")] }, "invalid_total"],
  ])("rejects truncated, overlapping or changing subsequent pages %#", async (second, error) => {
    const get = vi
      .fn()
      .mockResolvedValueOnce({ Items: [item("1"), item("2")], TotalRecordCount: 4 })
      .mockResolvedValueOnce(second);
    await expect(fetchAllEmbyItems(get, new URLSearchParams(), 2)).rejects.toThrow(`emby_pagination_${error}`);
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("propagates a failed later request rather than returning the first page", async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce({ Items: [item("1")], TotalRecordCount: 2 })
      .mockRejectedValueOnce(new Error("upstream timeout"));
    await expect(fetchAllEmbyItems(get, new URLSearchParams())).rejects.toThrow("upstream timeout");
  });

  it("rejects servers ignoring the requested page limit", async () => {
    await expect(
      fetchAllEmbyItems(async () => ({ Items: [item("1"), item("2")], TotalRecordCount: 2 }), new URLSearchParams(), 1),
    ).rejects.toThrow("emby_pagination_count_mismatch");
  });
});
