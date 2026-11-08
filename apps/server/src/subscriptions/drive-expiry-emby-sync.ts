import { and, asc, count, eq, gt, isNotNull } from "drizzle-orm";
import type { AppDatabase } from "@emby-task-center/database/client";
import { submissionUsers } from "@emby-task-center/database/schema";
import type { EmbyClient } from "../integrations/emby-client";
import { createDatabaseSingleFlight } from "../util/database-single-flight";
import { embyAccessAllowed, syncMemberEmbyAccessState } from "./emby-access";
import { getSubmissionUser } from "./membership";

const pending = and(eq(submissionUsers.driveExpirySyncPending, true), isNotNull(submissionUsers.embyUserId));
const cursors = new WeakMap<AppDatabase, number>();

export function countPendingDriveExpirySync(database: AppDatabase): number {
  return database.select({ total: count() }).from(submissionUsers).where(pending).get()!.total;
}

/** Retry saved access changes. Rotate through the batch so one failing account cannot block the rest. */
export const syncDriveExpiryEmbyAccess = createDatabaseSingleFlight(
  async (database: AppDatabase, emby?: EmbyClient) => {
    if (!emby?.configured) return;
    const after = cursors.get(database) ?? 0;
    const batch = (id: number) =>
      database
        .select({ id: submissionUsers.id })
        .from(submissionUsers)
        .where(and(pending, gt(submissionUsers.id, id)))
        .orderBy(asc(submissionUsers.id))
        .limit(20)
        .all();
    let candidates = batch(after);
    if (!candidates.length && after) candidates = batch(0);
    for (const { id } of candidates) {
      cursors.set(database, id);
      const before = getSubmissionUser(database, id);
      if (!before?.driveExpirySyncPending || !before.embyUserId) continue;
      const result = await syncMemberEmbyAccessState(database, emby, id);
      if (result === "unconfirmed" || (result === "enabled") !== embyAccessAllowed(database, id)) continue;
      const current = getSubmissionUser(database, id);
      if (
        !current ||
        current.embyUserId !== before.embyUserId ||
        current.subscriptionExpiresAt !== before.subscriptionExpiresAt
      )
        continue;
      database.update(submissionUsers).set({ driveExpirySyncPending: false }).where(eq(submissionUsers.id, id)).run();
    }
  },
);
