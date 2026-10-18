import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";

import { createDatabase, type DatabaseHandle } from "@emby-task-center/database/client";
import { createTrendingService } from "./service";

function tmdbMovie(id: number, title: string, year: number, rating: number) {
  return {
    id,
    title,
    media_type: "movie",
    poster_path: "/poster.jpg",
    release_date: `${year}-01-01`,
    vote_average: rating,
    overview: "",
  };
}

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });
}

function buildFetch(): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/trending/movie/day")) return jsonResponse({ results: [tmdbMovie(603, "黑客帝国", 1999, 8.0)] });
    if (url.includes("/trending/tv/day")) return jsonResponse({ results: [] });
    if (url.includes("/movie/popular"))
      return jsonResponse({ results: [tmdbMovie(603, "黑客帝国", 1999, 8.0), tmdbMovie(155, "黑暗骑士", 2008, 9.0)] });
    if (url.includes("/tv/popular")) return jsonResponse({ results: [] });
    if (url.includes("/movie/top_rated")) return jsonResponse({ results: [tmdbMovie(278, "肖申克的救赎", 1994, 9.3)] });
    if (url.includes("douban.com/j/search_subjects"))
      return jsonResponse({
        subjects: [
          {
            id: 1,
            title: "流浪地球2",
            rate: "8.3",
            cover: "https://img.douban/cover.jpg",
            year: "2023",
            url: "https://movie.douban.com/subject/1",
          },
        ],
      });
    if (url.includes("movie.douban.com/top250")) return new Response("<html></html>\n", { status: 200 });
    return jsonResponse({ results: [] });
  }) as typeof fetch;
}

describe("trending service", () => {
  let directory: string;
  let database: DatabaseHandle;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "emby-trending-"));
    database = createDatabase(join(directory, "app.sqlite"));
  });

  afterEach(() => {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("refreshes sources, caches them, and serves sections from cache", async () => {
    const service = createTrendingService({
      database: database.db,
      tmdbToken: "test-token",
      fetchImpl: buildFetch(),
    });

    await service.refresh();
    const result = await service.getSections();

    expect(result.sections.map((section) => section.key)).toContain("tmdb_trending");
    expect(result.sections.map((section) => section.key)).toContain("tmdb_hot");
    expect(result.sections.map((section) => section.key)).toContain("douban_hot");
    expect(result.sections.map((section) => section.key)).toContain("imdb_top");

    const trending = result.sections.find((section) => section.key === "tmdb_trending")!;
    expect(trending.items.length).toBeGreaterThan(0);
    expect(trending.items[0]!.title).toBe("黑客帝国");
    expect(trending.items[0]!.tmdbId).toBe(603);

    // 再次取走缓存不触发网络（可在此时断开 fetch，但这里验证缓存命中即可）。
    const cachedAgain = await service.getSections();
    expect(cachedAgain.sections.length).toBe(result.sections.length);
  });

  it("persists snapshots to DB so cold start can fall back", async () => {
    const service = createTrendingService({
      database: database.db,
      tmdbToken: "test-token",
      fetchImpl: buildFetch(),
    });
    await service.refresh();

    // 新服务实例（无缓存）从 DB 快照兜底读取。
    const cold = createTrendingService({
      database: database.db,
      tmdbToken: "test-token",
      fetchImpl: async () => jsonResponse({ results: [] }),
    });
    const result = await cold.getSections(["tmdb_trending"]);
    expect(result.sections.some((section) => section.key === "tmdb_trending" && section.items.length > 0)).toBe(true);
  });
});

/**
 * 已下线的猫眼/奈飞榜单：**库里的旧快照不能让它们复活**。
 *
 * 这条针对的是真实情形——用户库里现在就有这四个榜单的快照行（maoyan_realtime / maoyan_year /
 * netflix_movies / netflix_tv）。只删代码常量是不够的，必须证明旧数据不会被重新装配进响应。
 */
describe("已下线的榜单不会被旧快照复活", () => {
  let directory: string;
  let database: DatabaseHandle;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "emby-trending-retired-"));
    database = createDatabase(join(directory, "app.sqlite"));
  });

  afterEach(() => {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });

  /** 直接往快照表里塞一条"已下线榜单"的旧数据。 */
  function seedRetiredSnapshot(handle: DatabaseHandle): void {
    /*
     * payload 的形状是**条目数组**，不是整个 section 对象——这点极容易写错：
     * 写成对象时 `items.length` 是 undefined，用例会"因为读到空数据"而假绿，
     * 看着在守门，实际什么都没守。这里按真实格式来（见真实库里的 payload）。
     */
    const payload = JSON.stringify([
      {
        id: "maoyan:1",
        title: "某部热映片",
        mediaType: "movie",
        year: 2026,
        posterUrl: null,
        rating: null,
        rank: 1,
        source: "maoyan",
      },
    ]);
    const at = new Date().toISOString();
    handle.db.run(
      sql`INSERT INTO trending_snapshots (source, section_key, payload, fetched_at, updated_at)
          VALUES ('maoyan', 'maoyan_realtime', ${payload}, ${at}, ${at})`,
    );
  }

  it("列表里不会出现已下线的榜单，哪怕库里存着它的快照", async () => {
    seedRetiredSnapshot(database);
    const service = createTrendingService({
      database: database.db,
      tmdbToken: "test-token",
      fetchImpl: buildFetch(),
    });
    await service.refresh();

    const result = await service.getSections();
    expect(result.sections.length, "榜单列表为空会让这条断言失去意义").toBeGreaterThan(0);
    const keys = result.sections.map((section) => section.key);
    expect(keys).not.toContain("maoyan_realtime");
    expect(keys).not.toContain("maoyan_year");
    expect(keys).not.toContain("netflix_movies");
    expect(keys).not.toContain("netflix_tv");
    // 顺带确认它还认剩下的（不是"全都查不到"造成的假绿）
    expect(keys).toContain("tmdb_trending");
  });

  it("就算调用方显式点名要它，也拿不到", async () => {
    seedRetiredSnapshot(database);
    const service = createTrendingService({
      database: database.db,
      tmdbToken: "test-token",
      fetchImpl: buildFetch(),
    });
    await service.refresh();

    const result = await service.getSections(["maoyan_realtime", "netflix_movies"]);
    expect(result.sections.map((section) => section.key)).toEqual([]);
  });
});
