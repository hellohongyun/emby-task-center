import { createHash } from "node:crypto";
import type { MediaType } from "@emby-task-center/contracts/media";
import type { MediaItemRow } from "@emby-task-center/database/schema";
import { normalizeTitle, type MediaMatch, type SourceIdentity } from "./matcher";
import type { EpisodeIdentity, ScannedMediaItem } from "./scan-types";

// 新版 tgtodrive 结构 + 旧版云盘分类目录共用的“结构段”判定：
// 电影类走 `电影` 一级分类（可带 国产/欧美/日韩/其他 前缀或旧式 -动画-123 后缀）；
// 剧集/动漫/综艺/儿童节目 等强剧集类走 tv；纪录片/演唱会 回退到文件名集数特征。
const movieCategoryPattern = /^(?:更新-)?(?:国产|日韩|欧美|其他)?电影(?:-.*)?$/;
const tvStrongCategoryPattern = /^(?:更新-)?(?:国产|日韩|欧美|其他)?(?:剧集|电视剧|动漫|综艺|儿童节目)(?:-.*)?$/;

/** Classifies a scanned item: classification folder names win, then filename episode identity, then movie. */
export function classifyItemMediaType(identity: EpisodeIdentity, relativePath: string): MediaType {
  const path = relativePath.replaceAll("\\", "/");
  // 按“结构段”而非整个路径子串匹配，避免作品标题含“电影/剧集”等词时误判。
  for (const segment of path.split("/").filter(Boolean)) {
    if (movieCategoryPattern.test(segment)) return "movie";
    if (tvStrongCategoryPattern.test(segment)) return "tv";
  }
  if (identity.numberingMode !== "unresolved") return "tv";
  if (
    identity.episodeNumbers.length > 0 ||
    identity.absoluteEpisodeNumbers.length > 0 ||
    identity.parsedSeason !== null
  )
    return "tv";
  return "movie";
}
export function episodeRows(item: ScannedMediaItem) {
  const common = {
    physicalSeason: item.identity.physicalSeason,
    parsedSeason: item.identity.parsedSeason,
    numberingMode: item.identity.numberingMode,
  };
  return [
    ...item.identity.episodeNumbers.map((episodeNumber) => ({ ...common, episodeNumber, absoluteEpisodeNumber: null })),
    ...item.identity.absoluteEpisodeNumbers.map((absoluteEpisodeNumber) => ({
      ...common,
      episodeNumber: null,
      absoluteEpisodeNumber,
    })),
  ];
}

export function itemId(rootId: string, relativePath: string): string {
  return createHash("sha256").update(rootId).update("\0").update(relativePath).digest("hex").slice(0, 16);
}

const seasonLikeFolderPattern = /^(season\s*\d+|s\d{1,4}\b|第\s*\d+\s*季|disc\s*\d+)/i;

/** 作品文件夹：去掉文件名与 Season/Disc 等层级，得到“分类目录/作品目录”（映射单位）。 */
export function workFolderOf(relativePath: string): string {
  const parts = relativePath.replaceAll("\\", "/").split("/").filter(Boolean).slice(0, -1);
  while (parts.length > 1 && seasonLikeFolderPattern.test(parts.at(-1) ?? "")) parts.pop();
  return parts.join("/");
}

/** 仅通过显式别名跨类型匹配：任一别名与片源名归一化相等且年份兼容。 */
export function matchAliasCrossType(source: SourceIdentity, items: readonly MediaItemRow[]): MediaMatch | null {
  const sourceName = normalizeTitle(source.title);
  if (!sourceName) return null;
  const matches = items.flatMap((item) => {
    const aliases = (item.aliases ?? []).map(normalizeTitle).filter(Boolean);
    if (!aliases.includes(sourceName)) return [];
    return [{ mediaItemId: item.id, confidence: 0.8 }];
  });
  return matches.length === 1 ? matches[0] : null;
}

export function sanitizeItem(item: ScannedMediaItem): ScannedMediaItem {
  return {
    relativePath: item.relativePath,
    ...(item.embyItemId ? { embyItemId: item.embyItemId } : {}),
    identity: {
      ...item.identity,
      episodeNumbers: [...item.identity.episodeNumbers],
      absoluteEpisodeNumbers: [...item.identity.absoluteEpisodeNumbers],
    },
    ...(item.posterPath ? { posterPath: item.posterPath } : {}),
    ...(item.tags?.length ? { tags: [...item.tags] } : {}),
    ...(item.genres?.length ? { genres: [...item.genres] } : {}),
    // 之前这里漏了 fileModifiedAt，「最近入库」排序因此永远没有数据可用（Emby 侧用 DateCreated）
    ...(item.fileModifiedAt ? { fileModifiedAt: item.fileModifiedAt } : {}),
    // 同样漏过：Emby 给的权威片名/年份（漏了就会静默回落到"从合成路径猜"）
    ...(item.sourceTitleHint ? { sourceTitleHint: item.sourceTitleHint } : {}),
    ...(item.sourceYearHint != null ? { sourceYearHint: item.sourceYearHint } : {}),
    ...(item.tmdbId != null ? { tmdbId: item.tmdbId } : {}),
  };
}
