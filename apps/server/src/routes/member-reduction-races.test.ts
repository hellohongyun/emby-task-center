import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabase, type DatabaseHandle } from "@emby-task-center/database/client";
import { concurrencyEscalationState, renewalEmailOutbox, submissionUsers } from "@emby-task-center/database/schema";
import type { EmbyClient, EmbyUserPolicy } from "../integrations/emby-client";
import { addSubmissionUser, getSubmissionUser } from "../subscriptions/membership";
import { renewMember, renewalSchema } from "../subscriptions/admin-renewal";
import { syncDriveExpiryEmbyAccess } from "../subscriptions/drive-expiry-emby-sync";
import { registerMemberReduction } from "./member-reduction";

function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("reduction external operation races", () => {
  let handle: DatabaseHandle;
  let server: Server;
  let base: string;
  let policy: EmbyUserPolicy;
  let client: EmbyClient;
  let intercept: (next: EmbyUserPolicy) => Promise<void>;
  beforeEach(async () => {
    handle = createDatabase(":memory:");
    policy = { IsDisabled: false, SimultaneousStreamLimit: 3 };
    intercept = async () => {};
    client = {
      configured: true,
      createUser: async () => ({ Id: "unused", Name: "unused" }),
      setUserPassword: async () => {},
      deleteUser: async () => {},
      listSessions: async () => [],
      listUsers: async () => [{ Id: "emby-1", Name: "member", Policy: policy }],
      updateUserPolicy: async (_id: string, next: EmbyUserPolicy) => {
        await intercept(next);
        policy = { ...next };
      },
    } as unknown as EmbyClient;
    const app = express();
    app.use(express.json());
    registerMemberReduction(app, { database: handle.db, emby: client });
    server = app.listen(0);
    await new Promise<void>((done) => server.once("listening", done));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    await new Promise<void>((done) => server.close(() => done()));
    handle.close();
  });
  function createMember() {
    const member = addSubmissionUser(handle.db, {
      email: "raced@example.invalid",
      subscriptionExpiresAt: "2020-01-01T00:00:00.000Z",
    });
    handle.db.update(submissionUsers).set({ embyUserId: "emby-1" }).where(eq(submissionUsers.id, member.id)).run();
    return member;
  }
  function post(user: ReturnType<typeof createMember>, requestId = randomUUID()) {
    return fetch(`${base}/api/submission-users/${user.id}/reduce-days`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        requestId,
        days: 1,
        expectedExpiresAt: user.subscriptionExpiresAt,
        expectedDeferredMembershipMs: 0,
        expectedDriveExpiryDate: null,
      }),
    });
  }
  it("requeues compensation if an older disable lands after renewal and a successful retry round", async () => {
    const user = createMember();
    const entered = latch();
    const release = latch();
    let first = true;
    intercept = async (next) => {
      if (next.IsDisabled && first) {
        first = false;
        entered.resolve();
        await release.promise;
      }
    };
    const request = post(user);
    await entered.promise;
    try {
      const current = getSubmissionUser(handle.db, user.id)!;
      renewMember(
        handle.db,
        user.id,
        renewalSchema.parse({
          mode: "days",
          days: 30,
          requestId: randomUUID(),
          expectedExpiresAt: current.subscriptionExpiresAt,
        }),
      );
      await syncDriveExpiryEmbyAccess(handle.db, client);
      expect(policy.IsDisabled).toBe(false);
      expect(getSubmissionUser(handle.db, user.id)?.driveExpirySyncPending).toBe(false);
    } finally {
      release.resolve();
    }
    expect(await (await request).json()).toMatchObject({ embyStatus: "sync_failed" });
    expect(getSubmissionUser(handle.db, user.id)?.driveExpirySyncPending).toBe(true);
    await syncDriveExpiryEmbyAccess(handle.db, client);
    expect(policy).toEqual({ IsDisabled: false, SimultaneousStreamLimit: 3 });
    expect(getSubmissionUser(handle.db, user.id)?.driveExpirySyncPending).toBe(false);
  });
  it("accepts only one of two simultaneous stale previews and sends only one durable receipt", async () => {
    const user = createMember();
    const results = await Promise.all([post(user), post(user)]);
    expect(results.map((response) => response.status).sort()).toEqual([200, 409]);
    expect(getSubmissionUser(handle.db, user.id)?.subscriptionExpiresAt).toBe("2019-12-31T00:00:00.000Z");
    expect(handle.db.select().from(renewalEmailOutbox).all()).toHaveLength(1);
  });
  it("does not mark a new Emby binding pending when the old binding's request finishes late", async () => {
    const user = createMember();
    const entered = latch();
    const release = latch();
    let first = true;
    intercept = async () => {
      if (first) {
        first = false;
        entered.resolve();
        await release.promise;
      }
    };
    const request = post(user);
    await entered.promise;
    handle.db.update(submissionUsers).set({ embyUserId: "replacement", driveExpirySyncPending: false }).run();
    release.resolve();
    expect(await (await request).json()).toMatchObject({ embyStatus: "sync_failed" });
    expect(getSubmissionUser(handle.db, user.id)).toMatchObject({
      embyUserId: "replacement",
      driveExpirySyncPending: false,
    });
  });
  it("replays a committed request while its first Emby call is still live without duplicate operations", async () => {
    const user = createMember();
    const entered = latch();
    const release = latch();
    let writes = 0;
    intercept = async () => {
      writes++;
      entered.resolve();
      await release.promise;
    };
    const requestId = randomUUID();
    const original = post(user, requestId);
    await entered.promise;
    try {
      expect(await (await post(user, requestId)).json()).toMatchObject({ repeated: true, embyStatus: "unchanged" });
      expect(writes).toBe(1);
      expect(handle.db.select().from(renewalEmailOutbox).all()).toHaveLength(1);
    } finally {
      release.resolve();
    }
    expect((await original).status).toBe(200);
  });
  it.each(["disabled", "frozen"])("keeps %s restrictions during delayed-disable compensation", async (kind) => {
    const user = createMember();
    const request = await post(user);
    expect(request.status).toBe(200);
    const current = getSubmissionUser(handle.db, user.id)!;
    renewMember(
      handle.db,
      user.id,
      renewalSchema.parse({
        mode: "days",
        days: 30,
        requestId: randomUUID(),
        expectedExpiresAt: current.subscriptionExpiresAt,
      }),
    );
    if (kind === "disabled") handle.db.update(submissionUsers).set({ enabled: false }).run();
    else
      handle.db
        .insert(concurrencyEscalationState)
        .values({
          memberId: user.id,
          disabledUntil: "2099-01-01T00:00:00.000Z",
          updatedAt: new Date().toISOString(),
        })
        .run();
    handle.db.update(submissionUsers).set({ driveExpirySyncPending: true }).run();
    await syncDriveExpiryEmbyAccess(handle.db, client);
    expect(policy.IsDisabled).toBe(true);
  });
});
