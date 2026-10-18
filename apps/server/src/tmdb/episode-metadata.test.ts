import { describe, expect, it, vi } from "vitest";
import { createTmdbClient, type TmdbFetch } from "./client";

function client(payload: unknown) {
  const fetchImpl = vi.fn<TmdbFetch>().mockImplementation(async () => Response.json(payload));
  return createTmdbClient({ token: "test-token", fetchImpl });
}
describe("strict TMDB episode metadata", () => {
  it.each([
    null,
    {},
    { seasons: null },
    { seasons: [null] },
    { seasons: [{ season_number: 1, episode_count: null, air_date: null }] },
    { seasons: [{ season_number: 1, episode_count: 1, air_date: "bad-date" }] },
  ])("rejects malformed TV season descriptors instead of normalizing them to empty: %j", async (fields) => {
    await expect(client({ id: 100, name: "测试剧", ...fields }).details("tv", 100)).rejects.toThrow();
  });
  it("accepts explicit empty seasons and valid season zero specials", async () => {
    await expect(client({ id: 100, name: "测试剧", seasons: [] }).details("tv", 100)).resolves.toMatchObject({
      seasons: [],
    });
    await expect(
      client({ id: 100, name: "测试剧", seasons: [{ season_number: 0, episode_count: 0, air_date: null }] }).details(
        "tv",
        100,
      ),
    ).resolves.toMatchObject({ seasons: [{ seasonNumber: 0, episodeCount: 0 }] });
  });
  it.each([
    null,
    {},
    { episodes: null },
    { episodes: [null] },
    { episodes: [{ episode_number: null, air_date: null }] },
    { episodes: [{ episode_number: 1, air_date: "2026-02-30" }] },
    {
      episodes: [
        { episode_number: 1, air_date: null },
        { episode_number: 1, air_date: null },
      ],
    },
  ])("rejects malformed episode rows without silently discarding them: %j", async (payload) => {
    await expect(client(payload).seasonEpisodes(100, 1)).rejects.toThrow();
  });
  it("keeps the existing integer episode rule and nullable air dates", async () => {
    await expect(
      client({
        episodes: [
          { episode_number: 0, air_date: null },
          { episode_number: -1, air_date: "2020-01-01" },
        ],
      }).seasonEpisodes(100, 0),
    ).resolves.toEqual([
      { episodeNumber: -1, name: null, airDate: "2020-01-01" },
      { episodeNumber: 0, name: null, airDate: null },
    ]);
  });
});
