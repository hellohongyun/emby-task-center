import { eq } from "drizzle-orm";
import { expect, it, vi } from "vitest";
import { createDatabase } from "@emby-task-center/database/client";
import { concurrencyEscalationState, submissionUsers } from "@emby-task-center/database/schema";
import type { EmbyClient, EmbyUserPolicy } from "../integrations/emby-client";
import { normalizeExpiryDate } from "./cards";
import { setDriveExpiry } from "./drive-expiry";
import { countPendingDriveExpirySync, syncDriveExpiryEmbyAccess } from "./drive-expiry-emby-sync";
import { getSubmissionUser } from "./membership";
import { disableExpiredEmbyUsers } from "./emby-account";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it("retries failed Emby restoration without extending time twice or lifting a member restriction", async () => {
  const { db, close } = createDatabase(":memory:");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2028-09-10T12:00:00Z"));
  try {
    const timestamp = new Date().toISOString();
    const members = db
      .insert(submissionUsers)
      .values(
        ["normal", "disabled", "frozen"].map((kind) => ({
          email: `${kind}@example.test`,
          embyUserId: kind,
          enabled: kind !== "disabled",
          subscriptionExpiresAt: normalizeExpiryDate("2029-04-15"),
          createdAt: timestamp,
          updatedAt: timestamp,
        })),
      )
      .returning()
      .all();
    db.insert(concurrencyEscalationState)
      .values({
        memberId: members[2]!.id,
        disabledUntil: normalizeExpiryDate("2028-09-20"),
        updatedAt: timestamp,
      })
      .run();
    const policies = new Map<string, EmbyUserPolicy>(
      members.map(({ embyUserId }) => [embyUserId!, { IsDisabled: true, SimultaneousStreamLimit: 3 }]),
    );
    let fail = true;
    const client = {
      configured: true,
      listUsers: async () => [...policies].map(([Id, Policy]) => ({ Id, Name: Id, Policy })),
      createUser: async () => ({ Id: "unused", Name: "unused" }),
      setUserPassword: async () => undefined,
      updateUserPolicy: async (id: string, policy: EmbyUserPolicy) => {
        if (fail && id === "normal") throw new Error("emby_http_503");
        policies.set(id, { ...policy });
      },
      deleteUser: async () => undefined,
      listSessions: async () => [],
    } as unknown as EmbyClient;
    setDriveExpiry(db, "2028-08-31", new Date("2028-04-01T12:00:00Z"));
    setDriveExpiry(db, "2029-01-01");
    expect(countPendingDriveExpirySync(db)).toBe(3);
    const normal = members[0]!;
    const entitlement = getSubmissionUser(db, normal.id)!;
    await syncDriveExpiryEmbyAccess(db, client);
    expect(countPendingDriveExpirySync(db)).toBe(1);
    expect(policies.get("normal")?.IsDisabled).toBe(true);

    fail = false;
    await syncDriveExpiryEmbyAccess(db, client);
    expect(countPendingDriveExpirySync(db)).toBe(0);
    expect(policies.get("normal")).toEqual({ IsDisabled: false, SimultaneousStreamLimit: 3 });
    expect(policies.get("disabled")?.IsDisabled).toBe(true);
    expect(policies.get("frozen")?.IsDisabled).toBe(true);
    expect(getSubmissionUser(db, normal.id)).toEqual({ ...entitlement, driveExpirySyncPending: false });
    expect(
      db.select().from(concurrencyEscalationState).where(eq(concurrencyEscalationState.memberId, members[2]!.id)).get()
        ?.disabledUntil,
    ).toBe(normalizeExpiryDate("2028-09-20"));
  } finally {
    vi.useRealTimers();
    close();
  }
});

it("restores the newer entitlement when an old Emby disable succeeds but its response is lost", async () => {
  const { db, close } = createDatabase(":memory:");
  vi.useFakeTimers({ toFake: ["Date"] });
  const now = new Date("2028-09-10T12:00:00Z");
  vi.setSystemTime(now);
  const entered = deferred();
  const release = deferred();
  try {
    const member = db
      .insert(submissionUsers)
      .values({
        email: "raced@example.test",
        embyUserId: "raced",
        subscriptionExpiresAt: normalizeExpiryDate("2029-04-15"),
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      })
      .returning()
      .get();
    let policy: EmbyUserPolicy = { IsDisabled: false, SimultaneousStreamLimit: 3 };
    const client = {
      configured: true,
      listUsers: async () => [{ Id: "raced", Name: "raced", Policy: policy }],
      createUser: async () => ({ Id: "unused", Name: "unused" }),
      setUserPassword: async () => undefined,
      updateUserPolicy: async (_id: string, next: EmbyUserPolicy) => {
        if (next.IsDisabled) {
          entered.resolve();
          await release.promise;
          policy = { ...next };
          throw new Error("socket closed after writing policy");
        }
        policy = { ...next };
      },
      deleteUser: async () => undefined,
      listSessions: async () => [],
    } as unknown as EmbyClient;
    setDriveExpiry(db, "2028-08-31", new Date("2028-04-01T12:00:00Z"));
    const expirySweep = disableExpiredEmbyUsers(db, client, now);
    await entered.promise;
    try {
      setDriveExpiry(db, "2029-01-01", now);
      await syncDriveExpiryEmbyAccess(db, client);
      expect(countPendingDriveExpirySync(db)).toBe(0);
    } finally {
      release.resolve();
      await expirySweep;
    }
    expect(policy).toEqual({ IsDisabled: false, SimultaneousStreamLimit: 3 });
    expect(getSubmissionUser(db, member.id)?.subscriptionExpiresAt).toBe(normalizeExpiryDate("2029-01-01"));
  } finally {
    vi.useRealTimers();
    close();
  }
});
