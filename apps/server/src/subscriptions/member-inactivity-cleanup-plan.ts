import type { AppDatabase } from "@emby-task-center/database/client";
import { loadRecordedMemberPlayback, readMemberPlaybackEvidence } from "./member-inactivity-activity";
import { embyAccountKey } from "./member-expiry-cleanup-guard";
import {
  CLEANUP_DAY_MS,
  memberCleanupContext,
  type CleanupBlockedReason,
  type CleanupDirectory,
  type CleanupMember,
} from "./member-expiry-cleanup-plan";

const PLAYBACK_READ_CONCURRENCY = 4;
type PlaybackEvidence = NonNullable<Awaited<ReturnType<typeof readMemberPlaybackEvidence>>>;
type PlaybackByAccount = Map<string, PlaybackEvidence>;
type InactivityEntry = { id: number; email: string; createdAt: string; lastPlayedAt: string | null };

export function inactivityGraceElapsed(member: CleanupMember, days: number, now: Date) {
  return Boolean(member.embyUserId) && Date.parse(member.createdAt) <= now.getTime() - days * CLEANUP_DAY_MS;
}

export function playbackIsStale(evidence: PlaybackEvidence, days: number, now: Date) {
  return (
    !evidence.playing &&
    (evidence.lastPlayedAt === null || Date.parse(evidence.lastPlayedAt) <= now.getTime() - days * CLEANUP_DAY_MS)
  );
}

export async function loadCleanupPlayback(
  database: AppDatabase,
  directory: CleanupDirectory,
  days: number,
  now: Date,
  running = () => true,
): Promise<PlaybackByAccount | null> {
  const { members, blockedReason } = memberCleanupContext(database, directory);
  const ids = members.flatMap((member) =>
    member.embyUserId && inactivityGraceElapsed(member, days, now) && !blockedReason(member, true, true)
      ? [member.embyUserId]
      : [],
  );
  const evidence = new Map<string, PlaybackEvidence>();
  if (!ids.length) return evidence;
  let playingAccounts: ReadonlySet<string> | undefined;
  try {
    playingAccounts = await directory.session.readPlaybackSessions?.();
  } catch {
    return null;
  }
  if (!playingAccounts) return null;
  const recordedPlayback = loadRecordedMemberPlayback(database);
  for (let offset = 0; running() && offset < ids.length; offset += PLAYBACK_READ_CONCURRENCY) {
    await Promise.all(
      ids.slice(offset, offset + PLAYBACK_READ_CONCURRENCY).map(async (id) => {
        const playback = await readMemberPlaybackEvidence(
          database,
          directory.session,
          id,
          playingAccounts,
          recordedPlayback,
        );
        if (playback) evidence.set(embyAccountKey(id), playback);
      }),
    );
  }
  return evidence;
}

export function memberInactivityCleanupPlan(
  database: AppDatabase,
  days: number,
  now: Date,
  directory: CleanupDirectory,
  playback: PlaybackByAccount,
) {
  const { members, blockedReason } = memberCleanupContext(database, directory);
  const candidates: Array<InactivityEntry & { embyUserId: string }> = [];
  const blocked: Array<InactivityEntry & { reason: CleanupBlockedReason }> = [];
  for (const member of members) {
    const { id, email, createdAt, embyUserId } = member;
    if (!embyUserId || !inactivityGraceElapsed(member, days, now)) continue;
    const evidence = playback.get(embyAccountKey(embyUserId));
    const entry = { id, email, createdAt, lastPlayedAt: evidence?.lastPlayedAt ?? null };
    const reason = blockedReason(member, true, true);
    if (reason) blocked.push({ ...entry, reason });
    else if (!evidence) blocked.push({ ...entry, reason: "activity_unverified" });
    else if (playbackIsStale(evidence, days, now)) candidates.push({ ...entry, embyUserId });
  }
  return { candidates, blocked };
}
