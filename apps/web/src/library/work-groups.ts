/**
 * 媒体库的作品归组与统计（P5/P4：从 LibraryView.vue 抽出，纯函数、可单测）。
 *
 * "作品" = 片名 + 年份 + 类型 归组后的一条；一个作品可能对应多个条目（剧集多集）。
 * 这里不依赖 Vue，UI 只负责渲染。
 */
import type { LibraryItem, LibraryRoot, LibraryScan } from "../types";

export interface WorkGroup {
  key: string;
  title: string;
  year: number | null;
  isTv: boolean;
  posterPath: string | null;
  tags: string[];
  resolution: string | null;
  items: LibraryItem[];
  genres: string[];
  cast: string[];
  /** 该作品最近一次入库时间（ISO）；「最近入库」排序用它。 */
  addedAt: string | null;
}

export const RESOLUTION_OPTIONS = ["2160p", "1080p", "720p", "480p"] as const;

export const CODEC_OPTIONS = [
  "HEVC",
  "AVC",
  "AV1",
  "DoVi",
  "HDR10+",
  "HDR10",
  "Atmos",
  "TrueHD",
  "DTS",
  "BluRay",
  "Remux",
  "WEB-DL",
] as const;

/** 按 类型|片名|年份 归组，并按片名排序。 */
export function groupItems(items: LibraryItem[]): WorkGroup[] {
  const map = new Map<string, WorkGroup>();
  for (const item of items) {
    const isTv =
      item.identity.numberingMode !== "unresolved" ||
      item.identity.episodeNumbers.length > 0 ||
      item.identity.absoluteEpisodeNumbers.length > 0;
    const title =
      item.sourceTitle ||
      item.relativePath
        .split("/")
        .pop()
        ?.replace(/\.strm$/i, "") ||
      "未命名";
    const year = item.sourceYear ?? null;
    const key = `${isTv ? "tv" : "movie"}|${title.toLocaleLowerCase()}|${year ?? ""}`;
    const group = map.get(key) ?? {
      key,
      title,
      year,
      isTv,
      posterPath: null,
      tags: [],
      resolution: null,
      items: [],
      genres: [],
      cast: [],
      addedAt: null,
    };
    group.items.push(item);
    if (item.posterPath && !group.posterPath) group.posterPath = item.posterPath;
    for (const tag of item.tags ?? []) if (!group.tags.includes(tag)) group.tags.push(tag);
    for (const genre of item.genres ?? []) if (!group.genres.includes(genre)) group.genres.push(genre);
    for (const actor of item.cast ?? []) if (!group.cast.includes(actor)) group.cast.push(actor);
    group.resolution = RESOLUTION_OPTIONS.find((name) => group.tags.includes(name)) ?? null;
    const addedAt = item.fileModifiedAt ?? null;
    if (addedAt && (!group.addedAt || addedAt > group.addedAt)) group.addedAt = addedAt;
    map.set(key, group);
  }
  return [...map.values()].sort((a, b) => a.title.localeCompare(b.title, "zh-CN"));
}

export interface LibrarySummary {
  /** 媒体条目总数（电影一个、剧集按集数）。 */
  totalFiles: number;
  /** 作品数（按归组算，不是文件数）。 */
  workCount: number;
  matchedFiles: number;
  unmatchedFiles: number;
  /** 匹配率（0–100 的整数）。 */
  matchRatio: number;
  /** 有海报的条目数（海报来自 Emby，不再依赖磁盘旁挂图）。 */
  posterFiles: number;
  /** 海报覆盖率（0–100 的整数）。 */
  posterRatio: number;
  /** 缺题材的条目数（Emby 没给题材）。 */
  missingGenreFiles: number;
}

