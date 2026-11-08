import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDatabase, type DatabaseHandle } from "@emby-task-center/database/client";
import { auditLogs, submissionUsers } from "@emby-task-center/database/schema";
import { createApp } from "../app";
import { staticCredentialVerifier } from "../auth/test-session";
import type { EmbyClient } from "../integrations/emby-client";
import { createLibraryService } from "../library/service";
import type { EmailNotifier } from "../notifications/email-service";
import { normalizeExpiryDate } from "../subscriptions/cards";
import { issueVerificationCode } from "../subscriptions/verification";
import type { TmdbClient } from "../tmdb/client";

const DAY = 86_400_000;
const LIMIT = "/api/membership-drive-expiry";
const MEMBERS = "/api/submission-users";
const PORTAL = "/api/public/subscriptions";
const eod = (date: string) => normalizeExpiryDate(date)!;
type Member = typeof submissionUsers.$inferSelect;

describe("drive expiry through the real application HTTP routes", () => {
  let database: DatabaseHandle;
  let server: Server;
  let base: string;
  let admin: string;
  const send = vi.fn<EmailNotifier["sendNotification"]>();

  async function request<T = unknown>(
    path: string,
    options: { method?: string; payload?: unknown; cookie?: string; status?: number } = {},
  ) {
    const response = await fetch(`${base}${path}`, {
      method: options.method ?? "GET",
      headers: {
        ...(options.cookie ? { cookie: options.cookie } : {}),
        ...(options.payload === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(options.payload === undefined ? {} : { body: JSON.stringify(options.payload) }),
    });
    expect(response.status, `${options.method ?? "GET"} ${path}`).toBe(options.status ?? 200);
    return { body: (await response.json()) as T, cookie: response.headers.get("set-cookie")?.split(";")[0] ?? "" };
  }

  async function loginAdmin() {
    admin = (await request("/api/auth/login", { method: "POST", payload: { password: "test-password" } })).cookie;
    expect(admin).toBeTruthy();
  }

  beforeEach(async () => {
    vi.stubEnv("TZ", "Asia/Shanghai");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2028-04-01T12:00:00.000Z"));
    database = createDatabase(":memory:");
    send.mockReset().mockResolvedValue();
    const app = createApp({
      database: database.db,
      auth: {
        sessionSecret: "drive-expiry-fixture-secret",
        verifyCredentials: staticCredentialVerifier("test-password"),
      },
      tmdb: {} as TmdbClient,
      library: createLibraryService([]),
      integrationServices: {
        emby: { configured: false } as EmbyClient,
        email: { configured: true, sendNotification: send, retryPending: async () => {}, sendTest: async () => {} },
      },
    });
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    await loginAdmin();
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    database.close();
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  function saveLimit(date: string, expectedDate: string | null = null, status = 200) {
    return request(LIMIT, { method: "PUT", payload: { date, expectedDate }, cookie: admin, status });
  }

  async function addMember(expiresAt: string | null) {
    const email = `${randomUUID()}@example.invalid`;
    return (
      await request<{ user: Member }>(MEMBERS, {
        method: "POST",
        payload: { email, subscriptionExpiresAt: expiresAt },
        cookie: admin,
        status: 201,
      })
    ).body.user;
  }

  async function loginMember(email: string) {
    const code = issueVerificationCode(database.db, email);
    const result = await request(`${PORTAL}/login`, { method: "POST", payload: { email, code } });
    expect(result.cookie).toBeTruthy();
    return result.cookie;
  }

  async function makeCard(payload: { kind: "year" | "custom"; expiresAt?: string; expiryLabel?: string }) {
    const response = await request<{ codes: string[] }>("/api/cards", {
      method: "POST",
      cookie: admin,
      status: 201,
      payload: { count: 1, ...payload },
    });
    return response.body.codes[0]!;
  }

  function redeem(email: string, cardCode: string) {
    const code = issueVerificationCode(database.db, email);
    return request(`${PORTAL}/activate`, { method: "POST", payload: { email, cardCode, code } });
  }

  async function adminMember(id: number) {
    const result = await request<{ users: Member[] }>(MEMBERS, { cookie: admin });
    return result.body.users.find((user) => user.id === id)!;
  }

  function renew(id: number, payload: object, status = 200) {
    return request(`${MEMBERS}/${id}/renew`, { method: "POST", cookie: admin, payload, status });
  }

  function expectMemberView(body: unknown, expiry: string) {
    expect(body).toMatchObject({ member: { subscriptionExpiresAt: expiry, membershipExpiryLabel: null } });
    expect(JSON.stringify(body)).not.toMatch(/deferredMembership|followsDriveExpiry|driveExpirySyncPending|待激活/);
  }

  it("requires admin sessions, rejects malformed or stale writes, and applies the limit through ordinary member creation", async () => {
    expect((await request(LIMIT, { cookie: admin })).body).toEqual({ limit: null });
    const member = await addMember(eod("2028-04-15"));
    const memberCookie = await loginMember(member.email);
    await request(LIMIT, { status: 401 });
    await request(LIMIT, { cookie: memberCookie, status: 401 });
    await request(LIMIT, {
      method: "PUT",
      cookie: memberCookie,
      payload: { date: "2028-08-31", expectedDate: null },
      status: 401,
    });
    expect((await saveLimit("2028-02-30", null, 400)).body).toEqual({ error: "invalid_drive_expiry" });
    expect((await saveLimit("2028-8-31", null, 400)).body).toEqual({ error: "invalid_request" });
    expect((await saveLimit("2028-08-31")).body).toMatchObject({
      limit: { date: "2028-08-31", expiresAt: eod("2028-08-31") },
    });
    expect((await saveLimit("2028-08-31")).body).toMatchObject({ changedMembers: 0, releasedMembers: 0 });
    expect((await saveLimit("2028-12-31", null, 409)).body).toEqual({ error: "drive_expiry_changed" });
    expect(await addMember(eod("2029-04-15"))).toMatchObject({
      subscriptionExpiresAt: eod("2028-08-31"),
      deferredMembershipMs: 227 * DAY,
      followsDriveExpiry: false,
    });
    expect(await addMember(null)).toMatchObject({
      subscriptionExpiresAt: eod("2028-08-31"),
      deferredMembershipMs: 0,
      followsDriveExpiry: true,
    });
  });

  it("shows the 227-day annual-card balance only to administrators and protects same-expiry replays", async () => {
    const member = await addMember(eod("2028-04-15"));
    const cap = eod("2028-08-31");
    await saveLimit("2028-08-31");
    const cardCode = await makeCard({ kind: "year" });
    const preview = await request(`${PORTAL}/card/check`, {
      method: "POST",
      payload: { email: member.email, cardCode },
    });
    expect(preview.body).toMatchObject({ card: { expiresAt: cap } });
    expect(JSON.stringify(preview.body)).not.toMatch(/deferredMembership|followsDriveExpiry|待激活/);
    const first = await redeem(member.email, cardCode);
    expectMemberView(first.body, cap);
    expectMemberView((await request(`${PORTAL}/member`, { cookie: first.cookie })).body, cap);
    expect(await adminMember(member.id)).toMatchObject({ subscriptionExpiresAt: cap, deferredMembershipMs: 227 * DAY });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![2]).not.toMatch(/227|待激活|增加 365 天/);
    expect((await redeem(member.email, cardCode)).body).toMatchObject({
      card: { idempotent: true },
      emailStatus: "unchanged",
    });
    expect(await adminMember(member.id)).toMatchObject({ deferredMembershipMs: 227 * DAY });
    const input = {
      mode: "days",
      days: 30,
      requestId: randomUUID(),
      expectedExpiresAt: cap,
      expectedDeferredMembershipMs: 227 * DAY,
    };
    expect((await renew(member.id, input)).body).toMatchObject({
      user: { subscriptionExpiresAt: cap, deferredMembershipMs: 257 * DAY },
    });
    expect((await renew(member.id, input)).body).toMatchObject({ repeated: true, emailStatus: "unchanged" });
    database.db.delete(auditLogs).where(eq(auditLogs.action, "member.renewed")).run();
    expect((await renew(member.id, input)).body).toMatchObject({ repeated: true, emailStatus: "unchanged" });
    expect((await renew(member.id, { ...input, requestId: randomUUID() }, 409)).body).toEqual({
      error: "renewal_expiry_changed",
    });
    expect(await adminMember(member.id)).toMatchObject({ deferredMembershipMs: 257 * DAY });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("tops up fixed-date entitlements once even when a second card targets the same date", async () => {
    await saveLimit("2028-08-31");
    const cap = eod("2028-08-31");
    const member = await addMember(cap);
    const card = { kind: "custom" as const, expiresAt: "2029-04-15", expiryLabel: "上限外的名称" };
    for (let index = 0; index < 2; index++) {
      const result = await redeem(member.email, await makeCard(card));
      expectMemberView(result.body, cap);
      expect(JSON.stringify(result.body)).not.toContain("上限外的名称");
      expect(await adminMember(member.id)).toMatchObject({ deferredMembershipMs: 227 * DAY });
    }
    const input = {
      mode: "date",
      date: "2029-04-25",
      requestId: randomUUID(),
      expectedExpiresAt: cap,
      expectedDeferredMembershipMs: 227 * DAY,
    };
    expect((await renew(member.id, input)).body).toMatchObject({
      user: { subscriptionExpiresAt: cap, deferredMembershipMs: 237 * DAY },
    });
    expect(
      (await renew(member.id, { ...input, requestId: randomUUID(), expectedDeferredMembershipMs: 237 * DAY }, 409))
        .body,
    ).toEqual({ error: "renewal_date_not_later" });
    expect(await adminMember(member.id)).toMatchObject({ deferredMembershipMs: 237 * DAY });
  });

  it("restores frozen time after the cap expires without spending the outage gap", async () => {
    const member = await addMember(eod("2029-04-15"));
    await saveLimit("2028-08-31");
    const resumedAt = new Date("2028-09-09T12:00:00.000Z");
    vi.setSystemTime(resumedAt);
    await loginAdmin();
    const cookie = await loginMember(member.email);
    expect((await request(`${PORTAL}/member`, { cookie })).body).toMatchObject({
      member: { status: "expired", contentAccess: false },
    });
    const next = eod("2028-12-31");
    expect((await saveLimit("2028-12-31", "2028-08-31")).body).toMatchObject({ releasedMembers: 1, changedMembers: 1 });
    const left = 227 * DAY - (Date.parse(next) - resumedAt.getTime());
    expect(await adminMember(member.id)).toMatchObject({ subscriptionExpiresAt: next, deferredMembershipMs: left });
    expectMemberView((await request(`${PORTAL}/member`, { cookie })).body, next);
    expect((await saveLimit("2029-06-01", "2028-12-31")).body).toMatchObject({ releasedMembers: 1 });
    const final = new Date(resumedAt.getTime() + 227 * DAY).toISOString();
    expect(await adminMember(member.id)).toMatchObject({ subscriptionExpiresAt: final, deferredMembershipMs: 0 });
    expect((await request(`${PORTAL}/member`, { cookie })).body).toMatchObject({
      member: { status: "active", contentAccess: true, subscriptionExpiresAt: final },
    });
  });

  it("rejects a renewal previewed under an old cap even when the member expiry and balance are unchanged", async () => {
    const member = await addMember(eod("2028-04-15"));
    await saveLimit("2028-08-31");
    const input = {
      mode: "days",
      days: 180,
      requestId: randomUUID(),
      expectedExpiresAt: eod("2028-04-15"),
      expectedDeferredMembershipMs: 0,
      expectedDriveExpiryDate: "2028-08-31",
    };
    await saveLimit("2028-12-31", "2028-08-31");
    expect((await renew(member.id, input, 409)).body).toEqual({ error: "renewal_drive_expiry_changed" });
    expect(await adminMember(member.id)).toMatchObject({
      subscriptionExpiresAt: input.expectedExpiresAt,
      deferredMembershipMs: 0,
    });
    expect(send).not.toHaveBeenCalled();
    const confirmed = { ...input, expectedDriveExpiryDate: "2028-12-31" };
    expect((await renew(member.id, confirmed)).body).toMatchObject({
      user: { subscriptionExpiresAt: eod("2028-10-12"), deferredMembershipMs: 0 },
    });
    await saveLimit("2029-01-01", "2028-12-31");
    expect((await renew(member.id, confirmed)).body).toMatchObject({ repeated: true, emailStatus: "unchanged" });
  });
});
