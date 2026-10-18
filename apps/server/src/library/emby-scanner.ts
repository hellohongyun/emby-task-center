/**
 * 将 Emby 媒体库映射为 LibraryService 期望的 ScannedMediaItem[]。
 * 复用现有 service 的匹配/持久化/库存/缺集逻辑，实现「媒体库由 Emby 驱动
 * （取代本地 STRM 扫描）」。
 */

import type { EmbyClient } from "../integrations/emby-client";
import {
  embyEpisodeNumbers,
  isUnnumberedEmbySpecial,
  validateEmbyEpisodeRange,
} from "../integrations/emby-episode-range";
import type { ScannedMediaBatch, ScannedMediaItem } from "./scan-types";

/**
 * 海报引用：库存里不再存磁盘相对路径，而是 `emby:<条目Id>` 这样的引用，
 * 由服务端带 token 代理取图（routes/library.ts 的 /api/library/emby-poster）。
 */
export const EMBY_POSTER_PREFIX = "emby:";

export function embyPosterRef(itemId: string): string {
  return EMBY_POSTER_PREFIX + itemId;
}

/** `emby:<id>` → id；不是 Emby 引用时返回 null（本地 sidecar 路径）。 */
export function embyPosterItemId(posterPath: string | null | undefined): string | null {
  if (!posterPath || !posterPath.startsWith(EMBY_POSTER_PREFIX)) return null;
  const id = posterPath.slice(EMBY_POSTER_PREFIX.length);
  return id.length ? id : null;
}

