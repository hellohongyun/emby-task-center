import type { MediaItemRow } from "@emby-task-center/database/schema";

export interface SourceIdentity {
  title: string;
  year: number | null;
}

export interface MediaMatch {
  mediaItemId: number;
  confidence: number;
}

const seasonFolder = /^season\s*\d+$/i;
const episodeSuffix = /(?:[. _-]+(?:s\d{1,3}e\d{1,4}(?:-e?\d{1,4})?|ep?\d{1,4})).*$/i;
const bracketedYear = /[[(](19\d{2}|20\d{2})[\])]/;
const separatedYear = /(?:^|[\s._-])(19\d{2}|20\d{2})(?:$|[\s._-])/g;
const classificationFolderPattern =
  /^(?:更新-)?(?:国产|日韩|欧美|其他)?(?:电视剧|剧集|动漫|动画|电影|综艺|纪录片|儿童节目|演唱会)(?:-.*)?$/;
const yearFolderPattern = /^\d{4}$/;
const tmdbAnnotationPattern = /\s*\{[^}]*\}\s*$/;

/**
 * Classification / structural wrapper segments are not media titles:
 * old cloud categories (更新-电视剧-123, 电影-经典-123) and the new tgtodrive
 * nested wrappers (剧集, 其他剧集, 国产动漫, 电影, 欧美电影, 纪录片, 综艺, …).
 * Anchored so a real title containing a keyword (e.g. 电影人生) is not dropped.
 */
function isClassificationFolder(segment: string): boolean {
  return classificationFolderPattern.test(segment);
}

export function inferSourceIdentity(relativePath: string): SourceIdentity {
  const segments = relativePath.replaceAll("\\", "/").split("/").filter(Boolean);
  const fileName = (segments.at(-1) ?? "").replace(/\.strm$/i, "");
  const allCandidates = segments.slice(0, -1).filter((segment) => !seasonFolder.test(segment));
  // 新结构（tgtodrive）在作品目录上方会叠加 云盘/平台/类型/子类/年份 等包装层；
  // 旧逻辑取“第一个非分类段”会被包装层（如“光鸭云盘”“天鸿影视”“2026”）误判成片名。
  // 改为取“最后一个非结构段”作为作品目录，并剥离尾部 {tmdb-…} 注释，兼容新旧两种结构。
  const candidates = allCandidates.filter(
    (segment) => !isClassificationFolder(segment) && !yearFolderPattern.test(segment),
  );
  const raw = (candidates.at(-1) ?? fileName.replace(episodeSuffix, "")).replace(tmdbAnnotationPattern, "").trim();
  return extractTitleYear(raw);
}

/**
 * Extracts the release year and truncates the title at the first bracketed
 * year, or at the last separator-bounded year (covers release-group folder
 * names like "阿凡达 (2009) Avatar 2009 USA BluRay ... -Group").
 */
function extractTitleYear(raw: string): SourceIdentity {
  const bracketed = raw.match(bracketedYear);
  if (bracketed?.index !== undefined) {
    return { title: raw.slice(0, bracketed.index).trim(), year: Number(bracketed[1]) };
  }
  let separated: RegExpMatchArray | null = null;
  for (const match of raw.matchAll(separatedYear)) separated = match;
  if (separated) {
    return { title: raw.slice(0, separated.index ?? 0).trim(), year: Number(separated[1]) };
  }
  return { title: raw.trim(), year: null };
}

export function matchMedia(identity: SourceIdentity, items: readonly MediaItemRow[]): MediaMatch | null {
  const source = normalizeTitle(identity.title);
  if (!source) return null;
  const exactMatches: MediaMatch[] = [];
  const partialMatches: MediaMatch[] = [];
  const fuzzyMatches: MediaMatch[] = [];
  for (const item of items) {
    const names = [item.title, item.originalTitle, ...item.aliases].filter((name): name is string => Boolean(name));
    const normalizedNames = names.map(normalizeTitle).filter(Boolean);
    const exact = normalizedNames.some((name) => name === source);
    const partial = normalizedNames.some((name) => containsTitle(source, name));
    if (!exact && !partial) continue;
    // 显式别名是用户手动指定，年份不一致也允许（覆盖年份保护）
    const aliasExact = (item.aliases ?? []).some((alias) => normalizeTitle(alias) === source);
    if (!aliasExact && identity.year && item.releaseYear && identity.year !== item.releaseYear) continue;
    if (exact) exactMatches.push({ mediaItemId: item.id, confidence: identity.year && item.releaseYear ? 1 : 0.9 });
    else if (partial) partialMatches.push({ mediaItemId: item.id, confidence: 0.75 });
    else if (chineseCharacterSimilarity(identity.title, item.title) >= 0.6) {
      fuzzyMatches.push({ mediaItemId: item.id, confidence: identity.year && item.releaseYear ? 0.8 : 0.6 });
    }
  }
  // 手动别名/精确标题优先：存在唯一精确匹配时忽略前缀匹配，避免歧义。
  if (exactMatches.length === 1) return exactMatches[0];
  if (exactMatches.length > 1) return null;
  if (partialMatches.length === 1) return partialMatches[0];
  if (partialMatches.length > 1) return null;
  return fuzzyMatches.length === 1 ? fuzzyMatches[0] : null;
}

/** Safe prefix/substring fallback: the shorter title must be substantial and years must agree. */
export function containsTitle(source: string, name: string): boolean {
  const [short, long] = source.length <= name.length ? [source, name] : [name, source];
  if (short.length < 3) return false;
  if (short.length / long.length < 0.5) return false;
  const index = long.indexOf(short);
  if (index < 0) return false;
  // X 是 X2/X3 等带数字后缀条目（续季/续作）的前缀时不算匹配，避免第一季误并进第二季
  const next = long[index + short.length];
  if (next && /[0-9]/.test(next)) return false;
  return true;
}

const romanMap: Record<string, string> = {
  i: "1",
  ii: "2",
  iii: "3",
  iv: "4",
  v: "5",
  vi: "6",
  vii: "7",
  viii: "8",
  ix: "9",
  x: "10",
  xi: "11",
  xii: "12",
  xiii: "13",
  xiv: "14",
  xv: "15",
};

export function normalizeTitle(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[\p{P}\p{S}\s]/gu, "")
    .replace(
      /(?<![a-z])(?:xv|xiii|xii|xiv|xi|ix|viii|vii|vi|v|iv|iii|ii|i)(?![a-z])/g,
      (token) => romanMap[token] ?? token,
    );
}

const genericTitleMarkers = ["剧场版", "电影版", "特别篇", "长篇", "合集", "番外", "粤语", "国语"];

function stripTitleMarkers(value: string): string {
  let out = value;
  for (const marker of genericTitleMarkers) out = out.replaceAll(marker, "");
  return out;
}

/** 中文标题字符集合相似度：用于「大家的故事/我们的故事」「雄狮/雄师」这类同片不同译名。 */
export function chineseCharacterSimilarity(left: string, right: string): number {
  const a = [...new Set(normalizeTitle(stripTitleMarkers(left)))].filter((char) => /[\u4e00-\u9fff]/u.test(char));
  const b = [...new Set(normalizeTitle(stripTitleMarkers(right)))].filter((char) => /[\u4e00-\u9fff]/u.test(char));
  if (!a.length || !b.length) return 0;
  const common = a.filter((char) => b.includes(char)).length;
  return common / Math.min(a.length, b.length);
}
