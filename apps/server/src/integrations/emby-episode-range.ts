/** A single Emby file may cover several consecutive episodes. */
export interface EmbyEpisodeRange {
  seasonNumber?: number | null;
  episodeNumber: number | null;
  episodeNumberEnd?: number | null;
}

/** Emby permits unnumbered specials; they remain inventory without inventing a numbered episode. */
export function isUnnumberedEmbySpecial(episode: {
  seasonNumber?: unknown;
  episodeNumber?: unknown;
  episodeNumberEnd?: unknown;
}): boolean {
  return episode.seasonNumber === 0 && episode.episodeNumber == null && episode.episodeNumberEnd == null;
}

/** Reject malformed ranges before publishing a complete inventory. */
export function validateEmbyEpisodeRange(start: unknown, end: unknown): { start: number; end: number } {
  if (!Number.isSafeInteger(start) || (start as number) < 0) throw new Error("emby_episode_invalid_number");
  const last = end == null ? (start as number) : end;
  // Bound one file's expansion so corrupt metadata cannot allocate an unbounded array.
  if (
    !Number.isSafeInteger(last) ||
    (last as number) < (start as number) ||
    (last as number) - (start as number) >= 10_000
  ) {
    throw new Error("emby_episode_invalid_range");
  }
  return { start: start as number, end: last as number };
}

export function embyEpisodeNumbers(episode: EmbyEpisodeRange): number[] {
  if (isUnnumberedEmbySpecial(episode)) return [];
  const range = validateEmbyEpisodeRange(episode.episodeNumber, episode.episodeNumberEnd);
  return Array.from({ length: range.end - range.start + 1 }, (_, index) => range.start + index);
}
