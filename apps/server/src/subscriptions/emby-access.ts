import { eq } from "drizzle-orm";
import type { AppDatabase } from "@emby-task-center/database/client";
import { concurrencyEscalationState } from "@emby-task-center/database/schema";
import type { EmbyClient } from "../integrations/emby-client";
import { createEmbyUserService } from "../integrations/emby-user-service";
import { getSubmissionUser, memberStatus } from "./membership";

export function embyAccessAllowed(
  database: AppDatabase,
  memberId: number,
  ignoreFreeze = false,
  now = new Date(),
): boolean {
  const member = getSubmissionUser(database, memberId);
  if (!member?.enabled || memberStatus(member, now) === "expired") return false;
  const state = database
    .select()
    .from(concurrencyEscalationState)
    .where(eq(concurrencyEscalationState.memberId, memberId))
    .get();
  return ignoreFreeze || !state?.disabledUntil;
}

/** Recheck after remote writes: disabling/expiry during a slow request must not restore playback. */
export async function syncMemberEmbyAccess(
  database: AppDatabase,
  emby: EmbyClient | undefined,
  memberId: number,
  ignoreFreeze = false,
  now = new Date(),
): Promise<boolean> {
  const startedAt = Date.now();
  const currentTime = () => new Date(now.getTime() + Date.now() - startedAt);
  const member = getSubmissionUser(database, memberId);
  if (!member) return false;
  const frozenUntil =
    database.select().from(concurrencyEscalationState).where(eq(concurrencyEscalationState.memberId, memberId)).get()
      ?.disabledUntil ?? null;
  const stillAllowed = () => {
    if (getSubmissionUser(database, memberId)?.embyUserId !== member.embyUserId) return false;
    if (!embyAccessAllowed(database, memberId, ignoreFreeze, currentTime())) return false;
    if (!ignoreFreeze) return true;
    const latest = database
      .select()
      .from(concurrencyEscalationState)
      .where(eq(concurrencyEscalationState.memberId, memberId))
      .get();
    return (latest?.disabledUntil ?? null) === frozenUntil;
  };
  let allowed = stillAllowed();
  if (!member.embyUserId || !emby?.configured) return allowed;
  const service = createEmbyUserService(emby);
  try {
    await service.setDisabled(member.embyUserId, !allowed);
    const freshAllowed = stillAllowed();
    if (allowed && !freshAllowed) {
      await service.setDisabled(member.embyUserId, true);
      return false;
    }
    allowed = freshAllowed;
    const users = await service.listUsers();
    if (allowed && !stillAllowed()) {
      await service.setDisabled(member.embyUserId, true);
      return false;
    }
    return allowed && users.find((user) => user.id === member.embyUserId)?.isDisabled === false;
  } catch {
    if (!stillAllowed()) {
      await service.setDisabled(member.embyUserId, true).catch(() => undefined);
    }
    return false;
  }
}
