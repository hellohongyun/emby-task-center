import { and, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import type { AppDatabase } from "@emby-task-center/database/client";
import { libraryItems, mediaRoots } from "@emby-task-center/database/schema";
import { readInventory } from "./inventory-reader";
import type { LibraryInventoryItem, LibraryRoot, LibraryRootConfig } from "./service";

export interface WorkSummary {
  key: string;
  title: string;
  year: number | null;
  isTv: boolean;
  posterPath: string | null;
  tags: string[];
  resolution: string | null;
  genres: string[];
  cast: string[];
  addedAt: string | null;
  fileCount: number;
  matchedFiles: number;
  unmatchedFiles: number;
  items: LibraryInventoryItem[];
}
export interface InventorySummary {
  totalFiles: number;
  workCount: number;
  matchedFiles: number;
  unmatchedFiles: number;
  matchRatio: number;
  posterFiles: number;
  posterRatio: number;
  missingGenreFiles: number;
}
interface WorkRow {
  title: string;
  year: number | null;
  tmdbId: number | null;
  isTv: number;
  posterPath: string | null;
  tags: string;
  genres: string;
  cast: string;
  addedAt: string | null;
  fileCount: number;
  matchedFiles: number;
  posterFiles: number;
  missingGenreFiles: number;
  representativeId: number;
  titles: string;
}
interface StoredWork extends WorkSummary {
  representativeId: number;
  titles: string[];
  tmdbId: number | null;
}
export const resolutions = ["2160p", "1080p", "720p", "480p"];
export const codecs = [
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
];
// 已关联作品的类型优先；未关联时才回退到编号身份，不依赖是否已经扫描到分集。
function tvIdentity(itemId: SQL, mediaType: SQL) {
  return sql`CASE ${mediaType} WHEN 'tv' THEN 1 WHEN 'movie' THEN 0 ELSE
    EXISTS (SELECT 1 FROM library_episodes e WHERE e.library_item_id=${itemId}
    AND (e.numbering_mode!='unresolved' OR e.episode_number IS NOT NULL OR e.absolute_episode_number IS NOT NULL)) END`;
}
const tvExpression = tvIdentity(sql`i.id`, sql`m.media_type`);
const tmdbExpression = sql`CASE WHEN typeof(m.tmdb_id)='integer' AND m.tmdb_id>0 THEN m.tmdb_id END`;
function arrays(value: string): string[] {
  return [
    ...new Set(
      (JSON.parse(value) as Array<string | string[] | null>).flatMap((v) => {
        if (!v) return [];
        let parsed: unknown;
        try {
          parsed = Array.isArray(v) ? v : JSON.parse(v);
        } catch {
          return [];
        }
        return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === "string") : [];
      }),
    ),
  ];
}
export function summarizeWorks(works: StoredWork[], rows: WorkRow[]): InventorySummary {
  const totalFiles = rows.reduce((n, r) => n + r.fileCount, 0);
  const matchedFiles = rows.reduce((n, r) => n + r.matchedFiles, 0);
  const posterFiles = rows.reduce((n, r) => n + r.posterFiles, 0);
  return {
    totalFiles,
    workCount: works.length,
    matchedFiles,
    unmatchedFiles: totalFiles - matchedFiles,
    matchRatio: totalFiles ? Math.round((100 * matchedFiles) / totalFiles) : 0,
    posterFiles,
    posterRatio: totalFiles ? Math.round((100 * posterFiles) / totalFiles) : 0,
    missingGenreFiles: rows.reduce((n, r) => n + r.missingGenreFiles, 0),
  };
}

