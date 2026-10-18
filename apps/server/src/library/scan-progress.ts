import { and, eq, inArray } from "drizzle-orm";
import type { MediaType } from "@emby-task-center/contracts/media";
import type { AppDatabase } from "@emby-task-center/database/client";
import { libraryEpisodes, libraryItems, mediaItems, mediaRoots, mediaTasks } from "@emby-task-center/database/schema";
import type { LibraryRootConfig } from "./service";

export function refreshStoredProgress(
  database: AppDatabase,
  mediaType: MediaType,
  roots?: readonly LibraryRootConfig[],
): void {
  const checkedAt = new Date().toISOString();
  const tasks = database
    .select({
      id: mediaTasks.id,
      mediaItemId: mediaTasks.mediaItemId,
      sourceMode: mediaTasks.sourceMode,
      seasonNumber: mediaTasks.seasonNumber,
      mappedRootId: mediaItems.mappedRootId,
      mappedFolderPath: mediaItems.mappedFolderPath,
    })
    .from(mediaTasks)
    .innerJoin(mediaItems, and(eq(mediaItems.id, mediaTasks.mediaItemId), eq(mediaItems.mediaType, mediaType)))
    .all();
  for (const task of tasks) {
    const hasMapping = Boolean(task.mappedRootId && task.mappedFolderPath);
    const root = hasMapping ? roots?.find((candidate) => candidate.id === task.mappedRootId) : undefined;
    // 映射根暂时无法解析（如调用方未提供 roots）时跳过本次写入，避免把已存误清零，等待带 roots 的扫描刷新
    if (hasMapping && !root) continue;
    // mapped：已存数只来自映射文件夹，无映射时为 0，不使用自动匹配文件
    if (task.sourceMode === "mapped") {
      let storedProgress = 0;
      if (hasMapping && root) {
        const count = countFolderEpisodesForRoot(database, root, task.mappedFolderPath!);
        storedProgress = mediaType === "movie" ? (count > 0 ? 1 : 0) : count;
      }
      database
        .update(mediaTasks)
        .set({ storedProgress, lastCheckedAt: checkedAt, updatedAt: checkedAt })
        .where(eq(mediaTasks.id, task.id))
        .run();
      continue;
    }
    // auto：有映射按映射目录重算，无映射按自动匹配文件统计
    if (hasMapping && root) {
      const count = countFolderEpisodesForRoot(database, root, task.mappedFolderPath!);
      const storedProgress = mediaType === "movie" ? (count > 0 ? 1 : 0) : count;
      database
        .update(mediaTasks)
        .set({ storedProgress, lastCheckedAt: checkedAt, updatedAt: checkedAt })
        .where(eq(mediaTasks.id, task.id))
        .run();
      continue;
    }
    const files = database
      .select({ id: libraryItems.id })
      .from(libraryItems)
      .where(eq(libraryItems.mediaItemId, task.mediaItemId))
      .all();
    let storedProgress = files.length ? 1 : 0;
    if (mediaType === "tv") {
      const fileIds = files.map((file) => file.id);
      const episodes = fileIds.length
        ? database.select().from(libraryEpisodes).where(inArray(libraryEpisodes.libraryItemId, fileIds)).all()
        : [];
      let seasonal = episodes.flatMap((episode) =>
        episode.episodeNumber ? [`${episode.parsedSeason}:${episode.episodeNumber}`] : [],
      );
      const absolute = episodes.flatMap((episode) =>
        episode.absoluteEpisodeNumber ? [`a:${episode.absoluteEpisodeNumber}`] : [],
      );
      // 季任务（分季剧集）只统计对应季的文件，避免把同剧其它季文件算进已存数。
      if (task.seasonNumber != null) {
        seasonal = seasonal.filter((key) => key.startsWith(`${task.seasonNumber}:`));
      }
      storedProgress = new Set(seasonal.length ? seasonal : absolute).size;
    }
    database
      .update(mediaTasks)
      .set({ storedProgress, lastCheckedAt: checkedAt, updatedAt: checkedAt })
      .where(eq(mediaTasks.id, task.id))
      .run();
  }
}

export function countFolderEpisodesForRoot(database: AppDatabase, root: LibraryRootConfig, folderPath: string): number {
  const rootRow = database.select().from(mediaRoots).where(eq(mediaRoots.containerPath, root.path)).get();
  if (!rootRow) return 0;
  const prefix = `${folderPath}/`;
  const files = database
    .select({ id: libraryItems.id, relativePath: libraryItems.relativePath })
    .from(libraryItems)
    .where(eq(libraryItems.mediaRootId, rootRow.id))
    .all()
    .filter((row) => row.relativePath === folderPath || row.relativePath.startsWith(prefix));
  if (!files.length) return 0;
  const episodes = files.length
    ? database
        .select({
          episodeNumber: libraryEpisodes.episodeNumber,
          absoluteEpisodeNumber: libraryEpisodes.absoluteEpisodeNumber,
        })
        .from(libraryEpisodes)
        .where(
          inArray(
            libraryEpisodes.libraryItemId,
            files.map((file) => file.id),
          ),
        )
        .all()
    : [];
  if (!episodes.length) return files.length;
  return new Set(
    episodes
      .flatMap((episode) => [episode.episodeNumber, episode.absoluteEpisodeNumber])
      .filter((value): value is number => value !== null),
  ).size;
}
