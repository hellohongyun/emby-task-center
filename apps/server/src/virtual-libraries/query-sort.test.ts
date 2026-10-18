import { describe, expect, it } from "vitest";
import { idBatches, sortItems, sortingFields } from "./query-sort";
import type { Item } from "./query-helpers";

describe("virtual library batch ordering", () => {
  it("merges mixed direction multi-field sorts with folders first", () => {
    const url = new URL(
      "http://localhost/Items?SortBy=ProductionYear,SortName&SortOrder=Descending,Ascending&FoldersFirst=true",
    );
    const items: Item[] = [
      { Id: "a", Name: "Zulu", ProductionYear: 2025 },
      { Id: "b", Name: "Beta", ProductionYear: 2025 },
      { Id: "c", Name: "New", ProductionYear: 2026 },
      { Id: "d", Name: "Folder", ProductionYear: 2020, IsFolder: true },
    ];
    expect(sortItems(items, url, new Map()).map((item) => item.Id)).toEqual(["d", "c", "b", "a"]);
    sortingFields(url);
    expect(url.searchParams.get("Fields")).toContain("ProductionYear");
    expect(url.searchParams.get("Fields")).toContain("SortName");
  });

  it("uses original user data for play count, date played and runtime aliases", () => {
    const positions = new Map<string, number>();
    const a = { Id: "a", UserData: { PlayCount: 3, LastPlayedDate: "2025-01-01" }, RunTimeTicks: 100 };
    const b = { Id: "b", UserData: { PlayCount: 5, LastPlayedDate: "2026-01-01" }, RunTimeTicks: 50 };
    for (const [key, expected] of [
      ["PlayCount", "b"],
      ["DatePlayed", "b"],
      ["Runtime", "a"],
    ]) {
      expect(sortItems([a, b], new URL(`http://localhost?SortBy=${key}&SortOrder=Descending`), positions)[0].Id).toBe(
        expected,
      );
    }
  });

  it("preserves mapping positions when no explicit sorting is requested", () => {
    expect(
      sortItems(
        [{ Id: "b" }, { Id: "a" }],
        new URL("http://localhost"),
        new Map([
          ["a", 0],
          ["b", 1],
        ]),
      ).map((item) => item.Id),
    ).toEqual(["a", "b"]);
  });

  it("batches by count and URL bytes without imposing a capacity limit", () => {
    const ids = Array.from({ length: 350 }, (_, index) => `${index}-${"x".repeat(60)}`);
    const url = new URL("http://localhost/Items?api_key=opaque");
    const batches = idBatches(ids, url);
    expect(batches.flat()).toEqual(ids);
    expect(batches.every((batch) => batch.length <= 100)).toBe(true);
    expect(batches.every((batch) => url.toString().length + encodeURIComponent(batch.join(",")).length < 6_000)).toBe(
      true,
    );
  });
});
