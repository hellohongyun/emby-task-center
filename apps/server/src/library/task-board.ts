import { and, eq, inArray, isNotNull } from "drizzle-orm";

import type { AppDatabase } from "@emby-task-center/database/client";
import { libraryEpisodes, libraryItems, mediaRoots, mediaTasks } from "@emby-task-center/database/schema";
import {
  listTaskSeasons,
  listTasks,
  missingEpisodesBetween,
  type Task,
  type TaskSeasonRow,
} from "@emby-task-center/task-domain/task-service";

import { calculateMissing } from "./gap-calculator";

/** 库根类型：与 media_roots.media_type 一致（媒体库页面不在这里，只是看板归属展示用）。 */
type LibraryMediaType = "movie" | "tv" | "mixed";

/** 分季的媒体库归属：这一季存在哪个库、在该库里哪个目录、存了几集。 */
export interface TaskBoardSeasonLibrary {
  rootId: string;
  name: string;
  mediaType: LibraryMediaType;
  episodeCount: number;
  /** 这一季在该库里的目录（例如 "Dark/Season 01"）。 */
  path: string;
}

/** 任务级媒体库归属：每库一个条目，带该库里的去重集数、涉及季号与库内作品目录。 */
export interface TaskBoardLibrary {
  rootId: string;
  name: string;
  mediaType: LibraryMediaType;
  episodeCount: number;
  /** 该库内这部作品的文件条目数（电影 = 1）。 */
  fileCount: number;
  /** 该库里有集数的季号（电影为空数组）。 */
  seasons: number[];
  /** 该库内这部作品的作品目录（相对库根；作品直接放在库根下时为空串）。 */
  path: string;
}

/** 看板分季行：在 TaskSeasonRow 基础上补充缺集与媒体库归属。 */
export interface TaskBoardSeason extends TaskSeasonRow {
  /**
   * 该季是否参与缺集比对。媒体库有逐集明细、但这一季没有记录时（TMDB 与 Emby 的季划分
   * 对不上）为 false：不臆造缺集，也不计入合计。
   */
  aligned: boolean;
  /** 这一季的已存分别在哪些媒体库（同一季可能同时存在多个库）。 */
  libraries: TaskBoardSeasonLibrary[];
  /** 已播之后还没入库的集号（缺哪几集）。 */
  missingEpisodes: number[];
  /**
   * 已播出、但仍在"等待入库"宽限期内（默认=今日更新）的集号。
   *
   * 它们**不算缺集**：TMDB 的 air_date 只有日期，"今天 18 点更新"从 00:00 起就算已播，
   * 而片源晚上才入库——按旧口径白天会误报缺集。宽限期见设置项 `library.missingGraceHours`。
   */
  pendingEpisodes: number[];
}

/** 季号对不上、被排除在合计之外的季。 */
export interface TaskBoardUnmatchedSeason {
  seasonNumber: number;
  airedEpisodes: number;
}

/** 任务看板的一行：任务 + 分季缺集 + 媒体库归属（GET /api/tasks 与缺集总览共用）。 */
export interface TaskBoardTask extends Task {
  unmatchedSeasons: TaskBoardUnmatchedSeason[];
  libraries: TaskBoardLibrary[];
  seasons: TaskBoardSeason[];
  /** 任务级「今日更新」集号合计（宽限期内、不算缺集的那几集）。 */
  pendingEpisodes: number[];
}

/** 库根在界面上的公开 id：Emby 模式下就是 Emby 库 Id（见 library/emby-roots.ts 的 `emby:<库Id>`）。 */
function publicRootId(containerPath: string): string {
  return containerPath.startsWith("emby:") ? containerPath.slice("emby:".length) : containerPath;
}

/** "Dark/Season 01/EP01 [12].strm" → "Dark"：库内这部作品所在的目录（直接在库根下面时为空串）。 */
function topFolder(relativePath: string): string {
  const segments = relativePath.split("/").filter(Boolean);
  return segments.length > 1 ? (segments[0] ?? "") : "";
}

/** "Dark/Season 01/EP01 [12].strm" → "Dark/Season 01"：这一集在库内的季目录。 */
function parentFolder(relativePath: string): string {
  return relativePath.split("/").filter(Boolean).slice(0, -1).join("/");
}

/**
 * 一个媒体条目落在某个媒体库里的情况：库名 + 库内目录 + 该库里的逐集明细。
 * 「已存 N 集」原来只报总数，看不出存在哪个库（同一部剧可能只在「动漫」、也可能「剧集」里也有一份）。
 */
export interface ItemLibraryPlacement {
  rootId: string;
  rootName: string;
  mediaType: LibraryMediaType;
  /** 该库内这部作品的文件条目数（电影 = 1）。 */
  fileCount: number;
  /** 该库内这部作品的作品目录（相对库根）。 */
  folder: string;
  /** 季号 → 该库里去重后的集号。 */
  episodesBySeason: Map<number, Set<number>>;
  /** 季号 → 该季在库内的目录（例如 "Dark/Season 01"）。 */
  seasonFolders: Map<number, string>;
}

