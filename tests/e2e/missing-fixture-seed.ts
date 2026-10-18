import type { AppDatabase } from "@emby-task-center/database/client";
import {
  appSettings,
  libraryEpisodes,
  libraryItems,
  mediaItems,
  mediaRoots,
  missingEpisodeSnapshots,
} from "@emby-task-center/database/schema";
import { episodeId, episodes, missingRoots, missingShows, missingSources } from "./missing-fixture-data";

/** Only used by a freshly created temporary database, never the development/production database. */
export function seedMissingEpisodes(database: AppDatabase) {
  const now = new Date().toISOString();
  for (const key of [
    "library.missingEpisodeScanIntervalMinutes",
    "library.scanIntervalMinutes",
    "library.airProgressRefreshMinutes",
  ])
    database.insert(appSettings).values({ key, value: "0", updatedAt: now, updatedBy: "isolated-e2e" }).run();
  missingRoots.forEach((root, index) => {
    database
      .insert(mediaRoots)
      .values({
        id: index + 1,
        name: root.name,
        mediaType: "tv",
        containerPath: `emby:${root.id}`,
        enabled: root.enabled,
        createdAt: now,
        updatedAt: now,
      })
      .run();
  });
  for (const show of missingShows) {
    database
      .insert(mediaItems)
      .values({
        id: show.id,
        tmdbId: show.tmdbId,
        title: show.title,
        mediaType: "tv",
        releaseYear: 2020,
        seasonCount: 1,
        episodeCount: show.aired,
        syncedAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    database
      .insert(missingEpisodeSnapshots)
      .values({
        mediaItemId: show.id,
        tmdbId: show.tmdbId,
        title: show.title,
        tmdbSeasons: [{ seasonNumber: 1, episodes: episodes(show.aired), fetchedAt: now }],
        fetchedAt: now,
        scannedAt: now,
      })
      .run();
  }
  for (const source of missingSources) {
    const show = missingShows[source.show];
    for (const number of source.numbers) {
      const id = episodeId(source.root, source.show, number);
      const item = database
        .insert(libraryItems)
        .values({
          mediaRootId: source.root + 1,
          mediaItemId: show.id,
          relativePath: `${show.title}/Season 1/EP${String(number).padStart(2, "0")} [${id}].strm`,
          embyItemId: id,
          sourceTitle: show.title,
          sourceYear: 2020,
          recognitionStatus: "matched",
          createdAt: now,
          updatedAt: now,
        })
        .returning()
        .get();
      for (let episode = number; episode <= (source.end ?? number); episode++)
        database
          .insert(libraryEpisodes)
          .values({
            libraryItemId: item.id,
            physicalSeason: 1,
            parsedSeason: 1,
            episodeNumber: episode,
            numberingMode: "seasonal",
            createdAt: now,
          })
          .run();
    }
  }
}
