import { eq, inArray, sql } from "drizzle-orm";
import type { MediaType } from "@emby-task-center/contracts/media";
import type { AppDatabase } from "@emby-task-center/database/client";
import {
  libraryEpisodes,
  libraryItems,
  libraryScanRuns,
  mediaItems,
  mediaRoots,
} from "@emby-task-center/database/schema";
import { inferSourceIdentity, matchMedia, type MediaMatch } from "./matcher";
import { classifyItemMediaType, workFolderOf, matchAliasCrossType, episodeRows } from "./scan-items";
import { refreshStoredProgress } from "./scan-progress";
import type { LibraryRootConfig } from "./service";
import type { ScannedMediaItem } from "./scan-types";

export function resolveByTmdbId(
  tx: AppDatabase,
  item: ScannedMediaItem,
  mediaType: MediaType,
  tmdbIndex: Map<string, number>,
  timestamp: string,
): MediaMatch | null {
  const tmdbId = item.tmdbId;
  if (tmdbId == null) return null;
  const key = `${mediaType}:${tmdbId}`;
  const known = tmdbIndex.get(key);
  if (known != null) return { mediaItemId: known, confidence: 1 };

  const title = item.sourceTitleHint?.trim();
  if (!title) return null;
  const created = tx
    .insert(mediaItems)
    .values({
      tmdbId,
      mediaType,
      title,
      releaseYear: item.sourceYearHint ?? null,
      genres: item.genres ?? [],
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    .returning({ id: mediaItems.id })
    .get();
  tmdbIndex.set(key, created.id);
  return { mediaItemId: created.id, confidence: 1 };
}

export function persistScan(
  database: AppDatabase,
  root: LibraryRootConfig,
  scanned: readonly ScannedMediaItem[],
  startedAt: string,
  roots: readonly LibraryRootConfig[],
  complete = false,
): void {
  database.transaction(
    (tx) => {
      const rootRow = tx.select().from(mediaRoots).where(eq(mediaRoots.containerPath, root.path)).get();
      if (!rootRow) throw new Error("Configured media root is not persisted.");
      const existingRows = tx.select().from(libraryItems).where(eq(libraryItems.mediaRootId, rootRow.id)).all();
      const existingByPath = new Map(existingRows.map((row) => [row.relativePath, row]));
      const existingByEmbyId = new Map(
        existingRows.filter((row) => row.embyItemId).map((row) => [row.embyItemId as string, row]),
      );
      const seenPaths = new Set<string>();
      const seenRowIds = new Set<number>();
      const priorEpisodes = tx
        .select()
        .from(libraryEpisodes)
        .where(
          sql`${libraryEpisodes.libraryItemId} IN
      (SELECT id FROM library_items WHERE media_root_id = ${rootRow.id})`,
        )
        .all();
      const episodesByItem = new Map<number, typeof priorEpisodes>();
      for (const episode of priorEpisodes) {
        const group = episodesByItem.get(episode.libraryItemId) ?? [];
        group.push(episode);
        episodesByItem.set(episode.libraryItemId, group);
      }
      const movieCandidates =
        root.mediaType !== "tv" ? tx.select().from(mediaItems).where(eq(mediaItems.mediaType, "movie")).all() : [];
      const tvCandidates =
        root.mediaType !== "movie" ? tx.select().from(mediaItems).where(eq(mediaItems.mediaType, "tv")).all() : [];

      // 文件夹级预匹配：同一作品文件夹（如 更新-动漫-123/斗罗大陆2：绝世唐门 (2023)/Season 01/…）
      // 只解析一次、命中一次，随后该文件夹下所有 STRM 统一关联，避免逐文件漏配。
      // TMDB Id → 本地条目（Emby 直接给 id，按 id 认条目；缺条目时现建）
      const tmdbIndex = new Map<string, number>();
      for (const media of [...movieCandidates, ...tvCandidates]) {
        if (media.tmdbId != null) tmdbIndex.set(`${media.mediaType}:${media.tmdbId}`, media.id);
      }

      const workMatches = new Map<string, MediaMatch>();
      const identityMatches = new Map<string, MediaMatch | null>();
      function matchIdentity(
        source: ReturnType<typeof inferSourceIdentity>,
        detectedType: MediaType,
      ): MediaMatch | null {
        const key = JSON.stringify([detectedType, source.title, source.year]);
        if (identityMatches.has(key)) return identityMatches.get(key)!;
        const candidates = detectedType === "tv" ? tvCandidates : movieCandidates;
        const match =
          matchMedia(source, candidates) ??
          matchAliasCrossType(source, detectedType === "tv" ? movieCandidates : tvCandidates);
        identityMatches.set(key, match);
        return match;
      }
      const groupedFolders = new Set<string>();
      for (const item of scanned) {
        // Provider IDs already identify the work; avoid title matching every candidate.
        if (item.tmdbId != null && item.sourceTitleHint) continue;
        const folder = workFolderOf(item.relativePath);
        if (groupedFolders.has(folder)) continue;
        groupedFolders.add(folder);
        const source = inferSourceIdentity(item.relativePath);
        const detectedType =
          root.mediaType === "mixed" ? classifyItemMediaType(item.identity, item.relativePath) : root.mediaType;
        const match = matchIdentity(source, detectedType);
        if (match) workMatches.set(folder, match);
      }

      let unresolvedCount = 0;
      const warnings: string[] = [];
      for (const item of scanned) {
        // 片名/年份以 Emby 的 Name/ProductionYear 为准（有就给）；没有才回落到从合成路径推断。
        const inferred = inferSourceIdentity(item.relativePath);
        const source = item.sourceTitleHint
          ? { title: item.sourceTitleHint, year: item.sourceYearHint ?? inferred.year }
          : inferred;
        const detectedType =
          root.mediaType === "mixed" ? classifyItemMediaType(item.identity, item.relativePath) : root.mediaType;
        // Emby 直接给的 TMDB Id 是**权威**：优先按 id 认条目（本地已有该 id → 关联；
        // 没有 → 用 Emby 元数据建一条），比"拿片名去猜"准确。之前的顺序是先按片名预匹配、
        // 再看 tmdbId，同名不同剧（Rebelde 2004/2011、我们的宇宙两版）就会挂到错误的 TMDB 条目上。
        let match: MediaMatch | null =
          item.tmdbId != null ? resolveByTmdbId(tx, item, detectedType, tmdbIndex, startedAt) : null;
        if (!match) match = workMatches.get(workFolderOf(item.relativePath)) ?? null;
        if (!match) {
          match = matchIdentity(source, detectedType);
        }
        // 认行用 Emby ItemId（真身份）：改名/重新整理后 relativePath 会变，
        // 用路径认会变成"新建一行 + 旧行被当删除"，任务的已存进度也会跟着抖。
        const prior =
          (item.embyItemId ? existingByEmbyId.get(item.embyItemId) : undefined) ??
          existingByPath.get(item.relativePath);
        if (prior) seenRowIds.add(prior.id);
        seenPaths.add(item.relativePath);
        if (!match && prior?.mediaItemId == null) unresolvedCount += 1;
        if (item.identity.warning) warnings.push(`${item.relativePath}: ${item.identity.warning}`);
        const keepPrior = prior?.mediaItemId != null && !match;
        const values = {
          mediaRootId: rootRow.id,
          mediaItemId: match?.mediaItemId ?? (keepPrior ? prior!.mediaItemId : null),
          relativePath: item.relativePath,
          embyItemId: item.embyItemId ?? prior?.embyItemId ?? null,
          // 注意：sourceTitle/sourceYear 用的是上面那份权威值（Emby 的 Name/ProductionYear）
          sourceTitle: source.title,
          sourceYear: source.year,
          posterPath: item.posterPath ?? null,
          tags: item.tags ?? [],
          genres: item.genres ?? [],
          fileModifiedAt: item.fileModifiedAt ?? null,
          confidence: match?.confidence ?? (keepPrior ? prior!.confidence : null),
          recognitionStatus: match || keepPrior ? "matched" : "unresolved",
          scanWarning: item.identity.warning,
          updatedAt: startedAt,
        };
        if (prior) {
          const changed = Object.entries(values).some(
            ([key, value]) =>
              key !== "updatedAt" && JSON.stringify(prior[key as keyof typeof prior]) !== JSON.stringify(value),
          );
          if (changed) tx.update(libraryItems).set(values).where(eq(libraryItems.id, prior.id)).run();
          const nextEpisodes = episodeRows(item);
          const signature = (
            rows: readonly {
              physicalSeason: number | null;
              parsedSeason: number | null;
              numberingMode: string;
              episodeNumber: number | null;
              absoluteEpisodeNumber: number | null;
            }[],
          ) =>
            rows
              .map((episode) =>
                JSON.stringify([
                  episode.physicalSeason,
                  episode.parsedSeason,
                  episode.numberingMode,
                  episode.episodeNumber,
                  episode.absoluteEpisodeNumber,
                ]),
              )
              .sort()
              .join("|");
          if (signature(episodesByItem.get(prior.id) ?? []) !== signature(nextEpisodes)) {
            tx.delete(libraryEpisodes).where(eq(libraryEpisodes.libraryItemId, prior.id)).run();
            for (const episode of nextEpisodes)
              tx.insert(libraryEpisodes)
                .values({ libraryItemId: prior.id, ...episode, createdAt: startedAt })
                .run();
          }
        } else {
          const inserted = tx
            .insert(libraryItems)
            .values({ ...values, createdAt: startedAt })
            .returning({ id: libraryItems.id })
            .get();
          for (const episode of episodeRows(item))
            tx.insert(libraryEpisodes)
              .values({ libraryItemId: inserted.id, ...episode, createdAt: startedAt })
              .run();
        }
      }

      // 删除检测：只删"这一轮真的没再出现"的行。
      //
      // 安全阀：Emby 的 /Items 可能因为分页上限或瞬时故障只回一部分（甚至空），
      // 那样"没出现"就变成"被删了"——会清空库存、把任务的已存集数清零。
      // 所以整轮结果为空时一律不删（STRM 侧同理：目录临时不可读不该删库）。
      const fullResult = complete && (scanned.length > 0 || existingRows.length === 0);
      const staleIds = fullResult ? existingRows.filter((row) => !seenRowIds.has(row.id)).map((row) => row.id) : [];
      if (staleIds.length) {
        for (let offset = 0; offset < staleIds.length; offset += 500) {
          const batch = staleIds.slice(offset, offset + 500);
          tx.delete(libraryEpisodes).where(inArray(libraryEpisodes.libraryItemId, batch)).run();
          tx.delete(libraryItems).where(inArray(libraryItems.id, batch)).run();
        }
      }
      const finishedAt = new Date().toISOString();
      tx.insert(libraryScanRuns)
        .values({
          mediaRootId: rootRow.id,
          startedAt,
          finishedAt,
          discoveredCount: scanned.length,
          unresolvedCount,
          warnings,
        })
        .run();
      tx.update(mediaRoots)
        .set({ lastScanStatus: "completed", lastScannedAt: finishedAt, updatedAt: finishedAt })
        .where(eq(mediaRoots.id, rootRow.id))
        .run();
    },
    { behavior: "immediate" },
  );
  if (root.mediaType === "mixed") {
    refreshStoredProgress(database, "movie", roots);
    refreshStoredProgress(database, "tv", roots);
  } else {
    refreshStoredProgress(database, root.mediaType, roots);
  }
}

export function persistScanFailure(
  database: AppDatabase,
  root: LibraryRootConfig,
  startedAt: string,
  error: unknown,
): void {
  const rootRow = database.select().from(mediaRoots).where(eq(mediaRoots.containerPath, root.path)).get();
  if (!rootRow) return;
  const finishedAt = new Date().toISOString();
  const message = error instanceof Error ? error.message.slice(0, 500) : "scan_failed";
  database.insert(libraryScanRuns).values({ mediaRootId: rootRow.id, startedAt, finishedAt, error: message }).run();
  database
    .update(mediaRoots)
    .set({ lastScanStatus: "failed", lastScannedAt: finishedAt, updatedAt: finishedAt })
    .where(eq(mediaRoots.id, rootRow.id))
    .run();
}
