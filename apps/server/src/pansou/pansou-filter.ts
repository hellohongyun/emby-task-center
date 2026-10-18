/**
 * PanSou 结果归一化 / 平台映射 / 阶梯回退 / 脱敏 / 品质评分。
 *
 * 设计口径：
 *  - 只展示「管理后台启用」的平台；未启用平台不出现、不参与回退。
 *  - 阶梯回退：光鸭+磁力 → 123 → 115；展示第一个“可用资源数 > 0”的档位。
 *  - 卡片只保留「网盘 / 磁力」两种通用类型，具体网盘名与链接在后端以 resourceId 映射。
 *  - 观影资源（source === "plugin:gying"）置顶；组内/组间按 score 降序。
 */

import type { PansouRawItem } from "./pansou-client";

export type PansouPlatformKey =
  "123" | "115" | "magnet" | "other" | "mobile" | "uc" | "xunlei" | "aliyun" | "tianyi" | "quark" | "baidu";

export type ResourceDisplayType = "网盘" | "磁力";

export interface PansouPlatformMeta {
  name: string;
  displayType: ResourceDisplayType;
}

export const PLATFORM_META: Record<PansouPlatformKey, PansouPlatformMeta> = {
  "123": { name: "123云盘", displayType: "网盘" },
  "115": { name: "115网盘", displayType: "网盘" },
  other: { name: "光鸭云盘", displayType: "网盘" },
  magnet: { name: "磁力", displayType: "磁力" },
  mobile: { name: "移动网盘", displayType: "网盘" },
  uc: { name: "UC网盘", displayType: "网盘" },
  xunlei: { name: "迅雷网盘", displayType: "网盘" },
  aliyun: { name: "阿里网盘", displayType: "网盘" },
  tianyi: { name: "天翼网盘", displayType: "网盘" },
  quark: { name: "夸克网盘", displayType: "网盘" },
  baidu: { name: "百度网盘", displayType: "网盘" },
};

export const ALL_PLATFORMS: PansouPlatformKey[] = Object.keys(PLATFORM_META) as PansouPlatformKey[];

/** 阶梯回退档位（优先级从高到低）。 */
export const DEFAULT_TIERS: PansouPlatformKey[][] = [["other", "magnet"], ["123"], ["115"]];

/**
 * 默认启用平台：115 网盘 + 磁力；123 云盘与光鸭（other）默认关闭。
 * 该常量同时是 migrate.ts 种子行与 `pansou_platform_settings` 空表回退的唯一依据，
 * 三处必须一致，否则「管理后台开关」与实际过滤结果会互相矛盾。
 */
export const DEFAULT_ENABLED_PLATFORMS: PansouPlatformKey[] = ["115", "magnet"];

export interface PansouResource {
  /** 由 resource-token 服务在返回给前端前填充；前端只能回传该 id。 */
  resourceId: string;
  platformKey: PansouPlatformKey;
  displayType: ResourceDisplayType;
  /** 服务端专用，永不下发。 */
  url: string;
  password: string;
  note: string;
  /** 脱敏后的可展示文本（已用 xxx 替换网盘名）。 */
  maskedNote: string;
  source: string;
  datetime: string;
  images: string[];
  score: number;
  qualityTags: string[];
  /** 视频大小（如 "23.4GB"）；磁力/网盘 note 中若含大小则提取。 */
  size?: string;
  /** 可离线平台列表（面板源）。 */
  supportedTargets?: string[];
  isGying: boolean;
  raw: PansouRawItem;
}

export interface FilterOptions {
  enabledPlatforms?: readonly PansouPlatformKey[];
  tiers?: readonly (readonly PansouPlatformKey[])[];
}

const DEAD_WORDS = /已失效|已删除|链接失效|取消分享|加群|免费群|广告|失效/;

const BARE_NETDISK_NAMES = [
  "光鸭云盘",
  "123云盘",
  "115网盘",
  "天翼云盘",
  "夸克网盘",
  "百度网盘",
  "迅雷网盘",
  "UC网盘",
  "阿里网盘",
  "移动网盘",
  "光鸭",
  "夸克",
  "天翼",
  "迅雷",
  "百度",
  "阿里",
  "移动",
  "uc",
  "UC",
];

/** 平台键→是否磁力类。 */
function isMagnetPlatform(key: PansouPlatformKey): boolean {
  return key === "magnet";
}

