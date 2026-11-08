import type { AppDatabase } from "@emby-task-center/database/client";
import type { EmbyClient } from "../integrations/emby-client";
import { sweepMemberCleanup } from "./member-expiry-cleanup";

export function sweepMemberInactivityCleanup(
  database: AppDatabase,
  emby: EmbyClient | undefined,
  now = new Date(),
  running = () => true,
  progress = { lastLinkedMemberId: 0 },
) {
  return sweepMemberCleanup("inactivity", database, emby, now, running, progress);
}
