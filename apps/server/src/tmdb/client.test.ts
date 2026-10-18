import { describe, expect, it, vi } from "vitest";

import { createTmdbClient, isEpisodeAiredEnough, type TmdbFetch } from "./client";

const searchPayload = {
  page: 1,
  results: [
    {
      id: 31910,
      media_type: "tv",
      name: "凡人修仙传",
      original_name: "凡人修仙传",
      first_air_date: "2020-07-25",
      overview: "平凡少年踏上修仙之路。",
      poster_path: "/poster.jpg",
      backdrop_path: "/backdrop.jpg",
    },
  ],
  total_pages: 1,
  total_results: 1,
};

describe("createTmdbClient authentication", () => {
  it("uses a v3 API key as a query parameter without an authorization header", async () => {
    const fetchImpl = vi.fn<TmdbFetch>().mockResolvedValue(Response.json(searchPayload));
    const client = createTmdbClient({
      token: "0123456789abcdef0123456789abcdef",
      fetchImpl,
    });

    await expect(client.search("凡人修仙传")).resolves.toHaveLength(1);

    const [requestUrl, requestInit] = fetchImpl.mock.calls[0] ?? [];
    const url = new URL(String(requestUrl));
    expect(url.searchParams.get("api_key")).toBe("0123456789abcdef0123456789abcdef");
    expect(url.searchParams.get("query")).toBe("凡人修仙传");
    expect(new Headers(requestInit?.headers).has("authorization")).toBe(false);
  });

  it("keeps v4 API Read Access Tokens in the authorization header", async () => {
    const fetchImpl = vi.fn<TmdbFetch>().mockResolvedValue(Response.json(searchPayload));
    const client = createTmdbClient({ token: "eyJhbGciOiJIUzI1NiJ9.read-access-token", fetchImpl });

    await client.search("凡人修仙传");

    const [requestUrl, requestInit] = fetchImpl.mock.calls[0] ?? [];
    expect(new URL(String(requestUrl)).searchParams.has("api_key")).toBe(false);
    expect(new Headers(requestInit?.headers).get("authorization")).toBe(
      "Bearer eyJhbGciOiJIUzI1NiJ9.read-access-token",
    );
  });

  it("requests Chinese metadata and calculates the aired episode snapshot", async () => {
    const fetchImpl = vi.fn<TmdbFetch>().mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.includes("/search/multi")) return Response.json(searchPayload);
      if (url.pathname === "/3/tv/31910") {
        return Response.json({
          id: 31910,
          number_of_episodes: 4,
          seasons: [{ season_number: 1, name: "第1季", episode_count: 4, air_date: "2026-08-01" }],
        });
      }
      if (url.pathname === "/3/tv/31910/season/1") {
        return Response.json({
          episodes: [
            { episode_number: 1, air_date: "2026-08-01" },
            { episode_number: 2, air_date: "2026-08-08" },
            { episode_number: 3, air_date: "2026-08-15" },
            { episode_number: 4, air_date: null },
          ],
        });
      }
      return Response.json({
        episodes: [
          { episode_number: 1, air_date: "2026-08-01" },
          { episode_number: 2, air_date: "2026-08-08" },
          { episode_number: 3, air_date: "2026-08-15" },
          { episode_number: 4, air_date: null },
        ],
      });
    });
    const client = createTmdbClient({ token: "tmdb-v4-token", fetchImpl });

    const results = await client.search("仙逆");
    const progress = await client.seasonProgress(223911, 1, new Date("2026-08-11T00:00:00Z"));

    expect(results[0]).toMatchObject({
      id: 31910,
      mediaType: "tv",
      totalEpisodes: 4,
      airedEpisodes: 3,
      seasons: [{ seasonNumber: 1, name: "第1季", episodeCount: 4, airDate: "2026-08-01" }],
    });
    const searchUrl = new URL(String(fetchImpl.mock.calls[0]?.[0]));
    const detailUrl = new URL(String(fetchImpl.mock.calls[1]?.[0]));
    const seasonUrl = new URL(String(fetchImpl.mock.calls[3]?.[0]));
    expect(searchUrl.searchParams.get("language")).toBe("zh-CN");
    expect(detailUrl.pathname).toBe("/3/tv/31910");
    expect(seasonUrl.pathname).toBe("/3/tv/223911/season/1");
    expect(seasonUrl.searchParams.get("language")).toBe("zh-CN");
    expect(progress).toEqual({
      seasonNumber: 1,
      airedEpisodes: 2,
      totalEpisodes: 4,
      lastAirDate: "2026-08-08",
      nextAirDate: "2026-08-15",
      // 不带宽限期（graceHours=0）时没有"今日更新"这一档，行为与旧口径一致。
      pendingEpisodes: 0,
    });
  });

  it("把当天播出的集单列为「今日更新」，过了宽限期才并进已播", async () => {
    // 同一次测试里要读三次响应体，所以每次调用都返回新的 Response（不能共用同一个实例）。
    const fetchImpl = vi.fn<TmdbFetch>().mockImplementation(async () =>
      Response.json({
        episodes: [
          { episode_number: 1, air_date: "2026-08-01" },
          { episode_number: 2, air_date: "2026-08-11" },
        ],
      }),
    );
    const client = createTmdbClient({ token: "tmdb-v4-token", fetchImpl });
    const morning = new Date(2026, 7, 11, 8, 0, 0);

    // 宽限期 0 = 旧口径：当天播出即算已播，白天就会拿它去比对库内已存
    await expect(client.seasonProgress(1, 1, morning, 0)).resolves.toMatchObject({
      airedEpisodes: 2,
      pendingEpisodes: 0,
    });
    // 默认 24 小时：当天 18 点更新、20 点才入库的那一集先进「今日更新」，不参与缺集
    await expect(client.seasonProgress(1, 1, morning, 24)).resolves.toMatchObject({
      airedEpisodes: 2,
      pendingEpisodes: 1,
    });
    // 次日 0 点宽限期结束：同一集不再算「今日更新」
    await expect(client.seasonProgress(1, 1, new Date(2026, 7, 12, 0, 30), 24)).resolves.toMatchObject({
      airedEpisodes: 2,
      pendingEpisodes: 0,
    });
  });

  it("isEpisodeAiredEnough：播出日当天 00:00 + 宽限期到期才算「播够了」", () => {
    expect(isEpisodeAiredEnough("2026-08-11", new Date(2026, 7, 11, 0, 0, 0), 0)).toBe(true);
    expect(isEpisodeAiredEnough("2026-08-11", new Date(2026, 7, 11, 23, 59, 59), 24)).toBe(false);
    expect(isEpisodeAiredEnough("2026-08-11", new Date(2026, 7, 12, 0, 0, 0), 24)).toBe(true);
    // 宽限期可以超过 24 小时（给夜间才入库的片源留余量）
    expect(isEpisodeAiredEnough("2026-08-11", new Date(2026, 7, 12, 5, 0, 0), 30)).toBe(false);
    expect(isEpisodeAiredEnough("2026-08-11", new Date(2026, 7, 12, 6, 0, 0), 30)).toBe(true);
    // 没有播出日的集（TMDB 未定档）永远不算"播够"
    expect(isEpisodeAiredEnough("", new Date(2026, 7, 12, 6, 0, 0), 0)).toBe(false);
  });

  it("reads episode numbers and Chinese names for the missing-episode overview", async () => {
    const fetchImpl = vi.fn<TmdbFetch>().mockResolvedValue(
      Response.json({
        episodes: [
          { episode_number: 2, name: "三年之约", air_date: "2026-08-08" },
          { episode_number: 1, name: "", air_date: "2026-08-01" },
          { episode_number: 3, name: "大结局", air_date: null },
        ],
      }),
    );
    const client = createTmdbClient({ token: "tmdb-v4-token", fetchImpl });

    await expect(client.seasonEpisodes(223911, 5)).resolves.toEqual([
      { episodeNumber: 1, name: null, airDate: "2026-08-01" },
      { episodeNumber: 2, name: "三年之约", airDate: "2026-08-08" },
      { episodeNumber: 3, name: "大结局", airDate: null },
    ]);
    const url = new URL(String(fetchImpl.mock.calls[0]?.[0]));
    expect(url.pathname).toBe("/3/tv/223911/season/5");
    expect(url.searchParams.get("language")).toBe("zh-CN");
  });

  it("counts episodes aired on the server-local calendar day", async () => {
    const fetchImpl = vi.fn<TmdbFetch>().mockResolvedValue(
      Response.json({
        id: 1,
        episodes: [
          { episode_number: 1, air_date: "2026-08-11" },
          { episode_number: 2, air_date: "2026-08-12" },
        ],
      }),
    );
    const client = createTmdbClient({ token: "tmdb-v4-token", fetchImpl });

    const progress = await client.seasonProgress(1, 1, new Date(2026, 7, 11, 0, 30));

    expect(progress.airedEpisodes).toBe(1);
    expect(progress.lastAirDate).toBe("2026-08-11");
    expect(progress.nextAirDate).toBe("2026-08-12");
  });
});