/** 是否判定为可入库资源（url 可识别 + 非失效 + note 非空）。 */
export function isUsableResource(platformKey: PansouPlatformKey, item: PansouRawItem): boolean {
  if (!item.url) return false;
  if (isMagnetPlatform(platformKey)) {
    if (!/^(magnet:|ed2k:|torrent:)/i.test(item.url.trim())) return false;
  } else {
    if (!/^https?:\/\//i.test(item.url.trim())) return false;
  }
  if (!item.note?.trim()) return false;
  if (DEAD_WORDS.test(item.note)) return false;
  return true;
}

/** 脱敏：把网盘/平台名称替换成 xxx。 */
export function maskNote(note: string): string {
  let masked = note;
  for (const name of BARE_NETDISK_NAMES) {
    masked = masked.split(name).join("xxx");
  }
  return masked;
}

interface ScoreRule {
  pattern: RegExp;
  score: number;
  tag?: string;
}

const SCORE_RULES: ScoreRule[] = [
  { pattern: /\b(8k|4320p)\b/i, score: 30, tag: "8K" },
  { pattern: /\b(4k|2160p|uhd)\b/i, score: 25, tag: "4K" },
  { pattern: /\b(1440p|2k)\b/i, score: 18, tag: "2K" },
  { pattern: /\b(1080p|fhd|full ?hd)\b/i, score: 15, tag: "1080P" },
  { pattern: /\b(720p|hd)\b/i, score: 8, tag: "720P" },
  { pattern: /\b(480p|sd)\b/i, score: 3, tag: "SD" },
  { pattern: /\b(dolby vision|dovi|dv hdr)\b/i, score: 22, tag: "杜比视界" },
  { pattern: /\bhdr10\+\b/i, score: 20, tag: "HDR10+" },
  { pattern: /\bhdr10\b/i, score: 18, tag: "HDR10" },
  { pattern: /(?!hdr10)\bhdr\b/i, score: 12, tag: "HDR" },
  { pattern: /\b(atmos|杜比全景声)\b/i, score: 22, tag: "Atmos" },
  { pattern: /\b(dts[- ]?hd[- ]?ma|truehd|dolby truehd)\b/i, score: 20, tag: "DTS-HD MA/TrueHD" },
  { pattern: /\b(dts[- ]?x)\b/i, score: 18, tag: "DTS:X" },
  { pattern: /\b(dts)\b/i, score: 14, tag: "DTS" },
  { pattern: /\b(lpcm|uncompressed|pcm)\b/i, score: 12, tag: "LPCM" },
  { pattern: /\b(eac3|ac3|dd\+|dd 5\.1|dolby digital)\b/i, score: 10, tag: "DD/AC3" },
  { pattern: /\b(aac)\b/i, score: 6, tag: "AAC" },
  { pattern: /(国英双语|国粤双语|国英双音轨|国英).{0,4}字幕?|多音轨|双语|国英|国粤/i, score: 10, tag: "双语/多音轨" },
  { pattern: /(特效字幕|特效中字)/i, score: 12, tag: "特效字幕" },
  { pattern: /(外挂字幕|内封字幕|内嵌字幕|软字幕)/i, score: 10, tag: "内封/外挂字幕" },
  { pattern: /(简繁|繁英|简英|双语字幕|简中)/i, score: 8, tag: "双语字幕" },
  { pattern: /(中字|中文字幕|中文)/i, score: 6, tag: "中字" },
  { pattern: /(无删减|完整版|未删减|导演剪辑版|加长版|全剧场版)/i, score: 12, tag: "无删减/完整版" },
  { pattern: /\b(remux)\b/i, score: 20, tag: "REMUX" },
  { pattern: /\b(bluray|blu-ray|bdrip|bd\b)\b/i, score: 18, tag: "BluRay" },
  { pattern: /\b(web[- ]?dl|webdl)\b/i, score: 14, tag: "WEB-DL" },
  { pattern: /\b(webrip|web ?rip)\b/i, score: 10, tag: "WEBRip" },
  { pattern: /\b(hdtv|hdtvrip)\b/i, score: 6, tag: "HDTV" },
  { pattern: /\b(10bit|10-bit)\b/i, score: 10, tag: "10bit" },
  { pattern: /\b(x265|hevc|h\.?265)\b/i, score: 10, tag: "x265/HEVC" },
  { pattern: /\b(av1)\b/i, score: 8, tag: "AV1" },
  { pattern: /\b(x264|avc|h\.?264)\b/i, score: 6, tag: "x264/AVC" },
  { pattern: /(高码率|high ?bitrate|highbit)/i, score: 8, tag: "高码率" },
  { pattern: /(无水印|无广告|纯净|无台标)/i, score: 8, tag: "纯净" },
  { pattern: /\b(dreamhd|framestor|chd|hds|wiki|cmct|tigole)\b/i, score: 8, tag: "知名压制组" },
  { pattern: /\[[^\]]+\]\[[^\]]+\]/, score: 5, tag: "结构化命名" },
];

