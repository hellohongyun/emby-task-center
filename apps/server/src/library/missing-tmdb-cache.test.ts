import { describe, expect, it, vi } from "vitest";
import type { TmdbClient } from "../tmdb/client";
import {
  createMissingTmdbLoader,
  describeMissingMetadata,
  TMDB_CACHE_TTL_MS,
  TMDB_RETRY_MS,
} from "./missing-tmdb-cache";

const now = new Date("2026-10-03T00:00:00Z");
const oldAt = new Date(now.getTime() - TMDB_CACHE_TTL_MS - 1).toISOString();
const episode = (number: number) => ({ episodeNumber: number, name: `集${number}`, airDate: "2020-01-01" });
const old = {
  fetchedAt: oldAt,
  tmdbSeasons: [
    { seasonNumber: 1, episodes: [episode(1), episode(2)] },
    { seasonNumber: 2, episodes: [episode(1), episode(2)] },
  ],
};
function fixture() {
  const details = vi.fn().mockResolvedValue({
    seasons: [1, 2].map((seasonNumber) => ({ seasonNumber, episodeCount: 2, airDate: "2020-01-01" })),
  });
  const seasonEpisodes = vi.fn().mockImplementation(async (_id: number, season: number) => {
    if (season === 2) throw new Error("season failed");
    return [episode(1), episode(2), episode(3)];
  });
  const tmdb = { details, seasonEpisodes } as unknown as TmdbClient;
  return { tmdb, details, seasonEpisodes };
}

describe("missing TMDB metadata cache", () => {
  it.each([
    { seasons: undefined },
    { seasons: null },
    { seasons: [{ seasonNumber: 1, episodeCount: -1, airDate: null }] },
    { seasons: [{ seasonNumber: 1, episodeCount: 2, airDate: "2026-02-30" }] },
  ])("preserves all cached data when season descriptors are missing or malformed: %j", async ({ seasons }) => {
    const { tmdb, details, seasonEpisodes } = fixture();
    details.mockResolvedValue({ seasons });
    const result = await createMissingTmdbLoader(tmdb).load(100, "2026-10-03", now, old);
    expect(result.health?.error).toBe("tmdb_unavailable");
    expect(result.fetchedAt).toBe(oldAt);
    expect(result.seasons.map((season) => season.episodes)).toEqual(old.tmdbSeasons.map((season) => season.episodes));
    expect(seasonEpisodes).not.toHaveBeenCalled();
  });

  it("accepts an explicit valid empty season list", async () => {
    const { tmdb, details, seasonEpisodes } = fixture();
    details.mockResolvedValue({ seasons: [] });
    const result = await createMissingTmdbLoader(tmdb).load(100, "2026-10-03", now, old);
    expect(result).toEqual({ seasons: [], fetchedAt: now.toISOString(), health: null });
    expect(seasonEpisodes).not.toHaveBeenCalled();
  });

  it.each([
    { episodes: [episode(1)] },
    { episodes: [episode(1), { ...episode(2), episodeNumber: null }] },
    { episodes: [episode(1), episode(1)] },
    { episodes: [episode(1), { ...episode(2), airDate: "invalid" }] },
  ])("treats incomplete or invalid episodes as a failed season: %j", async ({ episodes }) => {
    const { tmdb, seasonEpisodes } = fixture();
    seasonEpisodes.mockResolvedValue(episodes);
    const result = await createMissingTmdbLoader(tmdb).load(100, "2026-10-03", now, old);
    expect(result.health?.failedSeasons).toEqual([1, 2]);
    expect(result.fetchedAt).toBe(oldAt);
    expect(result.seasons.map((season) => season.episodes)).toEqual(old.tmdbSeasons.map((season) => season.episodes));
  });

  it("retains failed season rows and does not advance the complete timestamp", async () => {
    const { tmdb } = fixture();
    const result = await createMissingTmdbLoader(tmdb).load(100, "2026-10-03", now, old);
    expect(result.fetchedAt).toBe(oldAt);
    expect(result.seasons[0]?.episodes).toHaveLength(3);
    expect(result.seasons[1]).toMatchObject({
      episodes: old.tmdbSeasons[1]?.episodes,
      refreshError: "tmdb_season_unavailable",
      unavailable: false,
    });
    expect(result.health).toMatchObject({
      failedSeasons: [2],
      unavailableSeasons: [],
      lastCompleteAt: oldAt,
      retryAt: new Date(now.getTime() + TMDB_RETRY_MS).toISOString(),
    });
    expect(describeMissingMetadata({ tmdbSeasons: result.seasons, fetchedAt: result.fetchedAt })).toEqual(
      result.health,
    );
  });

  it("recovers the five-minute retry guard across restart and retries only the failed season", async () => {
    const { tmdb, details, seasonEpisodes } = fixture();
    const failed = await createMissingTmdbLoader(tmdb).load(100, "2026-10-03", now, old);
    const restarted = createMissingTmdbLoader(tmdb);
    const persisted = { tmdbSeasons: failed.seasons, fetchedAt: failed.fetchedAt };
    await restarted.load(100, "2026-10-03", new Date(now.getTime() + 1), persisted);
    expect(details).toHaveBeenCalledTimes(1);
    seasonEpisodes.mockResolvedValue([episode(1), episode(2)]);
    const recovered = await restarted.load(100, "2026-10-03", new Date(now.getTime() + TMDB_RETRY_MS), persisted);
    expect(details).toHaveBeenCalledTimes(2);
    expect(seasonEpisodes.mock.calls.map((call) => call[1])).toEqual([1, 2, 2]);
    expect(recovered.health).toBeNull();
    expect(recovered.fetchedAt).toBe(now.toISOString());
    expect(recovered.seasons.some((season) => season.refreshError)).toBe(false);
  });

  it("marks a never-fetched season unavailable instead of treating it as zero aired episodes", async () => {
    const { tmdb } = fixture();
    const result = await createMissingTmdbLoader(tmdb).load(100, "2026-10-03", now);
    expect(result.fetchedAt).toBeNull();
    expect(result.health?.unavailableSeasons).toEqual([2]);
    expect(result.seasons[1]).toMatchObject({ unavailable: true, episodes: [] });
  });

  it("rejects an empty response for a populated season", async () => {
    const { tmdb, seasonEpisodes } = fixture();
    seasonEpisodes.mockResolvedValue([]);
    const result = await createMissingTmdbLoader(tmdb).load(100, "2026-10-03", now, old);
    expect(result.health?.failedSeasons).toEqual([1, 2]);
    expect(result.seasons.map((season) => season.episodes)).toEqual(old.tmdbSeasons.map((season) => season.episodes));
  });

  it("keeps all old seasons when TV details fail", async () => {
    const { tmdb, details } = fixture();
    details.mockRejectedValue(new Error("offline"));
    const result = await createMissingTmdbLoader(tmdb).load(100, "2026-10-03", now, old);
    expect(result.health?.error).toBe("tmdb_unavailable");
    expect(result.seasons.map((season) => season.episodes)).toEqual(old.tmdbSeasons.map((season) => season.episodes));
    expect(result.fetchedAt).toBe(oldAt);
  });
});