export function summarizeLibrary(roots: LibraryRoot[], scans: Record<string, LibraryScan | undefined>): LibrarySummary {
  let totalFiles = 0;
  let matchedFiles = 0;
  let workCount = 0;
  let posterFiles = 0;
  let missingGenreFiles = 0;
  for (const root of roots) {
    const scan = scans[root.id];
    if (!scan) continue;
    totalFiles += scan.items.length;
    for (const item of scan.items) {
      if (item.recognitionStatus === "matched") matchedFiles += 1;
      if (posterUrlFor(item.posterPath ?? null)) posterFiles += 1;
      if (!item.genres?.length) missingGenreFiles += 1;
    }
    workCount += groupItems(scan.items).length;
  }
  return {
    totalFiles,
    workCount,
    matchedFiles,
    unmatchedFiles: Math.max(0, totalFiles - matchedFiles),
    matchRatio: totalFiles ? Math.round((matchedFiles / totalFiles) * 100) : 0,
    posterFiles,
    posterRatio: totalFiles ? Math.round((posterFiles / totalFiles) * 100) : 0,
    missingGenreFiles,
  };
}

export interface ReasonBucket {
  label: string;
  count: number;
  sample: string[];
}

/** 未匹配原因归因（管理端报表）：缺年份 / 分类目录误解析 / 外语缺别名 / 冒号分隔等。 */
export function classifyUnmatched(title: string, year: number | null): string {
  if (year == null) return "标题缺年份";
  if (/^(电影|剧集|更新|动漫|综艺)-/.test(title) && /-[a-z0-9]+$/i.test(title)) return "疑似分类目录误解析";
  // 纯 ASCII（可打印字符 + 空格）视为缺中文别名；不要用 \x00-\x1F 这类控制字符（eslint no-control-regex）。
  if (/^[\u0020-\u007E]+$/.test(title.trim())) return "外语片名/缺中文别名";
  if (/[：:]/.test(title)) return "标题带分隔符（冒号）";
  return "其他/未知";
}

export function buildUnmatchedReport(
  roots: LibraryRoot[],
  scans: Record<string, LibraryScan | undefined>,
): ReasonBucket[] {
  const groups: WorkGroup[] = [];
  for (const root of roots) {
    const scan = scans[root.id];
    if (!scan) continue;
    groups.push(
      ...groupItems(scan.items).filter((group) => !group.items.some((item) => item.recognitionStatus === "matched")),
    );
  }
  if (!groups.length) return [];
  const map = new Map<string, { count: number; sample: string[] }>();
  for (const group of groups) {
    const reason = classifyUnmatched(group.title, group.year);
    const entry = map.get(reason) ?? { count: 0, sample: [] };
    entry.count += 1;
    if (entry.sample.length < 5) entry.sample.push(group.title);
    map.set(reason, entry);
  }
  return [...map.entries()].map(([label, value]) => ({ label, ...value })).sort((a, b) => b.count - a.count);
}

/** 全部剧集类型集合（用于筛选项）。 */
export function collectGenres(scans: Record<string, LibraryScan | undefined>): string[] {
  const set = new Set<string>();
  for (const scan of Object.values(scans))
    for (const item of scan?.items ?? []) for (const genre of item.genres ?? []) set.add(genre);
  return [...set].sort((a, b) => a.localeCompare(b, "zh-CN"));
}

/** 全部年份集合（降序，用于筛选项）。 */
export function collectYears(scans: Record<string, LibraryScan | undefined>): number[] {
  const set = new Set<number>();
  for (const scan of Object.values(scans))
    for (const item of scan?.items ?? []) if (item.sourceYear != null) set.add(item.sourceYear);
  return [...set].sort((a, b) => b - a);
}

/**
 * 海报地址：库存里的 posterPath 是 `emby:<条目Id>` 引用，统一走后端 Emby 代理。
 * 非 Emby 引用（旧数据的磁盘路径）一律返回 null——不再有读磁盘的旁挂图链路。
 */
export function posterUrlFor(posterPath: string | null): string | null {
  if (!posterPath || !posterPath.startsWith("emby:")) return null;
  const itemId = posterPath.slice("emby:".length);
  return itemId ? `/api/library/emby-poster?id=${encodeURIComponent(itemId)}` : null;
}