/** 抽取质量标签（去重，保留出现顺序）。 */
export function extractQualityTags(note: string): string[] {
  const tags: string[] = [];
  for (const rule of SCORE_RULES) {
    if (rule.tag && rule.pattern.test(note) && !tags.includes(rule.tag)) tags.push(rule.tag);
  }
  return tags;
}

/** 从 note 中提取视频大小（如 "23.4GB"、"59.8G"、"1.2TB"）；无则返回 undefined。 */
const SIZE_REGEX = /(\d+(?:\.\d+)?)\s*(TB|T|GB|G|MB|M|GiB|GIB)\b/i;
export function extractSize(note: string): string | undefined {
  const match = SIZE_REGEX.exec(note);
  if (!match) return undefined;
  const value = match[1];
  const unit = match[2].toUpperCase().replace("GIB", "GB");
  return `${value}${unit === "M" ? "MB" : unit === "T" ? "TB" : unit === "G" ? "GB" : unit}`;
}

/** 极少数磁力带 xl=<bytes>（精确字节数）；转成可读大小。 */
export function extractSizeFromMagnet(url: string): string | undefined {
  const match = /[?&]xl=(\d+)/i.exec(url);
  if (!match) return undefined;
  const bytes = Number(match[1]);
  if (!Number.isFinite(bytes) || bytes <= 0) return undefined;
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${gb >= 10 ? Math.round(gb) : gb.toFixed(1)}GB`;
  return `${Math.round(bytes / 1024 ** 2)}MB`;
}

/** 规格清晰度评分（0-100，可超出后 clamp）。 */
export function scoreNote(note: string): number {
  let score = 0;
  for (const rule of SCORE_RULES) {
    if (rule.pattern.test(note)) score += rule.score;
  }
  return Math.min(100, Math.round(score));
}

function toResource(platformKey: PansouPlatformKey, item: PansouRawItem): PansouResource {
  const meta = PLATFORM_META[platformKey];
  const note = item.note ?? "";
  return {
    resourceId: "",
    platformKey,
    displayType: meta.displayType,
    url: item.url,
    password: item.password ?? "",
    note,
    maskedNote: maskNote(note),
    source: item.source ?? "",
    datetime: item.datetime ?? "",
    images: item.images ?? [],
    score: scoreNote(note),
    qualityTags: extractQualityTags(note),
    size: extractSize(note) ?? extractSizeFromMagnet(item.url),
    isGying: item.source === "plugin:gying",
    raw: item,
  };
}

export function normalizeRawResponse(
  data: Record<string, PansouRawItem[]>,
  options: FilterOptions = {},
): PansouPlatformKey[] {
  const enabled = new Set(options.enabledPlatforms ?? DEFAULT_ENABLED_PLATFORMS);
  return ALL_PLATFORMS.filter((key) => enabled.has(key));
}

/**
 * 对原始 merged_by_type 按启用平台过滤并按「观影置顶 → 网盘优先 → 清晰度评分」排序。
 * 展示**全部启用平台的可用资源**（不再只回退到某一档，避免磁力把网盘挤没）。
 * 返回可发给前端的资源（resourceId 留空）。
 */
export function filterAndRankResources(
  data: Record<string, PansouRawItem[]>,
  options: FilterOptions = {},
): PansouResource[] {
  const enabled = new Set(options.enabledPlatforms ?? DEFAULT_ENABLED_PLATFORMS);

  // 1. 仅保留启用平台的可用资源，按平台分桶。
  const buckets = new Map<PansouPlatformKey, PansouResource[]>();
  for (const key of ALL_PLATFORMS) {
    if (!enabled.has(key)) continue;
    const raw = data[key] ?? [];
    const resources = raw.filter((item) => isUsableResource(key, item)).map((item) => toResource(key, item));
    if (resources.length) buckets.set(key, resources);
  }

  // 2. 合并全部启用平台的可用资源。
  const resources: PansouResource[] = [];
  for (const key of ALL_PLATFORMS) {
    resources.push(...(buckets.get(key) ?? []));
  }

  // 3. 排序：观影置顶；其次网盘（光鸭/123/115…）排在磁力前，确保网盘始终可见；同组按评分降序。
  return resources.sort((a, b) => {
    if (a.isGying !== b.isGying) return a.isGying ? -1 : 1;
    if (a.displayType !== b.displayType) return a.displayType === "网盘" ? -1 : 1;
    return b.score - a.score;
  });
}
