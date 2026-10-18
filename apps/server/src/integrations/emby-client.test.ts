import { afterEach, describe, expect, it, vi } from "vitest";

import { createEmbyClient, normalizeEmbyDate } from "./emby-client";

const baseUrl = "https://emby.test";
const apiKey = "token";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

describe("EmbyClient library queries", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("lists the full Movie/Series library with tmdb ids", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        TotalRecordCount: 2,
        Items: [
          { Id: "m1", Name: "钢铁侠", Type: "Movie", ProductionYear: 2008, ProviderIds: { Tmdb: 1726 } },
          { Id: "s1", Name: "暗黑", Type: "Series", ProductionYear: 2017, ProviderIds: { Tmdb: 70523 } },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = createEmbyClient({ baseUrl, apiKey });

    const items = await client.listLibraryItems?.();
    // 海报/题材/入库时间随库查询一起返回（媒体库改由 Emby 驱动后不再读磁盘 sidecar）
    expect(items).toEqual([
      {
        id: "m1",
        name: "钢铁侠",
        year: 2008,
        type: "movie",
        tmdbId: 1726,
        hasPrimaryImage: false,
        dateCreated: null,
        genres: [],
      },
      {
        id: "s1",
        name: "暗黑",
        year: 2017,
        type: "tv",
        tmdbId: 70523,
        hasPrimaryImage: false,
        dateCreated: null,
        genres: [],
      },
    ]);
  });

  it("falls back to title search when the tmdb provider filter returns nothing", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ Items: [] }))
      .mockResolvedValueOnce(
        jsonResponse({
          Items: [{ Id: "m1", Name: "流浪地球2", Type: "Movie", ProductionYear: 2023, ProviderIds: {} }],
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const client = createEmbyClient({ baseUrl, apiKey });

    const items = await client.searchItems?.({ tmdbId: 842675, title: "流浪地球2", mediaType: "movie" });
    expect(items).toHaveLength(1);
    expect(items?.[0]?.id).toBe("m1");
    // 第二次请求不带 AnyProviderIdEquals（标题回退）。
    const secondUrl = fetchMock.mock.calls[1]?.[0];
    expect(String(secondUrl)).toContain("SearchTerm");
    expect(String(secondUrl)).not.toContain("AnyProviderIdEquals");
  });

  it("deletes an item through the official DELETE /Items/{Id} endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = createEmbyClient({ baseUrl, apiKey });

    await client.deleteItem?.("s1");

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://emby.test/emby/Items/s1");
    expect(init?.method).toBe("DELETE");
    expect(new Headers(init?.headers).get("X-Emby-Token")).toBe(apiKey);
  });

  it("reads the server id and season item ids used by Emby jump links", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ Id: "server-1", ServerName: "天鸿影视", Version: "4.10.0.40" }))
      .mockResolvedValueOnce(
        jsonResponse({
          Items: [
            { Id: "s-3", Name: "第 3 季", IndexNumber: 3 },
            { Id: "s-1", Name: "第 1 季", IndexNumber: 1 },
          ],
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const client = createEmbyClient({ baseUrl, apiKey });

    await expect(client.systemInfo()).resolves.toEqual({
      id: "server-1",
      serverName: "天鸿影视",
      version: "4.10.0.40",
    });
    await expect(client.listSeasons?.("series-1")).resolves.toEqual([
      { id: "s-3", seasonNumber: 3, name: "第 3 季" },
      { id: "s-1", seasonNumber: 1, name: "第 1 季" },
    ]);
    const url = String(fetchMock.mock.calls[1]![0]);
    expect(url).toContain("IncludeItemTypes=Season");
    expect(url).toContain("ParentId=series-1");
  });

  it("returns episode indexes for a series", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        TotalRecordCount: 3,
        Items: [
          { Id: "ep-1", Name: "一触即发", IndexNumber: 1, ParentIndexNumber: 1 },
          { Id: "ep-2", IndexNumber: 2, ParentIndexNumber: 1 },
          { Id: "ep-3", IndexNumber: 1, ParentIndexNumber: 2 },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = createEmbyClient({ baseUrl, apiKey });

    const episodes = await client.listItemEpisodes?.("s1");
    // 每集带自己的 Emby Id 与集名：同剧集内重复集号（真实数据里存在）只能靠 Id 区分；
    // 集名用于缺集的"换了编号但名字还在"兜底比对。
    expect(episodes).toEqual([
      { id: "ep-1", seasonNumber: 1, episodeNumber: 1, name: "一触即发" },
      { id: "ep-2", seasonNumber: 1, episodeNumber: 2, name: null },
      { id: "ep-3", seasonNumber: 2, episodeNumber: 1, name: null },
    ]);
  });
});

