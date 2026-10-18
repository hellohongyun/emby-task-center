import { and, eq, inArray, type SQL } from "drizzle-orm";
import type { AppDatabase } from "@emby-task-center/database/client";
import { libraryEpisodes, libraryItems, mediaItems, mediaRoots } from "@emby-task-center/database/schema";
import { itemId } from "./scan-items";
import type { LibraryInventoryItem, LibraryRootConfig, LibraryRoot } from "./service";

export function readInventory(database: AppDatabase, root: LibraryRootConfig, filter?: SQL): LibraryInventoryItem[] {
  const rootRow = database.select().from(mediaRoots).where(eq(mediaRoots.containerPath, root.path)).get();
  if (!rootRow?.enabled) return [];
  const condition = and(eq(libraryItems.mediaRootId, rootRow.id), filter);
  const itemRows = database.select().from(libraryItems).where(condition).all();
  const mediaInfo = database
    .select({
      id: mediaItems.id,
      genres: mediaItems.genres,
      tmdbPayload: mediaItems.tmdbPayload,
    })
    .from(mediaItems)
    .where(
      inArray(mediaItems.id, database.select({ id: libraryItems.mediaItemId }).from(libraryItems).where(condition)),
    )
    .all();
  const mediaById = new Map(mediaInfo.map((row) => [row.id, row]));

  /*
   * 剧集明细**一条 SQL 全取**，不再按条目逐个查。
   *
   * 原因：原来是在 .map() 里对每个条目发一次 `WHERE library_item_id = ?`，最大的库根有 66,202 条，
   * 于是一次 inventory = 66,203 次同步查询，全部跑在 Node 事件循环上。合成一条子查询后是 1 次。
   * 这里刻意用子查询而不是 `IN (id, id, ...)`：66,202 个参数会超过 SQLite 的变量上限。
   *
   * ORDER BY 显式指定，不依赖索引顺序：下面用 episodes[0] 推身份（physical/parsed/编号模式），
   * 没有 ORDER BY 时"第一条是哪条"取决于查询计划，换台机器或换个索引就可能变。
   */
  const episodeRows = itemRows.length
    ? database
        .select()
        .from(libraryEpisodes)
        .where(
          inArray(
            libraryEpisodes.libraryItemId,
            database.select({ id: libraryItems.id }).from(libraryItems).where(condition),
          ),
        )
        .orderBy(libraryEpisodes.libraryItemId, libraryEpisodes.parsedSeason, libraryEpisodes.episodeNumber)
        .all()
    : [];
  const episodesByItem = new Map<number, typeof episodeRows>();
  for (const episode of episodeRows) {
    const bucket = episodesByItem.get(episode.libraryItemId);
    if (bucket) bucket.push(episode);
    else episodesByItem.set(episode.libraryItemId, [episode]);
  }

  return itemRows.map((row) => {
    const episodes = episodesByItem.get(row.id) ?? [];
    const media = row.mediaItemId != null ? mediaById.get(row.mediaItemId) : undefined;
    const payloadCast = media?.tmdbPayload?.cast;
    return {
      id: itemId(root.id, row.relativePath),
      databaseId: row.id,
      relativePath: row.relativePath,
      sourceTitle: row.sourceTitle,
      sourceYear: row.sourceYear,
      posterPath: row.posterPath,
      tags: row.tags,
      mediaItemId: row.mediaItemId,
      recognitionStatus: row.recognitionStatus,
      // Emby 自带的题材优先（媒体库已由 Emby 驱动）；没有时回落到 TMDB 条目上的题材
      genres: row.genres?.length ? row.genres : (media?.genres ?? []),
      addedAt: row.fileModifiedAt ?? null,
      cast: Array.isArray(payloadCast) ? payloadCast.filter((entry): entry is string => typeof entry === "string") : [],
      identity: {
        physicalSeason: episodes[0]?.physicalSeason ?? null,
        parsedSeason: episodes[0]?.parsedSeason ?? null,
        episodeNumbers: episodes.flatMap((episode) => (episode.episodeNumber ? [episode.episodeNumber] : [])),
        absoluteEpisodeNumbers: episodes.flatMap((episode) =>
          episode.absoluteEpisodeNumber ? [episode.absoluteEpisodeNumber] : [],
        ),
        numberingMode:
          (episodes[0]?.numberingMode as "seasonal" | "absolute" | "unresolved" | undefined) ?? "unresolved",
        warning: row.scanWarning,
      },
    };
  });
}

export function readPublicRoot(root: LibraryRootConfig, database?: AppDatabase): LibraryRoot {
  const row = database?.select().from(mediaRoots).where(eq(mediaRoots.containerPath, root.path)).get();
  return {
    id: root.id,
    name: root.name,
    mediaType: root.mediaType,
    ...(database
      ? {
          lastScannedAt: row?.lastScannedAt ?? null,
          lastScanStatus: row?.lastScanStatus ?? null,
        }
      : {}),
  };
}
