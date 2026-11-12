import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDatabase, type DatabaseHandle } from "@emby-task-center/database/client";
import { renewalEmailOutbox, submissionUsers } from "@emby-task-center/database/schema";
import { createApp } from "../app";
import { staticCredentialVerifier } from "../auth/test-session";
import { createLibraryService } from "../library/service";
import type { TmdbClient } from "../tmdb/client";
import type { EmbyClient } from "../integrations/emby-client";
import { addSubmissionUser, getSubmissionUser } from "../subscriptions/membership";
import { syncDriveExpiryEmbyAccess } from "../subscriptions/drive-expiry-emby-sync";
import { retryRenewalReceipts } from "../subscriptions/renewal-outbox";
import { createPublicSessionManager } from "../subscriptions/public-session";

describe("membership reduction API", () => {
  let directory: string;
  let handle: DatabaseHandle;
  let server: Server;
  let base: string;
  let cookie: string;
  let emby: EmbyClient;
  let disabled: boolean;
  const send = vi.fn();
  const policyWrite = vi.fn();
  const email = { configured: true, sendNotification: send };
  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "reduction-route-"));
    handle = createDatabase(join(directory, "test.db"));
    disabled = false;
    send.mockReset().mockResolvedValue(undefined);
    policyWrite.mockReset().mockImplementation(async (_id, policy) => {
      disabled = policy.IsDisabled;
    });
    emby = {
      configured: true,
      createUser: async () => {
        throw new Error("unused");
      },
      setUserPassword: async () => {},
      deleteUser: async () => {},
      listSessions: async () => [],
      listUsers: async () => [
        { Id: "emby-1", Name: "member", Policy: { IsDisabled: disabled, SimultaneousStreamLimit: 2 } },
      ],
      updateUserPolicy: policyWrite,
    } as unknown as EmbyClient;
    const app = createApp({
      database: handle.db,
      auth: { sessionSecret: "reduction-secret", verifyCredentials: staticCredentialVerifier("test-password") },
      tmdb: {} as TmdbClient,
      library: createLibraryService([]),
      integrationServices: { emby, email: email as never },
    });
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const login = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "test-password" }),
    });
    cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  });
  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    handle.close();
    rmSync(directory, { recursive: true, force: true });
  });
  function member() {
    const user = addSubmissionUser(handle.db, {
      email: "member@example.com",
      subscriptionExpiresAt: "2020-01-01T00:00:00.000Z",
    });
    handle.db.update(submissionUsers).set({ embyUserId: "emby-1" }).where(eq(submissionUsers.id, user.id)).run();
    return user;
  }
  function input(user: ReturnType<typeof member>) {
    return {
      requestId: randomUUID(),
      days: 1,
      expectedExpiresAt: user.subscriptionExpiresAt,
      expectedDeferredMembershipMs: 0,
      expectedDriveExpiryDate: null,
      reason: "调整",
    };
  }
  function post(id: number, body: unknown, auth = cookie) {
    return fetch(`${base}/api/submission-users/${id}/reduce-days`, {
      method: "POST",
      headers: { cookie: auth, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }
  it("requires administrator auth and rejects malformed data", async () => {
    const user = member();
    const publicCookie = createPublicSessionManager("reduction-secret").issueCookie(user.email).split(";")[0]!;
    expect((await post(user.id, input(user), "")).status).toBe(401);
    expect((await post(user.id, input(user), publicCookie)).status).toBe(401);
    expect((await post(user.id, { ...input(user), days: 0 })).status).toBe(400);
    expect((await post(99999, input(user))).status).toBe(404);
    expect(getSubmissionUser(handle.db, user.id)?.subscriptionExpiresAt).toBe(user.subscriptionExpiresAt);
  });
  it("disables expired Emby access, sends correct mail and does not repeat side effects", async () => {
    const user = member();
    const request = input(user);
    expect(await (await post(user.id, request)).json()).toMatchObject({
      repeated: false,
      embyStatus: "synced",
      emailStatus: "sent",
      user: { subscriptionExpiresAt: "2019-12-31T00:00:00.000Z", driveExpirySyncPending: false },
    });
    expect(policyWrite).toHaveBeenCalledWith("emby-1", { IsDisabled: true, SimultaneousStreamLimit: 2 });
    expect(send.mock.calls[0]?.[1]).toContain("会员时长扣减");
    expect(send.mock.calls[0]?.[2]).toContain("本次扣减：1 天");
    const writes = policyWrite.mock.calls.length;
    expect(await (await post(user.id, request)).json()).toMatchObject({
      repeated: true,
      embyStatus: "unchanged",
      emailStatus: "unchanged",
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(policyWrite).toHaveBeenCalledTimes(writes);
    expect((await post(user.id, { ...request, days: 2 })).status).toBe(409);
  });
  it("persists failed Emby and SMTP operations and recovers using existing retry workers", async () => {
    const user = member();
    policyWrite.mockRejectedValue(new Error("offline"));
    send.mockRejectedValue(new Error("SMTP offline"));
    const request = input(user);
    expect(await (await post(user.id, request)).json()).toMatchObject({
      embyStatus: "sync_failed",
      emailStatus: "pending",
      user: { subscriptionExpiresAt: "2019-12-31T00:00:00.000Z", driveExpirySyncPending: true },
    });
    const calls = send.mock.calls.length;
    expect(await (await post(user.id, request)).json()).toMatchObject({ repeated: true });
    expect(send).toHaveBeenCalledTimes(calls);
    policyWrite.mockImplementation(async (_id, policy) => {
      disabled = policy.IsDisabled;
    });
    send.mockResolvedValue(undefined);
    handle.db.update(renewalEmailOutbox).set({ nextAttemptAt: "2000-01-01T00:00:00.000Z" }).run();
    await syncDriveExpiryEmbyAccess(handle.db, emby);
    await retryRenewalReceipts(handle.db, email as never);
    expect(getSubmissionUser(handle.db, user.id)?.driveExpirySyncPending).toBe(false);
    expect(disabled).toBe(true);
    expect(handle.db.select().from(renewalEmailOutbox).get()?.sentAt).toBeTruthy();
  });
  it("does not change active account policy when a reduction leaves the membership valid", async () => {
    const user = addSubmissionUser(handle.db, {
      email: "active@example.com",
      subscriptionExpiresAt: "2099-01-01T00:00:00.000Z",
    });
    handle.db.update(submissionUsers).set({ embyUserId: "emby-1" }).where(eq(submissionUsers.id, user.id)).run();
    expect(await (await post(user.id, input(user))).json()).toMatchObject({
      embyStatus: "unchanged",
      emailStatus: "sent",
    });
    expect(policyWrite).not.toHaveBeenCalled();
  });
});