export interface ItemLibraryPlacements {
  placements: ItemLibraryPlacement[];
  /** 跨库并集：季号 → 去重后的集号（已存按并集算，同一集在两库各一份不会被算两次）。 */
  episodesBySeason: Map<number, Set<number>>;
}

/**
 * 每个媒体条目在媒体库里的落点：哪个库、库内哪个目录、每一季存了哪些集。
 *
 * 缺集要"缺哪几集"就必须知道具体集号，只有 library_episodes 有；
 * 而"存在哪个库"要 media_roots——所以这里用 library_items 左连 library_episodes 一次查完：
 * 电影没有逐集明细（只有一条库内条目），左连才能照样定位到库。
 */
export function libraryPlacementsByItem(
  database: AppDatabase,
  mediaItemIds: number[],
): Map<number, ItemLibraryPlacements> {
  const byItem = new Map<number, ItemLibraryPlacements>();
  if (!mediaItemIds.length) return byItem;
  const rows = database
    .select({
      mediaItemId: libraryItems.mediaItemId,
      relativePath: libraryItems.relativePath,
      rootContainerPath: mediaRoots.containerPath,
      rootName: mediaRoots.name,
      rootMediaType: mediaRoots.mediaType,
      seasonNumber: libraryEpisodes.parsedSeason,
      episodeNumber: libraryEpisodes.episodeNumber,
      absoluteEpisodeNumber: libraryEpisodes.absoluteEpisodeNumber,
    })
    .from(libraryItems)
    .innerJoin(mediaRoots, eq(mediaRoots.id, libraryItems.mediaRootId))
    .leftJoin(libraryEpisodes, eq(libraryEpisodes.libraryItemId, libraryItems.id))
    .where(and(inArray(libraryItems.mediaItemId, mediaItemIds), isNotNull(libraryItems.mediaItemId)))
    .all();

  for (const row of rows) {
    const itemId = row.mediaItemId;
    if (itemId == null) continue;
    const entry = byItem.get(itemId) ?? { placements: [], episodesBySeason: new Map<number, Set<number>>() };
    byItem.set(itemId, entry);
    const rootId = publicRootId(row.rootContainerPath);
    let placement = entry.placements.find((candidate) => candidate.rootId === rootId);
    if (!placement) {
      placement = {
        rootId,
        rootName: row.rootName,
        mediaType: row.rootMediaType,
        fileCount: 0,
        folder: topFolder(row.relativePath),
        episodesBySeason: new Map<number, Set<number>>(),
        seasonFolders: new Map<number, string>(),
      };
      entry.placements.push(placement);
    }
    placement.fileCount += 1;
    const episode = row.episodeNumber ?? row.absoluteEpisodeNumber;
    if (episode == null) continue;
    const season = row.seasonNumber ?? 0;
    const inPlacement = placement.episodesBySeason.get(season) ?? new Set<number>();
    inPlacement.add(episode);
    placement.episodesBySeason.set(season, inPlacement);
    if (!placement.seasonFolders.has(season)) placement.seasonFolders.set(season, parentFolder(row.relativePath));
    const union = entry.episodesBySeason.get(season) ?? new Set<number>();
    union.add(episode);
    entry.episodesBySeason.set(season, union);
  }
  // 库名排序固定：多库时胶囊顺序不随查询顺序抖动。
  for (const entry of byItem.values()) {
    entry.placements.sort((left, right) => left.rootName.localeCompare(right.rootName, "zh-CN"));
  }
  return byItem;
}

/** 该季的库归属（哪些库里有这一季、各存了几集、在这一季库内的哪个目录）。 */
function seasonLibraries(
  placements: readonly ItemLibraryPlacement[] | undefined,
  seasonNumber: number,
): TaskBoardSeasonLibrary[] {
  const out: TaskBoardSeasonLibrary[] = [];
  for (const placement of placements ?? []) {
    const stored = placement.episodesBySeason.get(seasonNumber);
    if (!stored?.size) continue;
    out.push({
      rootId: placement.rootId,
      name: placement.rootName,
      mediaType: placement.mediaType,
      episodeCount: stored.size,
      path: placement.seasonFolders.get(seasonNumber) ?? placement.folder,
    });
  }
  return out;
}

/** 任务级库归属：每库一个条目，带该库里的去重集数、涉及季号与库内作品目录。 */
export function taskLibraries(placements: readonly ItemLibraryPlacement[] | undefined): TaskBoardLibrary[] {
  const out: TaskBoardLibrary[] = [];
  for (const placement of placements ?? []) {
    const seasons = [...placement.episodesBySeason.keys()].sort((left, right) => left - right);
    out.push({
      rootId: placement.rootId,
      name: placement.rootName,
      mediaType: placement.mediaType,
      episodeCount: seasons.reduce((sum, season) => sum + (placement.episodesBySeason.get(season)?.size ?? 0), 0),
      fileCount: placement.fileCount,
      seasons,
      path: placement.folder,
    });
  }
  return out;
}

