import { mediaRequestStatuses, mediaRequestStatusLabels } from "@emby-task-center/contracts/media-request";

export interface RequestMedia {
  tmdbId: number;
  mediaType: "movie" | "tv";
  title: string;
  originalTitle?: string;
  releaseYear: number | null;
  posterUrl: string | null;
  overview?: string;
  seasons?: Array<{ seasonNumber: number; name: string | null; episodeCount: number; airDate: string | null }>;
}

export const requestStatuses = mediaRequestStatuses.map((value) => ({ value, label: mediaRequestStatusLabels[value] }));
export const requestStatusLabel = (value: string) =>
  requestStatuses.find((entry) => entry.value === value)?.label ?? value;
export const formatRequestDate = (value: string) => new Date(value).toLocaleString();
