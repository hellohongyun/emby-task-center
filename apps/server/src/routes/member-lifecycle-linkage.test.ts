import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { cardKeys, concurrencyEscalationState, submissionUsers } from "@emby-task-center/database/schema";
import { memberLinkageFixture } from "./member-linkage-fixture";

describe("member lifecycle across real HTTP, SQLite and the Emby HTTP client", () => {
  let fixture: Awaited<ReturnType<typeof memberLinkageFixture>>;
  let admin: string;
  let email: string;
  const cookie = (response: Response) => response.headers.get("set-cookie")?.split(";")[0] ?? "";
  beforeEach(async () => {
    email = `linkage-${randomUUID()}@example.invalid`;
    fixture = await memberLinkageFixture();
    const login = await fixture.request("/api/auth/login", { password: "linkage-password" });
    expect(login.status).toBe(200);
    admin = cookie(login);
  });
  afterEach(async () => fixture.dispose());

  async function card() {
    const response = await fixture.request("/api/cards", { kind: "month", count: 1 }, admin);
    expect(response.status).toBe(201);
    return ((await response.json()) as { codes: string[] }).codes[0]!;
  }
  async function code(cardCode?: string) {
    const response = await fixture.request("/api/public/subscriptions/code", {
      email,
      ...(cardCode ? { cardCode } : {}),
    });
    expect(response.status).toBe(200);
    const text = fixture.mail.filter((entry) => entry.to === email && entry.text.includes("验证码")).at(-1)?.text;
    const value = text?.match(/验证码：(\d{6})/)?.[1];
    expect(value).toMatch(/^\d{6}$/);
    return value!;
  }
  async function activate(cardCode: string) {
    const response = await fixture.request("/api/public/subscriptions/activate", {
      email,
      cardCode,
      code: await code(cardCode),
    });
    expect(response.status).toBe(200);
    return { cookie: cookie(response), body: await response.json() };
  }
  function member() {
    return fixture.database.db.select().from(submissionUsers).where(eq(submissionUsers.email, email)).get()!;
  }
  async function update(body: unknown) {
    const response = await fixture.request(`/api/submission-users/${member().id}`, body, admin, "PUT");
    expect(response.status).toBe(200);
    await response.json();
  }
  async function content(memberCookie: string, status: number, error?: string) {
    const response = await fixture.request("/api/public/tmdb/search?q=fixture", undefined, memberCookie);
    expect(response.status).toBe(status);
    if (error) expect(await response.json()).toMatchObject({ error });
    else await response.json();
  }

  it("opens an Emby account, authenticates both roles, and renews without losing unrelated Emby policy", async () => {
    const opened = await activate(await card());
    expect(opened.body).toMatchObject({ status: "activated", member: { contentAccess: true, embyMaxStreams: 1 } });
    expect(member().embyUserId).toBe(fixture.users[0]?.Id);
    expect(fixture.users).toHaveLength(1);
    expect(fixture.writes.some((entry) => entry.path.endsWith("/Password"))).toBe(true);
    expect(fixture.users[0]?.Policy).toMatchObject({ SimultaneousStreamLimit: 1, EnabledDevices: ["kept-device"] });
    await content(opened.cookie, 200);
    const login = await fixture.request("/api/public/subscriptions/login", { email, code: await code() });
    expect(login.status).toBe(200);
    await content(cookie(login), 200);
    const firstExpiry = Date.parse(member().subscriptionExpiresAt!);
    await activate(await card());
    expect(Date.parse(member().subscriptionExpiresAt!)).toBeGreaterThan(firstExpiry + 29 * 86_400_000);
    expect(fixture.users).toHaveLength(1);
    const memberToken = opened.cookie.split("=")[1];
    const adminToken = admin.split("=")[1];
    expect((await fixture.request("/api/cards", undefined, `emby_task_session=${memberToken}`)).status).toBe(401);
    expect(
      (await fixture.request("/api/public/subscriptions/member", undefined, `emby_public_session=${adminToken}`))
        .status,
    ).toBe(401);
  });

  it("revokes old sessions on administrator disable and refuses renewal without consuming a new card", async () => {
    const opened = await activate(await card());
    const renewal = await card();
    const pendingCode = await code();
    await update({ enabled: false });
    expect(fixture.users[0]?.Policy).toMatchObject({
      IsDisabled: true,
      SimultaneousStreamLimit: 1,
      EnabledDevices: ["kept-device"],
    });
    const profile = await fixture.request("/api/public/subscriptions/member", undefined, opened.cookie);
    expect(profile.status).toBe(403);
    expect(await profile.json()).toMatchObject({ error: "member_disabled" });
    expect(profile.headers.get("set-cookie")).toContain("Max-Age=0");
    await content(opened.cookie, 403, "member_disabled");
    const login = await fixture.request("/api/public/subscriptions/login", { email, code: pendingCode });
    expect(login.status).toBe(403);
    const rejected = await fixture.request("/api/public/subscriptions/activate", {
      email,
      code: pendingCode,
      cardCode: renewal,
    });
    expect(rejected.status).toBe(403);
    expect(await rejected.json()).toMatchObject({ error: "member_disabled" });
    expect(fixture.database.db.select().from(cardKeys).where(eq(cardKeys.code, renewal)).get()?.status).toBe("unused");
  });

  it("restores an expired unfrozen account on new-card renewal, but an old-card retry has no extra effects", async () => {
    const initialCard = await card();
    const opened = await activate(initialCard);
    await update({ subscriptionExpiresAt: new Date(Date.now() - 86_400_000).toISOString() });
    expect(fixture.users[0]?.Policy?.IsDisabled).toBe(true);
    await content(opened.cookie, 403, "membership_expired");
    // Reusing the old card cannot extend the expired subscription or re-enable Emby.
    const previousExpiry = member().subscriptionExpiresAt;
    const beforeRetry = fixture.writes.length;
    const retry = await activate(initialCard);
    expect(retry.body).toMatchObject({
      card: { idempotent: true },
      member: { status: "expired", contentAccess: false },
    });
    expect(member().subscriptionExpiresAt).toBe(previousExpiry);
    expect(fixture.writes).toHaveLength(beforeRetry);
    expect(fixture.users[0]?.Policy?.IsDisabled).toBe(true);
    const renewed = await activate(await card());
    expect(renewed.body).toMatchObject({ member: { contentAccess: true } });
    expect(fixture.users[0]?.Policy).toMatchObject({
      IsDisabled: false,
      SimultaneousStreamLimit: 1,
      EnabledDevices: ["kept-device"],
    });
    await content(renewed.cookie, 200);
  });

  it("allows expired profile/login/renewal while preserving a persisted concurrency freeze and Emby disable", async () => {
    const opened = await activate(await card());
    await update({ subscriptionExpiresAt: new Date(Date.now() - 86_400_000).toISOString() });
    await content(opened.cookie, 403, "membership_expired");
    const profile = await fixture.request("/api/public/subscriptions/member", undefined, opened.cookie);
    expect(profile.status).toBe(200);
    expect(await profile.json()).toMatchObject({ member: { status: "expired", contentAccess: false } });
    const passwordWrites = fixture.writes.filter((entry) => entry.path.endsWith("/Password")).length;
    expect(
      (
        await fixture.request(
          "/api/public/subscriptions/member/emby/password",
          { password: "blocked-password" },
          opened.cookie,
        )
      ).status,
    ).toBe(403);
    expect(fixture.writes.filter((entry) => entry.path.endsWith("/Password"))).toHaveLength(passwordWrites);
    const login = await fixture.request("/api/public/subscriptions/login", { email, code: await code() });
    expect(login.status).toBe(200);
    const until = new Date(Date.now() + 3_600_000).toISOString();
    // Controlled persisted watchdog state; the expiry, renewal and access services remain real.
    fixture.database.db
      .insert(concurrencyEscalationState)
      .values({ memberId: member().id, disabledUntil: until, updatedAt: new Date().toISOString() })
      .run();
    const writeStart = fixture.writes.length;
    const renewed = await activate(await card());
    expect(renewed.body).toMatchObject({ member: { contentAccess: false, concurrency: { disabled: true } } });
    expect(Date.parse(member().subscriptionExpiresAt!)).toBeGreaterThan(Date.now());
    expect(fixture.database.db.select().from(concurrencyEscalationState).get()?.disabledUntil).toBe(until);
    expect(fixture.users[0]?.Policy).toMatchObject({ IsDisabled: true, EnabledDevices: ["kept-device"] });
    expect(
      fixture.writes
        .slice(writeStart)
        .filter((entry) => entry.path.endsWith("/Policy"))
        .every((entry) => (entry.body as { IsDisabled: boolean }).IsDisabled),
    ).toBe(true);
    await content(renewed.cookie, 403, "member_frozen");
  });
});
