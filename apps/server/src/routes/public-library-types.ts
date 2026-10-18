import type { MediaType } from "@emby-task-center/contracts/media";
export interface MediaRow {
  id: number;
  mediaType: MediaType;
  title: string;
  originalTitle: string | null;
  releaseYear: number | null;
  posterUrl: string | null;
  backdropUrl: string | null;
  overview: string | null;
  tmdbId: number | null;
  genres: string[];
  languages: string[];
  regions: string[];
  platforms: string[];
  seasonCount: number | null;
  episodeCount: number | null;
  aliases: string[];
  tmdbPayload: Record<string, unknown>;
}

export interface RawLibraryRow {
  id: number;
  mediaItemId: number | null;
  sourceTitle: string;
  sourceYear: number | null;
  tags: string[];
  updatedAt: string;
  posterPath: string | null;
  containerPath: string;
}

export interface LibraryGroup {
  id: string;
  title: string;
  mediaType: MediaType;
  year: number | null;
  posterUrl: string | null;
  posterPath: string | null;
  rootId: string | null;
  tmdbId: number | null;
  watchUrl: string | null;
  status: "matched" | "unresolved";
  fileCount: number;
  latestAt: string | null;
  tags: Set<string>;
  genres: string[];
  resolution: string | null;
  backdropUrl: string | null;
  originalTitle: string | null;
  overview: string | null;
  languages: string[];
  regions: string[];
  platforms: string[];
  seasonCount: number | null;
  episodeCount: number | null;
  aliases: string[];
  cast: string[];
  directors: string[];
  runtime: number | null;
  voteAverage: number | null;
  tmdbStatus: string | null;
}
