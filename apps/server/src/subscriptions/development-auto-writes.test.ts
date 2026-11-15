import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDatabase, type DatabaseHandle } from "@emby-task-center/database/client";
import { submissionUsers, share115TransferJobs } from "@emby-task-center/database/schema";
import { writeSettings } from "../settings/store";
import type { EmbyClient } from "../integrations/emby-client";
import { automaticEmby } from "./automatic-emby";
import { disableExpiredEmbyUsers, syncAllStreamLimits } from "./emby-account";
import { syncDriveExpiryEmbyAccess } from "./drive-expiry-emby-sync";
import { enforceStreamLimits } from "./stream-guard";
import { enforceConcurrencyEscalation } from "./concurrency-escalation";
import { runMembershipReminders } from "./reminders";
import { linkOrphanEmbyUsers } from "./emby-member-sync";
import { isDevelopmentMode } from "../settings/development-mode";
import { sweepMemberExpiryCleanup } from "./member-expiry-cleanup";
import { sweepMemberInactivityCleanup } from "./member-inactivity-cleanup";
import { enqueueShare115 } from "../share-115/store";
import { startShare115Worker } from "../share-115/worker";
import { transfer115Share } from "../integrations/tgtodrive-share115";

vi.mock("../integrations/tgtodrive-share115", async (original) => ({
  ...(await original<typeof import("../integrations/tgtodrive-share115")>()),
  transfer115Share: vi.fn(async () => ({ status: "saved", resultCode: "SAVED", resultMessage: "done" })),
}));

