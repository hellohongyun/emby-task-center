import type { PublicLibraryListItem, PublicLibraryFacets } from "./public-library";
const RESOLUTIONS = ["2160p", "1080p", "720p", "480p"] as const;
export function buildFacets(items: PublicLibraryListItem[]): PublicLibraryFacets {
  const types: PublicLibraryFacets["types"] = { all: items.length, movie: 0, tv: 0 };
  const statuses: PublicLibraryFacets["statuses"] = { all: items.length, matched: 0, unresolved: 0 };
  const resolutionCounts = new Map<string, number>();
  const codecCounts = new Map<string, number>();
  const genreCounts = new Map<string, number>();
  const actorCounts = new Map<string, number>();
  const years = new Set<number>();
  for (const item of items) {
    types[item.mediaType] += 1;
    statuses[item.status] += 1;
    if (item.resolution) resolutionCounts.set(item.resolution, (resolutionCounts.get(item.resolution) ?? 0) + 1);
    for (const codec of item.codecs ?? []) codecCounts.set(codec, (codecCounts.get(codec) ?? 0) + 1);
    for (const genre of item.genres ?? []) genreCounts.set(genre, (genreCounts.get(genre) ?? 0) + 1);
    for (const actor of (item.cast ?? []).slice(0, 10)) actorCounts.set(actor, (actorCounts.get(actor) ?? 0) + 1);
    if (item.year != null) years.add(item.year);
  }
  return {
    types,
    statuses,
    resolutions: [...resolutionCounts.keys()].sort(
      (left, right) =>
        RESOLUTIONS.indexOf(left as (typeof RESOLUTIONS)[number]) -
        RESOLUTIONS.indexOf(right as (typeof RESOLUTIONS)[number]),
    ),
    codecs: [...codecCounts.keys()]
      .filter((codec) => !RESOLUTIONS.includes(codec as (typeof RESOLUTIONS)[number]))
      .sort((left, right) => left.localeCompare(right, "zh-CN")),
    genres: [...genreCounts.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0], "zh-CN"))
      .map(([genre]) => genre),
    actors: [...actorCounts.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0], "zh-CN"))
      .map(([actor]) => actor),
    years: [...years].sort((left, right) => right - left),
  };
}
