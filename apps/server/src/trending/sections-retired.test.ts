import { describe, expect, it } from "vitest";

import { DEFAULT_SECTIONS, DEFAULT_SOURCE_SETTINGS, createTrendingAdapters } from "./adapters";

/**
 * 榜单来源清单的回归：猫眼与奈飞**已下线**（用户要求从首页删除）。
 *
 * 这几条断言看着像"测试在复述实现"，但它们守的是一个产品决定：
 * 只要有人把 maoyan/netflix 加回 DEFAULT_SECTIONS 或适配器表，这里就会红，
 * 而不是等到首页又冒出两个榜单、再由用户发现。
 */
describe("trending 已下线猫眼与奈飞", () => {
  it("默认区块不再包含猫眼/奈飞的任何榜单，其余榜单原样保留", () => {
    const keys = DEFAULT_SECTIONS.map((section) => section.key);
    const sources = DEFAULT_SECTIONS.map((section) => section.source);

    expect(keys).not.toContain("maoyan_realtime");
    expect(keys).not.toContain("maoyan_year");
    expect(keys).not.toContain("netflix_movies");
    expect(keys).not.toContain("netflix_tv");
    expect(sources).not.toContain("maoyan");
    expect(sources).not.toContain("netflix");
    // 剩下的一个都不能少（防误删）
    expect(keys).toEqual(["douban_hot", "tmdb_trending", "tmdb_hot", "imdb_hot", "imdb_top", "douban_top250"]);
  });

  it("适配器表里也没有这两个来源了", () => {
    const adapters = createTrendingAdapters() as unknown as Record<string, unknown>;
    expect(adapters.maoyan).toBeUndefined();
    expect(adapters.netflix).toBeUndefined();
    expect(Object.keys(adapters).sort()).toEqual(["douban", "imdb", "tmdb"]);
  });

  it("来源开关只认剩下这三个（改不到已下线的来源）", () => {
    expect(Object.keys(DEFAULT_SOURCE_SETTINGS).sort()).toEqual(["douban", "imdb", "tmdb"]);
  });
});
