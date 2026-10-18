import { describe, expect, it } from "vitest";
import { createEmbyLibraryReader } from "./emby-library-reader";

function reader(items: unknown[]) {
  return createEmbyLibraryReader(async () => ({ Items: items, TotalRecordCount: items.length }));
}

describe("validated Emby library conversion", () => {
  it.each([undefined, null, "", 0, "not a year"])(
    "does not invent a year for absent or invalid ProductionYear %s",
    async (year) => {
      const items = await reader([{ Id: "m", Type: "Movie", Name: "A", ProductionYear: year }]).listLibraryItems();
      expect(items[0]!.year).toBeNull();
    },
  );

  it("retains real production years and rejects the wrong requested media type", async () => {
    const source = reader([{ Id: "m", Type: "Movie", Name: "A", ProductionYear: 2024 }]);
    expect((await source.listLibraryItems())[0]!.year).toBe(2024);
    await expect(source.listLibraryItems({ mediaType: "tv" })).rejects.toThrow("emby_library_invalid_item");
  });

  it.each([undefined, null, "1", -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects a malformed episode number %s without returning the valid prefix",
    async (number) => {
      await expect(
        reader([
          { Id: "valid", Type: "Episode", IndexNumber: 1, ParentIndexNumber: 1 },
          { Id: "invalid", Type: "Episode", IndexNumber: number, ParentIndexNumber: 1 },
        ]).listItemEpisodes("show"),
      ).rejects.toThrow("emby_episode_invalid_number");
    },
  );

  it.each(["1", -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects a malformed season number %s instead of treating it as a special",
    async (number) => {
      await expect(
        reader([{ Id: "e", IndexNumber: 1, ParentIndexNumber: number }]).listItemEpisodes("show"),
      ).rejects.toThrow("emby_episode_invalid_season");
    },
  );

  it("accepts specials, episode zero and unknown season numbers without filtering records", async () => {
    const episodes = await reader([
      { Id: "zero", Type: "Episode", IndexNumber: 0, ParentIndexNumber: 0 },
      { Id: "unknown", IndexNumber: 1 },
      { Id: "null", IndexNumber: 2, ParentIndexNumber: null },
    ]).listItemEpisodes("show");
    expect(episodes.map((episode) => [episode.id, episode.seasonNumber, episode.episodeNumber])).toEqual([
      ["zero", 0, 0],
      ["unknown", null, 1],
      ["null", null, 2],
    ]);
  });

  it("rejects an explicitly wrong episode type", async () => {
    await expect(reader([{ Id: "e", Type: "Season", IndexNumber: 1 }]).listItemEpisodes("show")).rejects.toThrow(
      "emby_episode_invalid_type",
    );
  });
});