/**
 * 任务看板的数据源：返回所有任务（追更已整体下线后只剩完结入库），并带上分季行、分季缺集，
 * 以及"已存集数分别落在哪个媒体库/库内哪个目录"（libraries / seasons[].libraries）。
 *
 * 媒体库归属为什么要单独算：库内已存原来只报一个总数，管理员看不出这部剧是存在「动漫」还是
 * 「剧集」，也看不出库内目录；而同一部作品可能同时存在于多个库（各存一份），所以按库分别统计，
 * 已存集数取各库并集去重。
 *
 * 关于"两边的季划分对不上"（TMDB 说的季 ≠ Emby 存的季，例如《斗破苍穹》TMDB 拆成
 * S1–S4 + S5 年番，Emby 只有一个 S5 装着年番的 208 集）：
 *   - 媒体库里**一集都没有**这个条目 → 整剧未入库，每季都按"已播即缺"算；
 *   - 媒体库有逐集明细，但某一季没有记录 → 季号对不上，**不臆造缺集**：该季标记为
 *     aligned=false，从合计里排除，并在 unmatchedSeasons 里单独报出来。
 * 这样"缺 N 集"不会把对不上的季算成整季缺失（斗破本来是 270 已播/缺 62，其实是
 * 年番 210 已播 / 库内 208 / 缺 2，另外 S1–S4 的 60 集只是季号对不上）。
 */
export function buildTaskBoard(database: AppDatabase): TaskBoardTask[] {
  const tasks = listTasks(database);
  const itemIdByTask = new Map(
    tasks.length
      ? database
          .select({ id: mediaTasks.id, mediaItemId: mediaTasks.mediaItemId })
          .from(mediaTasks)
          .where(
            inArray(
              mediaTasks.id,
              tasks.map((task) => task.id),
            ),
          )
          .all()
          .map((row) => [row.id, row.mediaItemId] as const)
      : [],
  );
  const placementsByItem = libraryPlacementsByItem(database, [...itemIdByTask.values()]);

  return tasks.map((task) => {
    const placement = placementsByItem.get(itemIdByTask.get(task.id) ?? -1);
    const bySeason = placement?.episodesBySeason;
    const hasLibraryEpisodes = Boolean(bySeason && bySeason.size > 0);
    const seasons = listTaskSeasons(database, task.id).map((season): TaskBoardSeason => {
      const stored = bySeason?.get(season.seasonNumber) ?? null;
      const aired = Math.max(0, season.airProgress ?? 0);
      // 「今日更新」的集不算缺集：有效已播 = 已播 − 宽限期内。
      // 集号取已播区间的末尾几集（TMDB 播出日随集号递增，宽限期内就是最后播出的那几集）；
      // 缺集总览走逐集日期比对，那边是精确集号。
      const pending = Math.min(aired, Math.max(0, season.airPendingProgress ?? 0));
      const airedForMissing = aired - pending;
      const aligned = !hasLibraryEpisodes || stored != null;
      return {
        ...season,
        // 已存 = 这一季在所有库里**并集**去重后的集数：同一集在「动漫」「剧集」各存一份不算两集。
        storedProgress: stored ? stored.size : null,
        aligned,
        libraries: seasonLibraries(placement?.placements, season.seasonNumber),
        missingEpisodes: !aligned
          ? []
          : stored
            ? calculateMissing(
                Array.from({ length: airedForMissing }, (_, index) => index + 1),
                [...stored],
              )
            : missingEpisodesBetween(airedForMissing, null),
        pendingEpisodes: Array.from({ length: pending }, (_, index) => airedForMissing + 1 + index),
      };
    });
    const alignedSeasons = seasons.filter((season) => season.aligned);
    const unmatchedSeasons = seasons
      .filter((season) => !season.aligned)
      .map((season) => ({ seasonNumber: season.seasonNumber, airedEpisodes: season.airProgress ?? 0 }));
    return {
      ...task,
      airProgress: alignedSeasons.length
        ? alignedSeasons.reduce((sum, season) => sum + (season.airProgress ?? 0), 0)
        : task.airProgress,
      storedProgress: hasLibraryEpisodes
        ? alignedSeasons.reduce((sum, season) => sum + (season.storedProgress ?? 0), 0)
        : task.storedProgress,
      missingEpisodes: hasLibraryEpisodes
        ? alignedSeasons.flatMap((season) => season.missingEpisodes)
        : task.missingEpisodes,
      // 「今日更新」合计：只做提示，不进缺集数。
      pendingEpisodes: alignedSeasons.flatMap((season) => season.pendingEpisodes),
      unmatchedSeasons,
      // 媒体库归属：看板「媒体库」列与分季明细都用它（没入库时为空数组）。
      libraries: taskLibraries(placement?.placements),
      seasons,
    };
  });
}
