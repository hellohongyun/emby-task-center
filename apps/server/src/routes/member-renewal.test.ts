import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDatabase, type DatabaseHandle } from "@emby-task-center/database/client";
import { auditLogs, submissionUsers, concurrencyEscalationState } from "@emby-task-center/database/schema";
import { createApp } from "../app";
import { staticCredentialVerifier } from "../auth/test-session";
import { createLibraryService } from "../library/service";
import type { TmdbClient } from "../tmdb/client";
import type { EmbyClient } from "../integrations/emby-client";
import { addSubmissionUser, getSubmissionUser } from "../subscriptions/membership";
import { renewMember, renewalSchema } from "../subscriptions/admin-renewal";
import { normalizeExpiryDate } from "../subscriptions/cards";

describe("administrator direct renewal", () => {
  let dir: string;
  let handle: DatabaseHandle;
  let server: Server;
  let base: string;
  let cookie: string;
  const policyWrite = vi.fn();
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "member-renewal-"));
    handle = createDatabase(join(dir, "test.db"));
    policyWrite.mockReset().mockRejectedValue(new Error("offline"));
    const app = createApp({
      database: handle.db,
      auth: { sessionSecret: "test-secret", verifyCredentials: staticCredentialVerifier("test-password") },
      tmdb: {} as TmdbClient,
      library: createLibraryService([]),
      integrationServices: {
        emby: {
          configured: true,
          listUsers: async () => [{ Id: "emby-1", Name: "test", Policy: { IsDisabled: true } }],
          createUser: async () => {
            throw new Error("unused");
          },
          setUserPassword: async () => {},
          updateUserPolicy: policyWrite,
          deleteUser: async () => {},
          listSessions: async () => [],
        } as unknown as EmbyClient,
        email: { configured: false } as never,
      },
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
    rmSync(dir, { recursive: true, force: true });
  });
  function member(expiry = "2030-01-01T00:00:00.000Z") {
    return addSubmissionUser(handle.db, { email: "member@example.com", subscriptionExpiresAt: expiry });
  }
  function input(expiry: string | null, days = 30) {
    return renewalSchema.parse({
      mode: "days",
      days,
      expectedExpiresAt: expiry,
      requestId: randomUUID(),
      reason: "反馈奖励",
    });
  }
  function post(id: number, body: unknown, auth = cookie) {
    return fetch(`${base}/api/submission-users/${id}/renew`, {
      method: "POST",
      headers: { cookie: auth, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }
  it("extends a future expiry, clears stale display/reminders and persists a single audited renewal across reopen", () => {
    const user = member();
    handle.db
      .update(submissionUsers)
      .set({ membershipExpiryLabel: "旧名称", membershipReminderState: "expired", membershipRemindedAt: "2026-01-01" })
      .where(eq(submissionUsers.id, user.id))
      .run();
    const request = input(user.subscriptionExpiresAt);
    const result = renewMember(handle.db, user.id, request, new Date("2026-11-01"));
    expect(result.user.subscriptionExpiresAt).toBe("2030-01-31T00:00:00.000Z");
    expect(result.user.membershipExpiryLabel).toBeNull();
    expect(result.user.membershipReminderState).toBeNull();
    handle.close();
    handle = createDatabase(join(dir, "test.db"));
    expect(renewMember(handle.db, user.id, request).repeated).toBe(true);
    expect(handle.db.select().from(auditLogs).all()).toHaveLength(1);
    expect(() => renewMember(handle.db, user.id, input(user.subscriptionExpiresAt))).toThrow("renewal_expiry_changed");
    expect(() => renewMember(handle.db, user.id, { ...request, days: 60 } as typeof request)).toThrow(
      "renewal_request_conflict",
    );
  });
  it("extends expired membership from now and normalizes a fixed date to server-local end of day", () => {
    const user = member("2020-01-01T00:00:00.000Z");
    const now = new Date("2026-11-01T09:00:00.000Z");
    const result = renewMember(handle.db, user.id, input(user.subscriptionExpiresAt, 1), now);
    expect(result.user.subscriptionExpiresAt).toBe("2026-11-02T09:00:00.000Z");
    const fixed = renewalSchema.parse({
      mode: "date",
      date: "2027-05-01",
      requestId: randomUUID(),
      expectedExpiresAt: result.user.subscriptionExpiresAt,
    });
    if (fixed.mode !== "date") throw new Error("expected date input");
    expect(renewMember(handle.db, user.id, fixed, now).user.subscriptionExpiresAt).toBe(
      normalizeExpiryDate("2027-05-01"),
    );
    expect(() =>
      renewMember(
        handle.db,
        user.id,
        { ...fixed, requestId: randomUUID(), expectedExpiresAt: normalizeExpiryDate("2027-05-01"), date: "2027-02-31" },
        now,
      ),
    ).toThrow("renewal_invalid_date");
  });
  it("stores custom labels in both modes and normalizes legacy replay inputs without changing membership", () => {
    const user = member("2020-01-01T00:00:00.000Z");
    const now = new Date("2026-11-01T09:00:00.000Z");
    const request = renewalSchema.parse({ ...input(user.subscriptionExpiresAt), expiryLabel: "  假期结束到期  " });
    const result = renewMember(handle.db, user.id, request, now);
    expect(result.user.membershipExpiryLabel).toBe("假期结束到期");
    const event = handle.db.select().from(auditLogs).get()!;
    expect(JSON.parse(event.after!)).toMatchObject({ membershipExpiryLabel: "假期结束到期" });
    expect(JSON.parse(event.before!)).toMatchObject({ membershipExpiryLabel: null });
    const fixed = renewalSchema.parse({
      mode: "date",
      date: "2027-05-01",
      requestId: randomUUID(),
      expectedExpiresAt: result.user.subscriptionExpiresAt,
      expiryLabel: " ",
    });
    const next = renewMember(handle.db, user.id, fixed, now);
    expect(next.user.membershipExpiryLabel).toBeNull();
    const receipt = handle.db.select().from(auditLogs).all()[1]!;
    const after = JSON.parse(receipt.after!);
    delete after.input.expiryLabel;
    handle.db
      .update(auditLogs)
      .set({ after: JSON.stringify(after) })
      .where(eq(auditLogs.id, receipt.id))
      .run();
    expect(renewMember(handle.db, user.id, fixed, now).repeated).toBe(true);
    expect(renewalSchema.safeParse({ ...request, expiryLabel: "名".repeat(61) }).success).toBe(false);
  });
  it("protects auth, rejects invalid days, stale dates and unlimited members without changing data", async () => {
    const user = member();
    expect((await post(user.id, input(user.subscriptionExpiresAt), "")).status).toBe(401);
    expect((await post(user.id, { ...input(user.subscriptionExpiresAt), days: 0 })).status).toBe(400);
    const fixed = {
      mode: "date",
      date: "2029-01-01",
      requestId: randomUUID(),
      expectedExpiresAt: user.subscriptionExpiresAt,
    };
    expect(await (await post(user.id, fixed)).json()).toMatchObject({ error: "renewal_date_not_later" });
    handle.db.update(submissionUsers).set({ subscriptionExpiresAt: null }).where(eq(submissionUsers.id, user.id)).run();
    expect(await (await post(user.id, input(null))).json()).toMatchObject({ error: "renewal_unlimited_member" });
    expect(handle.db.select().from(auditLogs).all()).toHaveLength(0);
  });
  it.each(["disabled", "frozen"])(
    "renews a %s member without restoring access or clearing freezes",
    async (restriction) => {
      const user = member("2020-01-01T00:00:00.000Z");
      handle.db
        .update(submissionUsers)
        .set({ embyUserId: "emby-1", enabled: restriction !== "disabled" })
        .where(eq(submissionUsers.id, user.id))
        .run();
      if (restriction === "frozen")
        handle.db
          .insert(concurrencyEscalationState)
          .values({ memberId: user.id, disabledUntil: "2030-01-01T00:00:00.000Z", updatedAt: new Date().toISOString() })
          .run();
      const result = await post(user.id, input(user.subscriptionExpiresAt));
      expect(await result.json()).toMatchObject({ embyStatus: "restricted" });
      expect(policyWrite).not.toHaveBeenCalled();
      expect(getSubmissionUser(handle.db, user.id)?.enabled).toBe(restriction !== "disabled");
      if (restriction === "frozen")
        expect(handle.db.select().from(concurrencyEscalationState).get()?.disabledUntil).toBeTruthy();
    },
  );
  it("reports a failed Emby restore separately and never adds days again on retry", async () => {
    const user = member("2020-01-01T00:00:00.000Z");
    handle.db.update(submissionUsers).set({ embyUserId: "emby-1" }).where(eq(submissionUsers.id, user.id)).run();
    const request = input(user.subscriptionExpiresAt);
    expect(await (await post(user.id, request)).json()).toMatchObject({ embyStatus: "restore_failed" });
    const expiry = getSubmissionUser(handle.db, user.id)?.subscriptionExpiresAt;
    const writes = policyWrite.mock.calls.length;
    expect(await (await post(user.id, request)).json()).toMatchObject({ repeated: true, embyStatus: "unchanged" });
    expect(getSubmissionUser(handle.db, user.id)?.subscriptionExpiresAt).toBe(expiry);
    expect(policyWrite.mock.calls.length).toBe(writes);
  });
});
