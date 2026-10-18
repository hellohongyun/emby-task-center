import type { TmdbEpisode, TmdbSeason } from "./client";

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
export function validMetadataDate(value: unknown): value is string | null {
  if (value === null) return true;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
export function validSeasonMetadata(value: unknown): value is TmdbSeason[] {
  if (!Array.isArray(value)) return false;
  const seen = new Set<number>();
  return value.every((season) => {
    if (
      !record(season) ||
      !Number.isInteger(season.seasonNumber) ||
      (season.seasonNumber as number) < 0 ||
      !Number.isInteger(season.episodeCount) ||
      (season.episodeCount as number) < 0 ||
      !validMetadataDate(season.airDate) ||
      seen.has(season.seasonNumber as number)
    )
      return false;
    seen.add(season.seasonNumber as number);
    return true;
  });
}
export function validEpisodeMetadata(value: unknown): value is TmdbEpisode[] {
  if (!Array.isArray(value)) return false;
  const seen = new Set<number>();
  return value.every((episode) => {
    // Preserve the existing integer numbering rule, including special 0/negative numbers.
    if (
      !record(episode) ||
      !Number.isInteger(episode.episodeNumber) ||
      !validMetadataDate(episode.airDate) ||
      seen.has(episode.episodeNumber as number)
    )
      return false;
    seen.add(episode.episodeNumber as number);
    return true;
  });
}
export function parseSeasonMetadata(payload: unknown): TmdbSeason[] {
  if (!record(payload) || !Array.isArray(payload.seasons)) throw new Error("TMDB returned invalid season descriptors.");
  const seasons = payload.seasons.map((season: unknown) => {
    if (!record(season)) throw new Error("TMDB returned invalid season descriptors.");
    return {
      seasonNumber: season.season_number,
      episodeCount: season.episode_count,
      airDate: season.air_date,
      name: typeof season.name === "string" ? season.name : null,
    };
  });
  if (!validSeasonMetadata(seasons)) throw new Error("TMDB returned invalid season descriptors.");
  return seasons;
}
export function parseEpisodeMetadata(payload: unknown): TmdbEpisode[] {
  if (!record(payload) || !Array.isArray(payload.episodes)) throw new Error("TMDB returned invalid episode data.");
  const episodes = payload.episodes.map((episode: unknown) => {
    if (!record(episode)) throw new Error("TMDB returned invalid episode data.");
    return {
      episodeNumber: episode.episode_number,
      airDate: episode.air_date,
      name: typeof episode.name === "string" && episode.name.trim() ? episode.name : null,
    };
  });
  if (!validEpisodeMetadata(episodes)) throw new Error("TMDB returned invalid episode data.");
  return episodes.sort((left, right) => left.episodeNumber - right.episodeNumber);
}
