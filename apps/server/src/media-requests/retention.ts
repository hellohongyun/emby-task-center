import { and, asc, eq, inArray, isNotNull, lte, sql } from "drizzle-orm";
import type { AppDatabase } from "@emby-task-center/database/client";
import { mediaRequests } from "@emby-task-center/database/schema";
import { MEDIA_REQUEST_RETENTION_DAYS } from "@emby-task-center/contracts/media-request";
import { audit } from "../subscriptions/domain-utils";

export const RETENTION_DAYS = MEDIA_REQUEST_RETENTION_DAYS;
export const RETENTION_BATCH_SIZE = 500;

/** Delete only completed request rows. Media, members and all earlier audits stay intact. */
export function sweepExpiredMediaRequests(database: AppDatabase, now = new Date()): number {
  const cutoff = new Date(now.getTime() - RETENTION_DAYS * 86_400_000).toISOString();
  return database.transaction(
    (tx) => {
      const due = and(
        eq(mediaRequests.status, "available"),
        isNotNull(mediaRequests.availableAt),
        lte(mediaRequests.availableAt, cutoff),
        // Canonical timestamps are written by our store/migration. The round trip also
        // rejects malformed calendar dates, rather than guessing a deletion deadline.
        sql`strftime('%Y-%m-%dT%H:%M:%fZ', ${mediaRequests.availableAt}, '+0 days') = ${mediaRequests.availableAt}`,
      );
      const candidates = tx
        .select({ id: mediaRequests.id })
        .from(mediaRequests)
        .where(due)
        .orderBy(asc(mediaRequests.availableAt), asc(mediaRequests.id))
        .limit(RETENTION_BATCH_SIZE)
        .all();
      if (!candidates.length) return 0;
      const deleted = tx
        .delete(mediaRequests)
        .where(
          and(
            due,
            inArray(
              mediaRequests.id,
              candidates.map((row) => row.id),
            ),
          ),
        )
        .returning({ id: mediaRequests.id })
        .all();
      if (deleted.length)
        audit(tx, "system", "media_request.retention_deleted", "media_request", undefined, undefined, {
          count: deleted.length,
          ids: deleted.map((row) => row.id),
          retentionDays: RETENTION_DAYS,
        });
      return deleted.length;
    },
    { behavior: "immediate" },
  );
}
