import { eq, isNull } from "drizzle-orm";
import type { AppDatabase } from "@emby-task-center/database/client";
import { libraryItems, type MediaItemRow } from "@emby-task-center/database/schema";
import { inferSourceIdentity, matchMedia, normalizeTitle } from "./matcher";
import { refreshStoredProgress } from "./scan-progress";
import type { LibraryRootConfig } from "./service";
export function matchInventoryToMediaItem(
  database: AppDatabase,
  mediaItem: MediaItemRow,
  roots?: readonly LibraryRootConfig[],
): number {
  const rows = database.select().from(libraryItems).where(isNull(libraryItems.mediaItemId)).all();

  let matched = 0;
  for (const row of rows) {
    const looksLikeTv = /(?:^|\/)Season\s*\d+|\bS\d{1,3}E\d{1,4}\b|\bEP?\d{1,4}\b/i.test(row.relativePath);
    const source = inferSourceIdentity(row.relativePath);
    const aliasExact = (mediaItem.aliases ?? []).some(
      (alias) => normalizeTitle(alias) === normalizeTitle(source.title),
    );
    // 显式别名允许跨类型（如电影任务匹配剧集片源），自动匹配仍受类型保护
    if (!aliasExact && mediaItem.mediaType === "movie" && looksLikeTv) continue;
    if (!aliasExact && mediaItem.mediaType === "tv" && !looksLikeTv) continue;
    const match = matchMedia(source, [mediaItem]);
    if (!match || match.mediaItemId !== mediaItem.id) continue;
    database
      .update(libraryItems)
      .set({
        mediaItemId: mediaItem.id,
        recognitionStatus: "matched",
        confidence: match.confidence,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(libraryItems.id, row.id))
      .run();
    matched += 1;
  }
  if (matched) refreshStoredProgress(database, mediaItem.mediaType, roots);
  return matched;
}