/** 把作品名转成安全的路径段（去掉路径分隔符与首尾空白）。 */
function safeName(value: string): string {
  return value
    .trim()
    .replace(/[\\/]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 电影：一个条目 = 一个占位 `.strm` 文件。
 *
 * 文件名里带 Emby 条目 Id：旧实现只用作品名拼路径，**同名不同年的作品（重制版）会撞唯一键**
 * （library_items 的 (root, relative_path)），真实库里 611 部动画电影立刻触发，整个库扫描回滚。
 * 目录段保持干净，因为片名/年份是从目录段推断的。
 */
function movieItem(
  name: string,
  itemId: string,
  posterRef: string | null,
  meta: { genres: string[]; dateCreated: string | null; year: number | null; tmdbId: number | null },
): ScannedMediaItem {
  const base = safeName(name);
  return {
    relativePath: `${base}/${base} [${itemId}].strm`,
    embyItemId: itemId,
    sourceTitleHint: name,
    sourceYearHint: meta.year,
    tmdbId: meta.tmdbId,
    ...(posterRef ? { posterPath: posterRef } : {}),
    ...(meta.genres.length ? { genres: meta.genres } : {}),
    ...(meta.dateCreated ? { fileModifiedAt: meta.dateCreated } : {}),
    identity: {
      physicalSeason: null,
      parsedSeason: null,
      episodeNumbers: [],
      absoluteEpisodeNumbers: [],
      numberingMode: "unresolved",
      warning: null,
    },
  };
}

/** 剧集：每个 Ep 生成一个条目（Season 目录 / Eep 文件），供缺集/已存统计。 */
function seriesItems(
  name: string,
  itemId: string,
  seasons: ReadonlyArray<{
    id: string;
    seasonNumber: number | null;
    episodeNumber: number | null;
    episodeNumberEnd?: number | null;
  }>,
  posterRef: string | null,
  meta: { genres: string[]; dateCreated: string | null; year: number | null; tmdbId: number | null },
): ScannedMediaItem[] {
  const base = safeName(name);
  if (!seasons.length) {
    return [
      {
        relativePath: `${base}/${base} [${itemId}].strm`,
        embyItemId: itemId,
        sourceTitleHint: name,
        sourceYearHint: meta.year,
        tmdbId: meta.tmdbId,
        ...(posterRef ? { posterPath: posterRef } : {}),
        ...(meta.genres.length ? { genres: meta.genres } : {}),
        ...(meta.dateCreated ? { fileModifiedAt: meta.dateCreated } : {}),
        identity: {
          physicalSeason: null,
          parsedSeason: null,
          episodeNumbers: [],
          absoluteEpisodeNumbers: [],
          numberingMode: "seasonal",
          warning: null,
        },
      },
    ];
  }
  return seasons.map((entry) => {
    const unnumberedSpecial = isUnnumberedEmbySpecial(entry);
    const season = entry.seasonNumber ?? 0;
    const episode = entry.episodeNumber;
    const seasonDir = season > 0 ? `Season ${season}` : "Special";
    return {
      // 用**每集自己的 Emby Id**：同剧集里可能有重复集号（真实数据里存在），用剧集 Id 会撞唯一键
      relativePath: `${base}/${seasonDir}/EP${unnumberedSpecial ? "unknown" : String(episode).padStart(2, "0")} [${entry.id}].strm`,
      identity: {
        physicalSeason: season > 0 ? season : null,
        parsedSeason: season > 0 ? season : null,
        episodeNumbers: embyEpisodeNumbers(entry),
        absoluteEpisodeNumbers: [],
        numberingMode: unnumberedSpecial ? "unresolved" : "seasonal",
        warning: unnumberedSpecial ? "emby_special_episode_number_missing" : null,
      },
      // 每集自己的 Emby Id 作为身份（同一剧集内允许重复集号）
      embyItemId: entry.id,
      sourceTitleHint: name,
      sourceYearHint: meta.year,
      tmdbId: meta.tmdbId,
      // 剧集海报/题材/入库时间都用剧本身的（每集共用）
      ...(posterRef ? { posterPath: posterRef } : {}),
      ...(meta.genres.length ? { genres: meta.genres } : {}),
      ...(meta.dateCreated ? { fileModifiedAt: meta.dateCreated } : {}),
    };
  });
}

/** 库根 path 形如 `emby:<库Id>`（见 emby-roots.ts）；解析出库 Id 以按库过滤。 */
export function libraryIdFromRootPath(path: string): string | undefined {
  return path.startsWith("emby:") ? path.slice("emby:".length) || undefined : undefined;
}

/**
 * 由 EmbyClient 生成一个 ScanRoot：
 * 每次调用都重新拉取 Emby 该库的条目（Movie/Series）并映射为 ScannedMediaItem[]。
 *
 * 注意：传入的 path 必须能解析出库 Id，否则会扫描整个服务器——13 个库会显示成同一份内容。
 */
export function createEmbyScan(emby: EmbyClient): (path: string) => Promise<ScannedMediaBatch> {
  return async (path: string): Promise<ScannedMediaBatch> => {
    if (!emby.configured || !emby.listLibraryItems || !emby.listItemEpisodes) {
      throw new Error("emby_library_not_configured");
    }
    const libraryId = libraryIdFromRootPath(path);
    if (!libraryId) throw new Error("emby_library_id_missing");
    const items = await emby.listLibraryItems({ libraryId });
    const out: ScannedMediaItem[] = [];
    // Emby 里同一部作品可能被添加多次并**共享同一批剧集**（真实数据：「名侦探柯南」有 4 个剧集条目、
    // 「蜡笔小新」有 2 个，集 Id 完全相同）。库存是"内容清单"，所以按作品归并、按集去重：
    // 否则同一集会产生相同合成路径（撞唯一键），或让库页把同一部剧显示 2~4 次、已存集数重复计数。
    //
    // 但重复条目**不能整条跳过**：新集有可能是以另一个条目入库的（真实数据：「中餐厅」9 月 13 日
    // 新增的第 3 个条目里装着 S10E11/E12 的新集 Id），跳过会让库存永远少这几集，缺集总览就会误报。
    // 逐条目收集分集，按集 Id 与完整季集范围去重；同起始号、不同结束号仍保留其覆盖。
    const works = new Map<string, (typeof items)[number][]>();
    for (const item of items) {
      const workKey = `${item.type}|${item.name}|${item.year ?? ""}`;
      const group = works.get(workKey);
      if (group) group.push(item);
      else works.set(workKey, [item]);
    }
    const seenEpisodes = new Map<string, string>();
    const metaOf = (item: (typeof items)[number]) => ({
      genres: item.genres ?? [],
      dateCreated: item.dateCreated ?? null,
      year: item.year,
      tmdbId: item.tmdbId,
    });
    for (const entries of works.values()) {
      const first = entries[0]!;
      if (first.type === "movie") {
        const posterRef = first.hasPrimaryImage ? embyPosterRef(first.id) : null;
        out.push(movieItem(first.name, first.id, posterRef, metaOf(first)));
        continue;
      }
      // 同一部剧的多个条目：按集 Id + 完整季集范围去重；
      // 共享的集只留一条，重复条目里的新集照常收进来（否则缺集总览会误报）。
      const seenNumbers = new Set<string>();
      const episodes: Awaited<ReturnType<NonNullable<EmbyClient["listItemEpisodes"]>>> = [];
      for (const entry of entries) {
        for (const episode of await emby.listItemEpisodes(entry.id)) {
          const unnumberedSpecial = isUnnumberedEmbySpecial(episode);
          const range = unnumberedSpecial
            ? null
            : validateEmbyEpisodeRange(episode.episodeNumber, episode.episodeNumberEnd);
          const key = range ? `${episode.seasonNumber ?? 0}:${range.start}:${range.end}` : "0:unnumbered";
          const previous = seenEpisodes.get(episode.id);
          if (previous !== undefined) {
            if (previous !== key) throw new Error("emby_episode_conflicting_identity");
            continue;
          }
          seenEpisodes.set(episode.id, key);
          const numberKey = unnumberedSpecial ? `${key}:${episode.id}` : key;
          if (seenNumbers.has(numberKey)) continue;
          seenNumbers.add(numberKey);
          episodes.push(episode);
        }
      }
      const posterRef = first.hasPrimaryImage ? embyPosterRef(first.id) : null;
      out.push(...seriesItems(first.name, first.id, episodes, posterRef, metaOf(first)));
    }
    // client 的库/分集方法只有验证完全部分页才返回；任一剧集失败都会在此之前拒绝整轮。
    return { items: out, complete: true };
  };
}
