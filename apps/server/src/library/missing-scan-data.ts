import { and, eq, isNotNull, sql } from "drizzle-orm";
import type { AppDatabase } from "@emby-task-center/database/client";
import { libraryEpisodes, libraryItems, mediaItems, missingEpisodeSnapshots } from "@emby-task-center/database/schema";

export function loadMissingScanData(database: AppDatabase) {
  return database.transaction((transaction) => {
    const episodes = transaction
      .select({
        mediaItemId: libraryItems.mediaItemId,
        season: libraryEpisodes.parsedSeason,
        episode: libraryEpisodes.episodeNumber,
        absolute: libraryEpisodes.absoluteEpisodeNumber,
      })
      .from(libraryEpisodes)
      .innerJoin(libraryItems, eq(libraryItems.id, libraryEpisodes.libraryItemId))
      .where(isNotNull(libraryItems.mediaItemId))
      .all();
    const storedByItem = new Map<number, Map<number, Set<number>>>();
    for (const row of episodes) {
      const episode = row.episode ?? row.absolute;
      if (row.mediaItemId == null || episode == null) continue;
      let seasons = storedByItem.get(row.mediaItemId);
      if (!seasons) storedByItem.set(row.mediaItemId, (seasons = new Map()));
      const season = row.season ?? 0;
      let numbers = seasons.get(season);
      if (!numbers) seasons.set(season, (numbers = new Set()));
      numbers.add(episode);
    }
    const sourceTitles = new Map(
      transaction
        .select({
          mediaItemId: libraryItems.mediaItemId,
          title: sql<string>`MIN(${libraryItems.sourceTitle})`,
        })
        .from(libraryItems)
        .where(isNotNull(libraryItems.mediaItemId))
        .groupBy(libraryItems.mediaItemId)
        .all()
        .filter((row) => row.mediaItemId != null && row.title)
        .map((row) => [row.mediaItemId!, row.title] as const),
    );
    const candidates = transaction
      .select({ id: mediaItems.id, tmdbId: mediaItems.tmdbId, title: mediaItems.title })
      .from(mediaItems)
      .where(and(eq(mediaItems.mediaType, "tv"), isNotNull(mediaItems.tmdbId)))
      .all()
      .filter((item) => item.tmdbId != null && storedByItem.has(item.id));
    const previousByItem = new Map(
      transaction
        .select()
        .from(missingEpisodeSnapshots)
        .all()
        .map((row) => [row.mediaItemId, row] as const),
    );
    return {
      candidates,
      read(id: number) {
        return {
          stored: storedByItem.get(id) ?? new Map<number, Set<number>>(),
          sourceTitle: sourceTitles.get(id),
          previous: previousByItem.get(id),
        };
      },
    };
  });
}
export type MissingScanCandidate = ReturnType<typeof loadMissingScanData>["candidates"][number];
export type MissingScanItem = ReturnType<ReturnType<typeof loadMissingScanData>["read"]>;
