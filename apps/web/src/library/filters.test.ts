import { describe, expect, it } from "vitest";

import type { WorkGroup } from "../library/work-groups";
import { applyLibraryFilters, countActiveFilters, EMPTY_LIBRARY_FILTERS, type LibraryFilterValues } from "./filters";

function group(overrides: Partial<WorkGroup>): WorkGroup {
  return {
    key: overrides.key ?? "k",
    title: overrides.title ?? "片名",
    year: "year" in overrides ? (overrides.year as number | null) : 2024,
    isTv: overrides.isTv ?? false,
    posterPath: null,
    tags: overrides.tags ?? [],
    resolution: null,
    items: overrides.items ?? [{ recognitionStatus: "matched" } as never],
    genres: overrides.genres ?? [],
    cast: [],
    addedAt: overrides.addedAt ?? null,
  };
}

const values = (overrides: Partial<LibraryFilterValues> = {}): LibraryFilterValues => ({
  ...EMPTY_LIBRARY_FILTERS,
  ...overrides,
});

describe("library filters", () => {
  const movie = group({ key: "m", title: "阿凡达", year: 2009, tags: ["2160p", "TrueHD"], genres: ["科幻"] });
  const series = group({ key: "t", title: "仙逆", year: 2023, isTv: true, tags: ["1080p"], genres: ["动作"] });
  const unresolved = group({
    key: "u",
    title: "未知片",
    year: null,
    items: [{ recognitionStatus: "unresolved" } as never],
  });
  const all = [movie, series, unresolved];

  it("filters by type, status, tags and year", () => {
    expect(applyLibraryFilters(all, values({ type: "movie" })).map((g) => g.title)).toEqual(["阿凡达", "未知片"]);
    expect(applyLibraryFilters(all, values({ type: "tv" })).map((g) => g.title)).toEqual(["仙逆"]);
    expect(applyLibraryFilters(all, values({ status: "matched" })).map((g) => g.title)).toEqual(["阿凡达", "仙逆"]);
    expect(applyLibraryFilters(all, values({ status: "unresolved" })).map((g) => g.title)).toEqual(["未知片"]);
    expect(applyLibraryFilters(all, values({ resolution: "2160p" })).map((g) => g.title)).toEqual(["阿凡达"]);
    expect(applyLibraryFilters(all, values({ codec: "TrueHD" })).map((g) => g.title)).toEqual(["阿凡达"]);
    expect(applyLibraryFilters(all, values({ genre: "动作" })).map((g) => g.title)).toEqual(["仙逆"]);
    expect(applyLibraryFilters(all, values({ year: "2009" })).map((g) => g.title)).toEqual(["阿凡达"]);
  });

  it("matches the query case-insensitively and trims it", () => {
    expect(applyLibraryFilters(all, values({ query: "  阿凡  " })).map((g) => g.title)).toEqual(["阿凡达"]);
    expect(applyLibraryFilters(all, values({ query: "不存在" }))).toEqual([]);
  });

  it("sorts by title, year and latest", () => {
    // zh-CN 排序：阿凡达 < 未知片 < 仙逆（与迁移前的行为一致）
    expect(applyLibraryFilters(all, values({ sort: "title" })).map((g) => g.title)).toEqual([
      "阿凡达",
      "未知片",
      "仙逆",
    ]);
    expect(applyLibraryFilters(all, values({ sort: "year" })).map((g) => g.title)[0]).toBe("仙逆");
    // "latest" 现在按真实入库时间排（见下方用例）；这批 fixture 没有入库时间，
    // 因此回落为片名升序——不再是过去那个"按片名倒序"的历史行为。
    expect(applyLibraryFilters(all, values({ sort: "latest" })).map((g) => g.title)[0]).toBe("阿凡达");
  });

  it("counts active filters but not sorting", () => {
    expect(countActiveFilters(values())).toBe(0);
    expect(countActiveFilters(values({ sort: "year" }))).toBe(0);
    expect(countActiveFilters(values({ type: "movie", genre: "科幻", query: " " }))).toBe(2);
    expect(countActiveFilters(values({ query: "x" }))).toBe(1);
    expect(
      countActiveFilters(
        values({
          type: "tv",
          status: "matched",
          resolution: "1080p",
          codec: "HEVC",
          genre: "动作",
          year: "2023",
          query: "仙",
        }),
      ),
    ).toBe(7);
  });
});

describe("latest sort uses the real added time", () => {
  const oldWork = group({ key: "old", title: "老片", addedAt: "2024-01-01T00:00:00Z" });
  const newWork = group({ key: "new", title: "新片", addedAt: "2026-09-01T00:00:00Z" });
  const undated = group({ key: "none", title: "无时间" });

  it("puts the most recently added first and undated works last", () => {
    expect(applyLibraryFilters([oldWork, undated, newWork], values({ sort: "latest" })).map((g) => g.title)).toEqual([
      "新片",
      "老片",
      "无时间",
    ]);
  });

  it("falls back to title order when nothing has a time", () => {
    const a = group({ key: "a", title: "阿凡达" });
    const b = group({ key: "b", title: "白蛇" });
    expect(applyLibraryFilters([b, a], values({ sort: "latest" })).map((g) => g.title)).toEqual(["阿凡达", "白蛇"]);
  });
});
