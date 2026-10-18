import { eq, like } from "drizzle-orm";
import type { AppDatabase } from "@emby-task-center/database/client";
import { appSettings } from "@emby-task-center/database/schema";
import type { MissingMetadataIssue, PreviousMissingCache } from "./missing-tmdb-cache";

const PREFIX = "internal.missingMetadataCache.";
interface Entry extends PreviousMissingCache {
  issue: MissingMetadataIssue;
}

/** Internal keys are excluded from the settings registry and cannot be edited through its API. */
export function createMissingMetadataStore(database: AppDatabase) {
  const entries = new Map<number, Entry>();
  for (const row of database
    .select()
    .from(appSettings)
    .where(like(appSettings.key, `${PREFIX}%`))
    .all()) {
    try {
      const entry = JSON.parse(row.value ?? "null") as Entry | null;
      if (
        entry?.issue &&
        Number.isInteger(entry.issue.mediaItemId) &&
        Array.isArray(entry.tmdbSeasons) &&
        entry.health &&
        Number.isFinite(Date.parse(entry.health.retryAt))
      ) {
        entries.set(entry.issue.mediaItemId, entry);
      }
    } catch {
      /* A malformed internal cache does not prevent a fresh scan. */
    }
  }
  return {
    get: (id: number) => entries.get(id),
    issues: () => [...entries.values()].map((entry) => entry.issue),
    save(id: number, entry: Entry) {
      const row = {
        key: `${PREFIX}${id}`,
        value: JSON.stringify(entry),
        updatedAt: new Date().toISOString(),
        updatedBy: "generated",
      };
      database
        .insert(appSettings)
        .values(row)
        .onConflictDoUpdate({
          target: appSettings.key,
          set: { value: row.value, updatedAt: row.updatedAt, updatedBy: row.updatedBy },
        })
        .run();
      entries.set(id, entry);
    },
    clear(id: number) {
      if (!entries.has(id)) return;
      database
        .delete(appSettings)
        .where(eq(appSettings.key, `${PREFIX}${id}`))
        .run();
      entries.delete(id);
    },
  };
}