describe("development mode automatic side effects", () => {
  let handle: DatabaseHandle;
  const mode = (enabled: boolean) => writeSettings(handle.db, { "development.enabled": enabled });
  beforeEach(() => {
    handle = createDatabase(":memory:");
    vi.clearAllMocks();
    const now = new Date().toISOString();
    handle.db
      .insert(submissionUsers)
      .values({
        email: "expired@example.test",
        embyUserId: "member",
        subscriptionExpiresAt: "2020-01-01T00:00:00Z",
        createdAt: now,
        updatedAt: now,
      })
      .run();
  });
  afterEach(() => handle.close());

  it("skips automatic account/reminder/cleanup operations without changing member state", async () => {
    mode(true);
    const before = handle.db.select().from(submissionUsers).all();
    const listUsers = vi.fn();
    const emby = {
      configured: true,
      listUsers,
      listSessions: vi.fn(),
      updateUserPolicy: vi.fn(),
    } as unknown as EmbyClient;
    expect(await disableExpiredEmbyUsers(handle.db, emby)).toBe(0);
    expect(await syncAllStreamLimits(handle.db, emby)).toBe(0);
    await syncDriveExpiryEmbyAccess(handle.db, emby);
    expect((await enforceStreamLimits(handle.db, emby)).stopped).toBe(0);
    expect((await enforceConcurrencyEscalation(handle.db, emby, undefined)).frozen).toEqual([]);
    expect(await runMembershipReminders(handle.db, undefined, new Date(), emby)).toBe(0);
    expect(await sweepMemberExpiryCleanup(handle.db, emby)).toEqual({ deleted: 0, pending: 0, skipped: 0 });
    expect(await sweepMemberInactivityCleanup(handle.db, emby)).toEqual({ deleted: 0, pending: 0, skipped: 0 });
    expect(listUsers).not.toHaveBeenCalled();
    expect(emby.listSessions).not.toHaveBeenCalled();
    expect(emby.updateUserPolicy).not.toHaveBeenCalled();
    expect(handle.db.select().from(submissionUsers).all()).toEqual(before);
  });

  it("stops an expiry write when the mode changes while user lookup is awaiting", async () => {
    let finish!: (value: unknown[]) => void;
    const listUsers = vi.fn(
      () =>
        new Promise<unknown[]>((resolve) => {
          finish = resolve;
        }),
    );
    const updateUserPolicy = vi.fn();
    const emby = {
      configured: true,
      listUsers,
      updateUserPolicy,
      createUser: vi.fn(),
      setUserPassword: vi.fn(),
      deleteUser: vi.fn(),
    } as unknown as EmbyClient;
    const pending = disableExpiredEmbyUsers(handle.db, emby);
    await vi.waitFor(() => expect(listUsers).toHaveBeenCalled());
    mode(true);
    finish([{ Id: "member", Name: "member", Policy: { IsDisabled: false } }]);
    expect(await pending).toBe(0);
    expect(updateUserPolicy).not.toHaveBeenCalled();
  });

  it("does not stop a stream when the switch is enabled during session discovery", async () => {
    let finish!: (value: unknown[]) => void;
    const listSessions = vi.fn(
      () =>
        new Promise<unknown[]>((resolve) => {
          finish = resolve;
        }),
    );
    const stopPlayback = vi.fn();
    const emby = { configured: true, listSessions, stopPlayback } as unknown as EmbyClient;
    const pending = enforceStreamLimits(handle.db, emby);
    mode(true);
    finish([{ Id: "session", UserId: "member", NowPlayingItem: { Id: "movie" } }]);
    expect((await pending).stopped).toBe(0);
    expect(stopPlayback).not.toHaveBeenCalled();
  });

  it("does not create or bind members when debugging is enabled during automatic user discovery", async () => {
    let finish!: (value: unknown[]) => void;
    const before = handle.db.select().from(submissionUsers).all();
    const emby = {
      configured: true,
      listUsers: vi.fn(
        () =>
          new Promise<unknown[]>((resolve) => {
            finish = resolve;
          }),
      ),
    } as unknown as EmbyClient;
    const pending = linkOrphanEmbyUsers(handle.db, emby, new Date(), undefined, () => !isDevelopmentMode(handle.db));
    mode(true);
    finish([{ Id: "new-user", Name: "new@example.test", Policy: { IsDisabled: false } }]);
    expect((await pending).linked).toEqual([]);
    expect(handle.db.select().from(submissionUsers).all()).toEqual(before);
  });

  it("gates actual automatic writes dynamically while leaving the original manual client intact", async () => {
    const updateUserPolicy = vi.fn(async () => undefined);
    const emby = { updateUserPolicy } as unknown as EmbyClient;
    const guarded = automaticEmby(handle.db, emby);
    mode(true);
    expect(() => guarded.updateUserPolicy!("member", {})).toThrow("development_mode_enabled");
    expect(updateUserPolicy).not.toHaveBeenCalled();
    await emby.updateUserPolicy!("member", {});
    mode(false);
    await guarded.updateUserPolicy!("member", {});
    expect(updateUserPolicy).toHaveBeenCalledTimes(2);
  });

  it("keeps existing transfer jobs queued and resumes them after the switch is disabled", async () => {
    mode(true);
    enqueueShare115(handle.db, {
      memberId: 1,
      memberEmail: "expired@example.test",
      shareCode: "fixture",
      accessCode: "",
      shareUrl: "https://115.com/s/fixture",
      note: "",
      now: new Date().toISOString(),
    });
    const before = handle.db.select().from(share115TransferJobs).all();
    const worker = startShare115Worker({
      database: handle.db,
      readConfig: () => ({ enabled: true, baseUrl: "http://127.0.0.1:9999", token: "fixture" }),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    try {
      await worker.close();
      expect(worker.accepting()).toBe(false);
      expect(transfer115Share).not.toHaveBeenCalled();
      expect(handle.db.select().from(share115TransferJobs).all()).toEqual(before);
      mode(false);
      expect(worker.accepting()).toBe(true);
      worker.wake();
      await worker.close();
      expect(transfer115Share).toHaveBeenCalledTimes(1);
      expect(handle.db.select().from(share115TransferJobs).get()?.status).toBe("saved");
    } finally {
      worker.stop();
    }
  });
});
