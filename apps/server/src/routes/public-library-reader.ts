import { and, eq, isNull, or, sql, type SQL } from "drizzle-orm";
import { libraryItems, mediaItems, mediaRoots } from "@emby-task-center/database/schema";
import type { PublicLibraryOptions } from "./public-library";
import { buildGroups, toDetail, toListItem } from "./public-library-groups";
import { createLibraryIndex, type LibraryKey } from "./public-library-index";

export interface LibraryFilters {
  type: string;
  status: string;
  resolution: string;
  codec: string;
  genre: string;
  actor: string;
  yearFrom: number | null;
  yearTo: number | null;
  query: string;
}
function selection(key: LibraryKey): SQL {
  return key.mediaId != null
    ? eq(libraryItems.mediaItemId, key.mediaId)
    : and(
        isNull(libraryItems.mediaItemId),
        eq(libraryItems.sourceTitle, key.sourceTitle),
        key.sourceYear == null ? isNull(libraryItems.sourceYear) : eq(libraryItems.sourceYear, key.sourceYear),
      )!;
}

export function createPublicLibraryReader(options: PublicLibraryOptions, watchUrl: string | null) {
  const database = options.database;
  const index = createLibraryIndex(database);
  function groups(where: SQL) {
    return buildGroups(database, watchUrl, options.library, where);
  }
  return {
    list(filters: LibraryFilters, sort: string, limit: number, offset: number) {
      return database.transaction(() => {
        const snapshot = index();
        const source = snapshot.table
          ? sql.raw(`temp."${snapshot.table}" idx`)
          : sql`json_each(${snapshot.encoded}) idx`;
        const key = snapshot.table ? sql.raw("idx.rowid") : sql.raw("idx.key");
        const checks: SQL[] = [];
        for (const [field, value] of [
          ["mediaType", filters.type],
          ["status", filters.status],
          ["resolution", filters.resolution],
        ]) {
          if (value !== "all") checks.push(sql`json_extract(idx.value, ${`$.${field}`}) = ${value}`);
        }
        for (const [field, value] of [
          ["codecs", filters.codec],
          ["genres", filters.genre],
          ["cast", filters.actor],
        ]) {
          if (value)
            checks.push(
              sql`exists (select 1 from json_each(json_extract(idx.value, ${`$.${field}`})) j where j.value = ${value})`,
            );
        }
        if (filters.yearFrom != null)
          checks.push(sql`coalesce(json_extract(idx.value, '$.year'), 0) >= ${filters.yearFrom}`);
        if (filters.yearTo != null)
          checks.push(sql`coalesce(json_extract(idx.value, '$.year'), 9999) <= ${filters.yearTo}`);
        if (filters.query) checks.push(sql`instr(json_extract(idx.value, '$.search'), ${filters.query}) > 0`);
        const where = checks.length ? sql.join(checks, sql` and `) : sql`1`;
        const order =
          sort === "title"
            ? sql`json_extract(idx.value, '$.titleRank'), ${key}`
            : sort === "year"
              ? sql`coalesce(json_extract(idx.value, '$.year'), 0) desc, json_extract(idx.value, '$.titleRank'), ${key}`
              : sql`coalesce(json_extract(idx.value, '$.latestAt'), '') desc, ${key}`;
        const total = database.get<{ total: number }>(
          sql`select count(*) as total from ${source} where ${where}`,
        )!.total;
        const keys = database
          .all<{ value: string }>(
            sql`select idx.value as value from ${source} where ${where} order by ${order} limit ${limit} offset ${Math.min(Number.MAX_SAFE_INTEGER, Math.floor(offset))}`,
          )
          .map((row) => JSON.parse(row.value) as LibraryKey);
        const selected = keys.length ? groups(or(...keys.map(selection))!) : [];
        const byId = new Map(selected.map((group) => [group.id, toListItem(group)]));
        return {
          items: keys.flatMap((key) => {
            const item = byId.get(key.id);
            return item ? [item] : [];
          }),
          total,
          limit,
          offset,
          facets: snapshot.facets,
        };
      });
    },
    detail(id: string) {
      if (id.startsWith("mi:")) {
        const numeric = Number(id.slice(3));
        if (!Number.isInteger(numeric) || numeric <= 0) return undefined;
        const exact = groups(eq(libraryItems.mediaItemId, numeric)).find((group) => group.id === id);
        if (exact) return toDetail(exact);
        const candidates = database
          .select({ id: mediaItems.id })
          .from(mediaItems)
          .where(eq(mediaItems.tmdbId, numeric))
          .all();
        if (!candidates.length) return undefined;
        const fallback = groups(or(...candidates.map((row) => eq(libraryItems.mediaItemId, row.id)))!)[0];
        return fallback ? toDetail(fallback) : undefined;
      }
      if (!id.startsWith("li:")) return undefined;
      // Exact group identifiers have priority over the legacy numeric source id.
      const exactWhere = and(
        isNull(libraryItems.mediaItemId),
        sql`'li:' || ${libraryItems.sourceTitle} || ':' || coalesce(${libraryItems.sourceYear}, '') = ${id}`,
      )!;
      const exact = groups(exactWhere)[0];
      if (exact) return toDetail(exact);
      const numeric = Number(id.slice(3));
      if (!Number.isInteger(numeric) || numeric <= 0) return undefined;
      const row = database
        .select({ sourceTitle: libraryItems.sourceTitle, sourceYear: libraryItems.sourceYear })
        .from(libraryItems)
        .innerJoin(mediaRoots, eq(mediaRoots.id, libraryItems.mediaRootId))
        .where(and(eq(libraryItems.id, numeric), eq(mediaRoots.enabled, true)))
        .get();
      if (!row) return undefined;
      const fallback = groups(selection({ ...row, mediaId: null, id: "" }))[0];
      return fallback ? toDetail(fallback) : undefined;
    },
  };
}
