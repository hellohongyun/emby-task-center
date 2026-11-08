import { and, eq, inArray, isNotNull, sql, type SQLWrapper } from "drizzle-orm";
import type { AppDatabase } from "@emby-task-center/database/client";
import { memberUsageEvents, memberUsageSegments } from "@emby-task-center/database/schema";
import type { EmbyMemberCleanupSession } from "../integrations/emby-member-cleanup-client";
import { embyAccountKey } from "./member-expiry-cleanup-guard";

export type MemberPlaybackEvidence = { lastPlayedAt: string | null; playing: boolean };

function matchesAccount(column: SQLWrapper, accountId: string) {
  const key = embyAccountKey(accountId);
  return /^[a-f0-9]{32}$/.test(key) ? eq(sql`lower(replace(${column}, '-', ''))`, key) : eq(column, key);
}

export function loadRecordedMemberPlayback(database: AppDatabase, accountId?: string): ReadonlyMap<string, number> {
  const accountFilter = (column: SQLWrapper) => (accountId ? matchesAccount(column, accountId) : isNotNull(column));
  const events = database
    .select({
      embyUserId: memberUsageEvents.embyUserId,
      seconds: sql<number | null>`max(unixepoch(${memberUsageEvents.occurredAt}, 'subsec'))`,
    })
    .from(memberUsageEvents)
    .where(
      and(accountFilter(memberUsageEvents.embyUserId), inArray(memberUsageEvents.kind, ["play_start", "play_stop"])),
    )
    .groupBy(memberUsageEvents.embyUserId)
    .all();
  const segments = database
    .select({
      embyUserId: memberUsageSegments.embyUserId,
      seconds: sql<number | null>`max(unixepoch(${memberUsageSegments.lastSeenAt}, 'subsec'))`,
    })
    .from(memberUsageSegments)
    .where(and(accountFilter(memberUsageSegments.embyUserId), eq(memberUsageSegments.kind, "play")))
    .groupBy(memberUsageSegments.embyUserId)
    .all();

  const lastPlayed = new Map<string, number>();
  for (const { embyUserId, seconds } of [...events, ...segments]) {
    if (!embyUserId || seconds === null) continue;
    const key = embyAccountKey(embyUserId);
    const timestamp = Math.round(seconds * 1000);
    lastPlayed.set(key, Math.max(lastPlayed.get(key) ?? -Infinity, timestamp));
  }
  return lastPlayed;
}

export async function readMemberPlaybackEvidence(
  database: AppDatabase,
  session: EmbyMemberCleanupSession,
  embyUserId: string,
  playingAccounts?: ReadonlySet<string>,
  recordedPlayback?: ReadonlyMap<string, number>,
): Promise<MemberPlaybackEvidence | null> {
  if (!session.readLastPlayed || (!playingAccounts && !session.readPlaybackSessions)) return null;
  try {
    const remote = await session.readLastPlayed(embyUserId);
    const remoteTime = remote === null ? -Infinity : Date.parse(remote);
    if (Number.isNaN(remoteTime)) return null;
    const key = embyAccountKey(embyUserId);
    const playing = (playingAccounts ?? (await session.readPlaybackSessions!())).has(key);
    const localTime = (recordedPlayback ?? loadRecordedMemberPlayback(database, embyUserId)).get(key);
    const latest = Math.max(remoteTime, localTime ?? -Infinity);
    return { lastPlayedAt: latest === -Infinity ? null : new Date(latest).toISOString(), playing };
  } catch {
    return null;
  }
}