describe("EmbyClient library folders", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("maps VirtualFolders to library folders with a stable id and type", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse([
        { ItemId: "lib-1", Name: "国产电影", CollectionType: "movies", Locations: ["/media/strm/电影/国产电影"] },
        { ItemId: "lib-2", Name: "国产剧集", CollectionType: "tvshows", Locations: ["/media/strm/剧集/国产剧集"] },
        { ItemId: "lib-3", Name: "混合库", Locations: [] },
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = createEmbyClient({ baseUrl, apiKey });

    expect(await client.listLibraryFolders?.()).toEqual([
      { id: "lib-1", name: "国产电影", collectionType: "movies", locations: ["/media/strm/电影/国产电影"] },
      { id: "lib-2", name: "国产剧集", collectionType: "tvshows", locations: ["/media/strm/剧集/国产剧集"] },
      { id: "lib-3", name: "混合库", collectionType: "mixed", locations: [] },
    ]);
    expect(fetchMock.mock.calls[0]![0]).toBe("https://emby.test/emby/Library/VirtualFolders");
  });

  it("filters library items by library id when one is given", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ Items: [], TotalRecordCount: 0 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = createEmbyClient({ baseUrl, apiKey });

    await client.listLibraryItems?.({ libraryId: "lib-9", mediaType: "movie" });

    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).toContain("ParentId=lib-9");
    expect(url).toContain("IncludeItemTypes=Movie");
  });

  it("returns an empty list when the server answers with a non-array payload", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ Items: [] })));
    const client = createEmbyClient({ baseUrl, apiKey });

    expect(await client.listLibraryFolders?.()).toEqual([]);
  });
});

describe("Emby timestamps", () => {
  it("trims the .NET-style 7 digit fraction to milliseconds", () => {
    expect(normalizeEmbyDate("2026-09-02T08:24:18.0000000Z")).toBe("2026-09-02T08:24:18.000Z");
    expect(normalizeEmbyDate("2026-09-02T08:24:18.1234567Z")).toBe("2026-09-02T08:24:18.123Z");
    expect(normalizeEmbyDate("2026-09-02T08:24:18Z")).toBe("2026-09-02T08:24:18Z");
    expect(normalizeEmbyDate(null)).toBeNull();
    expect(normalizeEmbyDate(undefined)).toBeNull();
    expect(normalizeEmbyDate("")).toBeNull();
  });
});

/**
 * 回归：非 2xx 分支必须把响应体释放掉。
 *
 * 背景（2026-09-16 线上崩溃）：Node 内置 undici 在「响应体没读完 + 对端关闭 socket」时会在
 * socket 的 end 回调里 assert(!this.paused) 失败，抛出的 AssertionError 不在 promise 链上、
 * 抓不到，直接把容器带进每隔几秒重启一次的循环。缺图 404 是最高频的触发路径
 * （媒体库海报墙一次打几十上百个 image 请求），所以这里盯住 client.image。
 */
describe("EmbyClient releases unread response bodies", () => {
  afterEach(() => vi.unstubAllGlobals());

  function trackedResponse(status: number): { response: Response; wasCancelled: () => boolean } {
    let cancelled = false;
    const body = new ReadableStream({
      cancel() {
        cancelled = true;
      },
    });
    return { response: new Response(body, { status }), wasCancelled: () => cancelled };
  }

  it("cancels the body when the poster request answers 404", async () => {
    const tracked = trackedResponse(404);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(tracked.response));
    const client = createEmbyClient({ baseUrl, apiKey });

    // image 在 EmbyClient 上是可选成员；真丢了时这里的 toBeNull 会先失败
    expect(await client.image?.("42")).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(tracked.wasCancelled()).toBe(true);
  });

  it("cancels the body when a JSON request answers a non-2xx status", async () => {
    const tracked = trackedResponse(500);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(tracked.response));
    const client = createEmbyClient({ baseUrl, apiKey });

    await expect(client.systemInfo()).rejects.toThrow("emby_http_500");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(tracked.wasCancelled()).toBe(true);
  });
});