export function createWorkSummaryStore(database: AppDatabase) {
  const cache = new Map<
    string,
    { version: string; at: number; root: LibraryRootConfig; works: StoredWork[]; summary: InventorySummary }
  >();
  function get(root: LibraryRoot) {
    const row = database.select().from(mediaRoots).where(eq(mediaRoots.name, root.name)).get();
    if (!row?.enabled) {
      cache.delete(root.id);
      return null;
    }
    const version = `${row.updatedAt}|${row.lastScannedAt}|${row.lastScanStatus}`;
    const prior = cache.get(root.id);
    if (prior && prior.version === version && Date.now() - prior.at < 60_000) return prior;
    const rows = database.all<WorkRow>(sql`SELECT MIN(i.source_title) title, MIN(i.source_year) year,
      ${tmdbExpression} tmdbId, ${tvExpression} isTv, MIN(i.poster_path) posterPath, MAX(i.file_modified_at) addedAt,
      json_group_array(DISTINCT i.tags_json) tags,
      json_group_array(DISTINCT CASE WHEN json_array_length(i.genres_json)>0 THEN i.genres_json ELSE COALESCE(m.genres_json,'[]') END) genres,
      json_group_array(DISTINCT json_extract(m.tmdb_payload_json,'$.cast')) cast,
      json_group_array(DISTINCT i.source_title) titles,
      COUNT(*) fileCount, SUM(i.recognition_status='matched') matchedFiles,
      SUM(i.poster_path LIKE 'emby:%' AND length(i.poster_path)>5) posterFiles,
      SUM(json_array_length(CASE WHEN json_array_length(i.genres_json)>0 THEN i.genres_json ELSE COALESCE(m.genres_json,'[]') END)=0) missingGenreFiles,
      COALESCE(MIN(CASE WHEN i.recognition_status='matched' THEN i.id END),MIN(i.id)) representativeId
      FROM library_items i LEFT JOIN media_items m ON m.id=i.media_item_id
      WHERE i.media_root_id=${row.id} GROUP BY isTv,tmdbId,
      CASE WHEN ${tmdbExpression} IS NULL THEN lower(i.source_title) END,
      CASE WHEN ${tmdbExpression} IS NULL THEN i.source_year END`);
    const groups = new Map<string, StoredWork>();
    for (const r of rows) {
      const tags = arrays(r.tags);
      const type = r.isTv ? "tv" : "movie";
      const key =
        r.tmdbId == null ? `${type}|${r.title.toLocaleLowerCase()}|${r.year ?? ""}` : `tmdb|${type}|${r.tmdbId}`;
      const work: StoredWork = {
        key,
        title: r.title,
        year: r.year,
        isTv: Boolean(r.isTv),
        posterPath: r.posterPath,
        tags,
        resolution: resolutions.find((v) => tags.includes(v)) ?? null,
        genres: arrays(r.genres),
        cast: arrays(r.cast),
        addedAt: r.addedAt,
        fileCount: r.fileCount,
        matchedFiles: r.matchedFiles,
        unmatchedFiles: r.fileCount - r.matchedFiles,
        items: [],
        representativeId: r.representativeId,
        titles: JSON.parse(r.titles) as string[],
        tmdbId: r.tmdbId,
      };
      const previous = groups.get(key);
      if (!previous) groups.set(key, work);
      else {
        if (!previous.matchedFiles && work.matchedFiles) previous.representativeId = work.representativeId;
        previous.fileCount += work.fileCount;
        previous.matchedFiles += work.matchedFiles;
        previous.unmatchedFiles += work.unmatchedFiles;
        previous.tags = [...new Set([...previous.tags, ...work.tags])];
        previous.resolution = resolutions.find((v) => previous.tags.includes(v)) ?? null;
        previous.genres = [...new Set([...previous.genres, ...work.genres])];
        previous.cast = [...new Set([...previous.cast, ...work.cast])];
        previous.titles.push(...work.titles);
        previous.posterPath ||= work.posterPath;
        if (work.addedAt && (!previous.addedAt || work.addedAt > previous.addedAt)) previous.addedAt = work.addedAt;
      }
    }
    const works = [...groups.values()];
    const value = {
      version,
      at: Date.now(),
      root: { ...root, path: row.containerPath },
      works,
      summary: summarizeWorks(works, rows),
    };
    cache.set(root.id, value);
    return value;
  }
  function page(root: LibraryRoot, works: StoredWork[]) {
    const state = get(root);
    if (!state || !works.length) return [];
    const items = readInventory(
      database,
      state.root,
      inArray(
        libraryItems.id,
        works.map((w) => w.representativeId),
      ),
    );
    const byId = new Map(items.map((i) => [i.databaseId, i]));
    return works.map(({ titles: _titles, tmdbId: _tmdbId, representativeId, ...work }) => ({
      ...work,
      items: byId.has(representativeId) ? [byId.get(representativeId)!] : [],
    }));
  }
  function details(root: LibraryRoot, key: string) {
    const state = get(root);
    const work = state?.works.find((w) => w.key === key);
    if (!state || !work) return null;
    return readInventory(
      database,
      state.root,
      and(
        work.tmdbId == null
          ? and(
              inArray(libraryItems.sourceTitle, work.titles),
              work.year == null ? isNull(libraryItems.sourceYear) : eq(libraryItems.sourceYear, work.year),
              sql`NOT EXISTS (SELECT 1 FROM media_items m WHERE m.id=library_items.media_item_id
                AND ${tmdbExpression} IS NOT NULL)`,
            )
          : sql`EXISTS (SELECT 1 FROM media_items m WHERE m.id=library_items.media_item_id
              AND ${tmdbExpression}=${work.tmdbId})`,
        sql`${tvIdentity(
          sql`${libraryItems.id}`,
          sql`(SELECT m.media_type FROM media_items m WHERE m.id=library_items.media_item_id)`,
        )} = ${work.isTv ? 1 : 0}`,
      ),
    );
  }
  return { get, page, details, invalidate: () => cache.clear() };
}
