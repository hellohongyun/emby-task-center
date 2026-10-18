import { and, eq, inArray } from "drizzle-orm";
import type { AppDatabase } from "@emby-task-center/database/client";
import {
  libraryEpisodes,
  libraryItems,
  mediaItems,
  mediaRoots,
  missingEpisodeSnapshots,
} from "@emby-task-center/database/schema";
import { computeMissingEpisodes } from "./missing-episode-scan";
import { readMissingGraceHours } from "./missing-grace";
import { describeMissingMetadata, type MissingMetadataIssue } from "./missing-tmdb-cache";

export function missingEpisodeRoots(database: AppDatabase) {
  return database
    .select()
    .from(mediaRoots)
    .where(eq(mediaRoots.enabled, true))
    .all()
    .filter(
      (root) => root.mediaType !== "movie" && root.containerPath.startsWith("emby:") && root.containerPath.length > 5,
    )
    .map((root) => ({ ...root, rootId: root.containerPath.slice(5) }));
}
export type MissingEpisodeRoot = ReturnType<typeof missingEpisodeRoots>[number];

/** Public root IDs are exact upstream IDs; never interpret one as a local row ID. */
export function resolveMissingEpisodeRoot(database: AppDatabase, rootId: string) {
  return missingEpisodeRoots(database).find((root) => root.rootId === rootId);
}

/** Read only the selected root's indexed inventory, never the all-library episode union. */
export function readRootMissingEpisodes(
  database: AppDatabase,
  root: MissingEpisodeRoot,
  options: { mediaItemIds?: number[]; metadataIssues?: MissingMetadataIssue[]; now?: Date } = {},
) {
  if (options.mediaItemIds?.length === 0) return [];
  const inventory = database
    .select({
      id: libraryItems.id,
      mediaItemId: libraryItems.mediaItemId,
      relativePath: libraryItems.relativePath,
    })
    .from(libraryItems)
    .where(
      and(
        eq(libraryItems.mediaRootId, root.id),
        options.mediaItemIds ? inArray(libraryItems.mediaItemId, options.mediaItemIds) : undefined,
      ),
    )
    .all();
  const itemIds = [...new Set(inventory.flatMap((item) => (item.mediaItemId == null ? [] : [item.mediaItemId])))];
  if (!itemIds.length) return [];
  const inventoryByItem = new Map<number, typeof inventory>();
  for (const entry of inventory) {
    if (entry.mediaItemId == null) continue;
    let group = inventoryByItem.get(entry.mediaItemId);
    if (!group) inventoryByItem.set(entry.mediaItemId, (group = []));
    group.push(entry);
  }
  const items = database
    .select({ id: mediaItems.id, tmdbId: mediaItems.tmdbId, title: mediaItems.title, posterUrl: mediaItems.posterUrl })
    .from(mediaItems)
    .where(and(inArray(mediaItems.id, itemIds), eq(mediaItems.mediaType, "tv")))
    .all();
  const snapshots = new Map(
    database
      .select()
      .from(missingEpisodeSnapshots)
      .where(inArray(missingEpisodeSnapshots.mediaItemId, itemIds))
      .all()
      .map((row) => [row.mediaItemId, row]),
  );
  const issues = new Map((options.metadataIssues ?? []).map((issue) => [issue.mediaItemId, issue]));
  const stored = new Map<number, Map<number, Set<number>>>();
  const episodes = database
    .select({
      mediaItemId: libraryItems.mediaItemId,
      season: libraryEpisodes.parsedSeason,
      episode: libraryEpisodes.episodeNumber,
      absolute: libraryEpisodes.absoluteEpisodeNumber,
    })
    .from(libraryItems)
    .innerJoin(libraryEpisodes, eq(libraryEpisodes.libraryItemId, libraryItems.id))
    .where(
      and(
        eq(libraryItems.mediaRootId, root.id),
        options.mediaItemIds ? inArray(libraryItems.mediaItemId, options.mediaItemIds) : undefined,
      ),
    )
    .all();
  for (const row of episodes) {
    const number = row.episode ?? row.absolute;
    if (row.mediaItemId == null || number == null) continue;
    let seasons = stored.get(row.mediaItemId);
    if (!seasons) stored.set(row.mediaItemId, (seasons = new Map()));
    const season = row.season ?? 0;
    let numbers = seasons.get(season);
    if (!numbers) seasons.set(season, (numbers = new Set()));
    numbers.add(number);
  }
  const now = options.now ?? new Date();
  const graceHours = readMissingGraceHours(database);
  return items.flatMap((item) => {
    const candidate = snapshots.get(item.id);
    const snapshot = candidate?.tmdbId === item.tmdbId ? candidate : undefined;
    const issueCandidate = issues.get(item.id);
    const issue = issueCandidate?.tmdbId === item.tmdbId ? issueCandidate : undefined;
    const seasons = stored.get(item.id) ?? new Map<number, Set<number>>();
    const metadata = issue ?? (snapshot ? describeMissingMetadata(snapshot) : null);
    const usable =
      snapshot &&
      snapshot.fetchedAt &&
      snapshot.tmdbSeasons.length > 0 &&
      !snapshot.tmdbSeasons.some((season) => season.unavailable);
    const computed = computeMissingEpisodes(usable ? snapshot.tmdbSeasons : [], seasons, now, graceHours);
    const ownInventory = inventoryByItem.get(item.id) ?? [];
    const folder = ownInventory[0]?.relativePath.split("/").filter(Boolean).slice(0, -1)[0] ?? "";
    return [
      {
        mediaItemId: item.id,
        tmdbId: item.tmdbId,
        title: item.title,
        posterUrl: item.posterUrl,
        airProgress: computed.airedCount,
        storedProgress: computed.storedCount,
        missingCount: computed.missingCount,
        pendingCount: computed.pendingCount,
        libraries: [
          {
            rootId: root.rootId,
            name: root.name,
            mediaType: root.mediaType,
            episodeCount: [...seasons.values()].reduce((sum, numbers) => sum + numbers.size, 0),
            fileCount: ownInventory.length,
            seasons: [...seasons.keys()].sort((a, b) => a - b),
            path: folder,
          },
        ],
        unmatchedSeasons: computed.unmatched,
        suspectSeasons: computed.suspects,
        seasons: computed.missing.map((season) => ({ ...season, embySeasonId: null })),
        pendingSeasons: computed.pending.map((season) => ({ ...season, embySeasonId: null })),
        // Inventory does not persist a trustworthy parent ID; global search IDs may belong to another root.
        embySeriesId: null,
        embyTmdbId: null,
        error: snapshot?.error?.startsWith("tmdb_") ? snapshot.error : usable ? null : "metadata_incomplete",
        metadata,
        scannedAt: snapshot?.scannedAt ?? null,
      },
    ];
  });
}
