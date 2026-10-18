import type { TmdbSeasonEpisodesCache } from "@emby-task-center/database/schema";
import type { TmdbClient } from "../tmdb/client";
import { validEpisodeMetadata, validSeasonMetadata } from "../tmdb/episode-metadata";

export const TMDB_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
export const TMDB_RETRY_MS = 5 * 60 * 1000;
export interface MissingMetadataHealth {
  stale: true;
  error: "tmdb_unavailable" | "tmdb_partial_unavailable";
  failedSeasons: number[];
  unavailableSeasons: number[];
  lastCompleteAt: string | null;
  expiresAt: string | null;
  attemptedAt: string;
  retryAt: string;
}
export interface MissingMetadataIssue extends MissingMetadataHealth {
  mediaItemId: number;
  tmdbId: number | null;
  title: string;
}
export interface PreviousMissingCache {
  tmdbSeasons: TmdbSeasonEpisodesCache[];
  fetchedAt: string | null;
  error?: string | null;
  scannedAt?: string;
  health?: MissingMetadataHealth | null;
}
interface SeasonResult {
  seasons: TmdbSeasonEpisodesCache[];
  fetchedAt: string | null;
  health: MissingMetadataHealth | null;
}
const validTime = (value: string | null | undefined) => (value ? Date.parse(value) : Number.NaN);

/** Persisted JSON fields also recover failure/retry state after a restart. */
export function describeMissingMetadata(previous: PreviousMissingCache): MissingMetadataHealth | null {
  if (previous.health) return previous.health;
  const failed = previous.tmdbSeasons.filter((season) => season.refreshError);
  if (!failed.length && !previous.error?.startsWith("tmdb_")) return null;
  const attempts = failed.map((season) => validTime(season.refreshFailedAt)).filter(Number.isFinite);
  const fallback = validTime(previous.scannedAt);
  const attemptedMs = attempts.length ? Math.max(...attempts) : Number.isFinite(fallback) ? fallback : Date.now();
  const retryTimes = failed.map((season) => validTime(season.retryAt)).filter(Number.isFinite);
  const completeAt = validTime(previous.fetchedAt);
  return {
    stale: true,
    error:
      failed.some((season) => season.refreshError === "tmdb_unavailable") || previous.error === "tmdb_unavailable"
        ? "tmdb_unavailable"
        : "tmdb_partial_unavailable",
    failedSeasons: failed.map((season) => season.seasonNumber),
    unavailableSeasons: failed.filter((season) => season.unavailable).map((season) => season.seasonNumber),
    lastCompleteAt: previous.fetchedAt,
    expiresAt: Number.isFinite(completeAt) ? new Date(completeAt + TMDB_CACHE_TTL_MS).toISOString() : null,
    attemptedAt: new Date(attemptedMs).toISOString(),
    retryAt: new Date(retryTimes.length ? Math.min(...retryTimes) : attemptedMs + TMDB_RETRY_MS).toISOString(),
  };
}

/** Successful seasons are retained; a partial response never advances the complete-cache timestamp. */
export function createMissingTmdbLoader(tmdb: TmdbClient) {
  const failures = new Map<number, SeasonResult>();

  async function load(tvId: number, today: string, now: Date, previous?: PreviousMissingCache): Promise<SeasonResult> {
    const nowMs = now.getTime();
    const memory = failures.get(tvId);
    const prior: SeasonResult = memory ?? {
      seasons: previous?.tmdbSeasons ?? [],
      fetchedAt: previous?.fetchedAt ?? null,
      health: previous ? describeMissingMetadata(previous) : null,
    };
    if (prior.health && validTime(prior.health.retryAt) > nowMs) return prior;
    if (!prior.health && nowMs - validTime(prior.fetchedAt) < TMDB_CACHE_TTL_MS) return prior;
    const attemptedAt = now.toISOString();
    const retryAt = new Date(nowMs + TMDB_RETRY_MS).toISOString();
    const oldBySeason = new Map(prior.seasons.map((season) => [season.seasonNumber, season]));
    let seasons: TmdbSeasonEpisodesCache[] = [];
    let detailFailed = false;
    try {
      const details = await tmdb.details("tv", tvId);
      if (!validSeasonMetadata(details.seasons)) throw new Error("invalid_seasons");
      const targets = details.seasons.filter(
        (season) => season.seasonNumber >= 1 && season.episodeCount > 0 && (!season.airDate || season.airDate <= today),
      );
      for (const season of targets) {
        const old = oldBySeason.get(season.seasonNumber);
        const fetchedAt = old?.fetchedAt ?? prior.fetchedAt;
        // On a partial retry, don't refetch the other seasons that just succeeded.
        if (old && !old.refreshError && nowMs - validTime(fetchedAt) < TMDB_CACHE_TTL_MS) {
          seasons.push(old);
          continue;
        }
        try {
          const episodes = await tmdb.seasonEpisodes(tvId, season.seasonNumber);
          // A populated season descriptor paired with no episode rows is incomplete metadata.
          if (!validEpisodeMetadata(episodes) || episodes.length < season.episodeCount)
            throw new Error("incomplete_season");
          seasons.push({ seasonNumber: season.seasonNumber, episodes, fetchedAt: attemptedAt });
        } catch {
          seasons.push({
            seasonNumber: season.seasonNumber,
            episodes: old?.episodes ?? [],
            fetchedAt,
            refreshFailedAt: attemptedAt,
            retryAt,
            refreshError: "tmdb_season_unavailable",
            unavailable: !old || old.unavailable === true || !old.episodes.length,
          });
        }
      }
    } catch {
      detailFailed = true;
      seasons = prior.seasons.map((season) => ({
        ...season,
        fetchedAt: season.fetchedAt ?? prior.fetchedAt,
        refreshFailedAt: attemptedAt,
        retryAt,
        refreshError: "tmdb_unavailable",
      }));
    }
    const partial = detailFailed || seasons.some((season) => season.refreshError);
    const fetchedAt = partial
      ? prior.fetchedAt
      : new Date(Math.min(nowMs, ...seasons.map((season) => validTime(season.fetchedAt) || nowMs))).toISOString();
    const health: MissingMetadataHealth | null = partial
      ? {
          stale: true,
          error: detailFailed ? "tmdb_unavailable" : "tmdb_partial_unavailable",
          failedSeasons: seasons.filter((season) => season.refreshError).map((season) => season.seasonNumber),
          unavailableSeasons: seasons.filter((season) => season.unavailable).map((season) => season.seasonNumber),
          lastCompleteAt: prior.fetchedAt,
          expiresAt: Number.isFinite(validTime(prior.fetchedAt))
            ? new Date(validTime(prior.fetchedAt) + TMDB_CACHE_TTL_MS).toISOString()
            : null,
          attemptedAt,
          retryAt,
        }
      : null;
    const result = { seasons, fetchedAt, health };
    if (health) failures.set(tvId, result);
    else failures.delete(tvId);
    return result;
  }

  return { load };
}
