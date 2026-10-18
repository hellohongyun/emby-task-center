import { sql } from "drizzle-orm";
import type { AppDatabase } from "@emby-task-center/database/client";
import type { PublicLibraryListItem } from "./public-library";
import { buildFacets } from "./public-library-facets";

export interface LibraryKey {
  id: string;
  mediaId: number | null;
  sourceTitle: string;
  sourceYear: number | null;
}
interface IndexRow extends LibraryKey {
  title: string;
  originalTitle: string | null;
  year: number | null;
  mediaType: "movie" | "tv";
  status: "matched" | "unresolved";
  latestAt: string;
  tags: string;
  genres: string;
  cast: string;
}

// Only filtering fields cross the SQLite boundary. Full metadata and source rows
// are fetched separately for the selected page.
const indexQuery = sql.raw(`WITH grouped AS (
 SELECT li.media_item_id AS mediaId, li.source_title AS sourceTitle,
 li.source_year AS sourceYear, max(li.updated_at) AS latestAt,
 min(li.id) AS firstId, json_group_array(DISTINCT li.tags_json) AS tags
 FROM library_items li JOIN media_roots r ON r.id = li.media_root_id
 WHERE r.enabled = 1
 GROUP BY li.media_item_id,
 CASE WHEN li.media_item_id IS NULL THEN li.source_title END,
 CASE WHEN li.media_item_id IS NULL THEN li.source_year END
)
SELECT CASE WHEN g.mediaId IS NOT NULL THEN 'mi:' || g.mediaId
 ELSE 'li:' || g.sourceTitle || ':' || coalesce(g.sourceYear, '') END AS id,
 g.mediaId, g.sourceTitle, g.sourceYear,
 CASE WHEN m.id IS NULL THEN coalesce(nullif(g.sourceTitle, ''), '未命名') ELSE m.title END AS title,
 m.original_title AS originalTitle,
 CASE WHEN m.id IS NULL THEN g.sourceYear ELSE m.release_year END AS year,
 coalesce(m.media_type, 'movie') AS mediaType,
 CASE WHEN m.id IS NULL THEN 'unresolved' ELSE 'matched' END AS status,
 g.latestAt, g.tags, coalesce(m.genres_json, '[]') AS genres,
 coalesce(json_extract(m.tmdb_payload_json, '$.cast'), '[]') AS cast
 FROM grouped g LEFT JOIN media_items m ON m.id = g.mediaId
 WHERE g.mediaId IS NULL OR m.id IS NOT NULL
 ORDER BY g.mediaId IS NULL, g.firstId`);

const resolutions = ["2160p", "1080p", "720p", "480p"];
function strings(value: string): string[] {
  const parsed: unknown = JSON.parse(value);
  return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
}

export function createLibraryIndex(database: AppDatabase) {
  let version = "";
  const table = `public_library_index_${Math.random().toString(36).slice(2)}`;
  let useTemp = true;
  let fingerprint = "";
  let checkedAt = 0;
  let rootState = "";
  let cached: ReturnType<typeof rebuild> | undefined;
  function rebuild() {
    const rows = database.all<IndexRow>(indexQuery);
    const titles = [...new Set(rows.map((row) => row.title))].sort((a, b) => a.localeCompare(b, "zh-CN"));
    const titleRanks = new Map(titles.map((title, rank) => [title, rank]));
    const compact = rows.map((row) => {
      const codecs = [...new Set(strings(row.tags).flatMap(strings))];
      return {
        ...row,
        codecs,
        genres: strings(row.genres),
        cast: strings(row.cast),
        resolution: resolutions.find((value) => codecs.includes(value)) ?? null,
        titleRank: titleRanks.get(row.title),
        search: [row.title, row.originalTitle ?? "", row.year ? String(row.year) : ""].join(" ").toLocaleLowerCase(),
      };
    });
    const encoded = JSON.stringify(compact);
    if (useTemp) {
      try {
        database.run(sql.raw(`CREATE TEMP TABLE IF NOT EXISTS "${table}" (value TEXT NOT NULL)`));
        database.run(sql.raw(`DELETE FROM temp."${table}"`));
        database.run(sql`INSERT INTO ${sql.raw(`temp."${table}"`)} (value) SELECT value FROM json_each(${encoded})`);
        database.run(
          sql.raw(
            `CREATE INDEX IF NOT EXISTS temp."${table}_latest" ON "${table}" (coalesce(json_extract(value, '$.latestAt'), '') DESC)`,
          ),
        );
        database.run(
          sql.raw(
            `CREATE INDEX IF NOT EXISTS temp."${table}_title" ON "${table}" (json_extract(value, '$.titleRank'))`,
          ),
        );
        database.run(
          sql.raw(
            `CREATE INDEX IF NOT EXISTS temp."${table}_year" ON "${table}" (coalesce(json_extract(value, '$.year'), 0) DESC, json_extract(value, '$.titleRank'))`,
          ),
        );
      } catch (error) {
        const cause = error instanceof Error ? error.cause : undefined;
        const message = `${String(error)} ${String(cause)}`;
        if (!message.includes("readonly") && !message.includes("read-only")) throw error;
        useTemp = false;
      }
    }
    return {
      encoded,
      table: useTemp ? table : null,
      facets: buildFacets(compact as unknown as PublicLibraryListItem[]),
    };
  }
  return () => {
    // data_version observes other connections (the scan worker); total_changes
    // observes writes through this connection, including same-timestamp edits.
    const changes = database.get<{ changes: number }>(sql`select total_changes() as changes`)!.changes;
    const external = database.get<{ data_version: number }>(sql.raw("PRAGMA data_version"))!.data_version;
    const next = `${changes}:${external}`;
    const now = Date.now();
    // Root availability changes the public content boundary. Check this small
    // signature on every read, independently of the inventory check throttle.
    const roots = database.get<{ state: string }>(
      sql.raw(
        "SELECT json_group_array(json_array(id, enabled)) AS state FROM (SELECT id, enabled FROM media_roots ORDER BY id)",
      ),
    )!.state;
    if (!cached || roots !== rootState || (next !== version && now - checkedAt >= 1000)) {
      // Unrelated log/usage writes change the SQLite version too. Compare only
      // fields that influence grouping, ordering, filters or global facets.
      // These opaque strings are never parsed into source-row objects in JS.
      const state = database.get<{ inventory: string; media: string; roots: string }>(
        sql.raw(`SELECT
        (SELECT json_group_array(json_array(id, media_root_id, media_item_id,
          source_title, source_year, tags_json, updated_at)) FROM
          (SELECT li.* FROM library_items li JOIN media_roots r ON r.id = li.media_root_id WHERE r.enabled = 1 ORDER BY li.id)) AS inventory,
        (SELECT json_group_array(json_array(id, title, original_title, release_year,
          media_type, genres_json, json_extract(tmdb_payload_json, '$.cast'))) FROM
          (SELECT * FROM media_items ORDER BY id)) AS media,
        (SELECT json_group_array(json_array(id, enabled)) FROM (SELECT id, enabled FROM media_roots ORDER BY id)) AS roots`),
      )!;
      const signature = `${state.inventory}\u0000${state.media}\u0000${state.roots}`;
      if (!cached || signature !== fingerprint) {
        cached = rebuild();
        fingerprint = signature;
      }
      version = `${database.get<{ changes: number }>(sql`select total_changes() as changes`)!.changes}:${external}`;
      checkedAt = now;
      rootState = roots;
    }
    return cached!;
  };
}
