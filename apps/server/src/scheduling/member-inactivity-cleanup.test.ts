import { expect, it, vi } from "vitest";
import { createDatabase } from "@emby-task-center/database/client";
import { submissionUsers } from "@emby-task-center/database/schema";
import type { EmbyMemberCleanupSession } from "../integrations/emby-member-cleanup-client";
import { writeSettings } from "../settings/store";
import { saveCleanupPolicy } from "../subscriptions/member-expiry-cleanup-plan";
import { MEMBER_EXPIRY_CLEANUP_INTERVAL_MS, startMemberInactivityCleanup } from "./member-expiry-cleanup";

it("uses the saved inactivity rule on the next scheduled round", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2028-09-10T00:00:00.000Z"));
  const database = createDatabase(":memory:");
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), request: vi.fn() };
  const account = { id: "fixture-user", name: "member", role: "ordinary" } as const;
  let exists = true;
  const deleteAccount = vi.fn<EmbyMemberCleanupSession["deleteAccount"]>(async (_id, allowDelete, verifyPlayback) => {
    if ((await verifyPlayback?.()) && allowDelete?.()) exists = false;
  });
  const session: EmbyMemberCleanupSession = {
    identity: {},
    serverId: async () => "fixture-server",
    listAccounts: async () => (exists ? [account] : []),
    readRole: async () => (exists ? "ordinary" : "missing"),
    readLastPlayed: async () => "2028-08-20T00:00:00.000Z",
    readPlaybackSessions: async () => new Set(),
    deleteAccount,
  };
  writeSettings(database.db, { "emby.enabled": true });
  database.db
    .insert(submissionUsers)
    .values({
      email: "member@example.test",
      embyUserId: account.id,
      createdAt: "2028-08-01T00:00:00.000Z",
      updatedAt: "2028-08-01T00:00:00.000Z",
      subscriptionExpiresAt: "2028-10-01T00:00:00.000Z",
    })
    .run();
  const stop = startMemberInactivityCleanup(
    database.db,
    {
      configured: true,
      verify: async () => true,
      systemInfo: async () => ({ id: "fixture-server", serverName: "Fixture", version: "0" }),
      openMemberCleanupSession: () => session,
    },
    logger,
  );
  try {
    await vi.advanceTimersByTimeAsync(MEMBER_EXPIRY_CLEANUP_INTERVAL_MS);
    expect(deleteAccount).not.toHaveBeenCalled();
    saveCleanupPolicy(database.db, 15, "fixture-server", "inactivity");
    await vi.advanceTimersByTimeAsync(MEMBER_EXPIRY_CLEANUP_INTERVAL_MS);
    expect(deleteAccount).toHaveBeenCalledTimes(1);
    expect(database.db.select().from(submissionUsers).get()).toBeUndefined();
    expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({ event: "member_inactivity_cleanup_completed" }));
  } finally {
    stop();
    database.close();
    vi.useRealTimers();
  }
});
