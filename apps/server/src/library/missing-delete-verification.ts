import type { AppDatabase } from "@emby-task-center/database/client";
import type { TmdbSeasonEpisodesCache } from "@emby-task-center/database/schema";
import type { EmbyClient, EmbyLibraryItem } from "../integrations/emby-client";
import { embyEpisodeNumbers } from "../integrations/emby-episode-range";
import { applyNameGuard, computeMissingEpisodes, normalizeEpisodeName } from "./missing-episode-scan";
import { readMissingGraceHours } from "./missing-grace";

/** Destructive actions re-read complete episodes for the exact root candidates, including merged ranges. */
export async function verifyRootMissingForDeletion(
  database: AppDatabase,
  emby: EmbyClient,
  matches: EmbyLibraryItem[],
  tmdbSeasons: TmdbSeasonEpisodesCache[],
) {
  if (!emby.listItemEpisodes) throw new Error("emby_episode_read_failed");
  const stored = new Map<number, Set<number>>();
  const names = new Set<string>();
  try {
    for (const match of matches) {
      for (const episode of await emby.listItemEpisodes(match.id)) {
        if (episode.seasonNumber == null) throw new Error("unknown_season");
        let numbers = stored.get(episode.seasonNumber);
        if (!numbers) stored.set(episode.seasonNumber, (numbers = new Set()));
        for (const number of embyEpisodeNumbers(episode)) numbers.add(number);
        const normalized = normalizeEpisodeName(episode.name);
        if (normalized) names.add(normalized);
      }
    }
  } catch {
    throw new Error("emby_episode_read_failed");
  }
  const computed = computeMissingEpisodes(tmdbSeasons, stored, new Date(), readMissingGraceHours(database));
  return applyNameGuard(computed.missing, names).missing.some((season) => season.episodes.length > 0);
}
