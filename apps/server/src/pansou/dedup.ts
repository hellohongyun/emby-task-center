/**
 * 去重判定：本地 STRM 媒体库 + Emby API。
 *
 * 在影片详情弹窗弹出时调用（此时已拿到准确 tmdbId/片名/年份）。
 * Emby 为权威来源，不可达时回退本地 STRM 媒体库。
 */

import { and, eq } from "drizzle-orm";

import type { AppDatabase } from "@emby-task-center/database/client";
import { mediaItems } from "@emby-task-center/database/schema";
import type { EmbyClient } from "../integrations/emby-client";

export interface DedupResult {
  inLibrary: boolean;
  /**
   * 命中的来源：
   * - `emby`：直接查 Emby 得到（权威）
   * - `library`：Emby 不可达时回退本地库存（该库存本身由 Emby 同步而来，故不再叫 "strm"）
   */
  source: "emby" | "library" | null;
  matchedTitle?: string;
  matchedYear?: number | null;
  matchedType?: "movie" | "tv";
}

function normalize(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/[\s]+/g, "");
}

export async function checkDuplicate(options: {
  database: AppDatabase;
  emby?: EmbyClient;
  tmdbId?: number | null;
  title: string;
  year?: number | null;
  mediaType?: "movie" | "tv";
}): Promise<DedupResult> {
  const { database, emby, tmdbId, title, year, mediaType } = options;
  const type = mediaType === "tv" ? "tv" : "movie";

  // 1. Emby（权威来源）。
  if (emby?.configured && emby.searchItems) {
    try {
      const items = await emby.searchItems({ tmdbId, title, year, mediaType: type });
      const matched = items.find((item) => item.type === type);
      if (matched) {
        return {
          inLibrary: true,
          source: "emby",
          matchedTitle: matched.name,
          matchedYear: matched.year,
          matchedType: matched.type,
        };
      }
    } catch {
      /* Emby 不可达则回退本地 STRM 媒体库 */
    }
  }

  // 2. 本地 STRM 媒体库：优先 tmdbId，其次“标题+年份”精确匹配。
  if (tmdbId) {
    const rows = database
      .select()
      .from(mediaItems)
      .where(and(eq(mediaItems.mediaType, type), eq(mediaItems.tmdbId, tmdbId)))
      .all();
    if (rows.length) {
      const row = rows[0]!;
      return {
        inLibrary: true,
        source: "library",
        matchedTitle: row.title,
        matchedYear: row.releaseYear,
        matchedType: row.mediaType === "tv" ? "tv" : "movie",
      };
    }
  }

  const norm = normalize(title.trim());
  const rows = database.select().from(mediaItems).where(eq(mediaItems.mediaType, type)).all();
  const matched = rows.find(
    (row) => normalize(row.title) === norm || row.aliases.some((alias) => normalize(alias) === norm),
  );
  if (matched && (year == null || matched.releaseYear == null || matched.releaseYear === year)) {
    return {
      inLibrary: true,
      source: "library",
      matchedTitle: matched.title,
      matchedYear: matched.releaseYear,
      matchedType: matched.mediaType === "tv" ? "tv" : "movie",
    };
  }

  return { inLibrary: false, source: null };
}
