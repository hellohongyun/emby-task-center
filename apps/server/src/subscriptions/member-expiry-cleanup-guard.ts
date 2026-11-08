import { eq } from "drizzle-orm";
import type { AppDatabase } from "@emby-task-center/database/client";
import { memberExpiryCleanupJobs } from "@emby-task-center/database/schema";

const roleChanges = new WeakMap<AppDatabase, Map<string, number>>();

export function embyAccountKey(id: string): string {
  return /^(?:[a-f\d]{32}|[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12})$/i.test(id)
    ? id.replaceAll("-", "").toLowerCase()
    : id;
}

export function isMemberExpiryCleanupPending(database: AppDatabase, memberId: number): boolean {
  return Boolean(
    database
      .select({ id: memberExpiryCleanupJobs.memberId })
      .from(memberExpiryCleanupJobs)
      .where(eq(memberExpiryCleanupJobs.memberId, memberId))
      .get(),
  );
}

export function isEmbyExpiryCleanupPending(database: AppDatabase, embyUserId: string): boolean {
  const key = embyAccountKey(embyUserId);
  return database
    .select({ id: memberExpiryCleanupJobs.embyUserId })
    .from(memberExpiryCleanupJobs)
    .all()
    .some(({ id }) => embyAccountKey(id) === key);
}

export function holdEmbyRoleChange(database: AppDatabase, embyUserId: string) {
  const key = embyAccountKey(embyUserId);
  const changes = roleChanges.get(database) ?? new Map<string, number>();
  roleChanges.set(database, changes);
  changes.set(key, (changes.get(key) ?? 0) + 1);
  return () => {
    const remaining = (changes.get(key) ?? 1) - 1;
    if (remaining) changes.set(key, remaining);
    else changes.delete(key);
  };
}

export function embyRoleChangeInFlight(database: AppDatabase, embyUserId: string): boolean {
  return roleChanges.get(database)?.has(embyAccountKey(embyUserId)) ?? false;
}
