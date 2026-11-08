import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDatabase, type DatabaseHandle } from "@emby-task-center/database/client";
import {
  cardKeys,
  memberExpiryCleanupJobs,
  renewalEmailOutbox,
  submissionUsers,
  verificationCodes,
} from "@emby-task-center/database/schema";
import { createApp } from "../app";
import { staticCredentialVerifier } from "../auth/test-session";
import type { EmbyClient } from "../integrations/emby-client";
import { createLibraryService } from "../library/service";
import { activateMembershipWithCard } from "../subscriptions/card-activation";
import { addSubmissionUser, getSubmissionUser } from "../subscriptions/membership";
import { issueVerificationCode } from "../subscriptions/verification";
import type { TmdbClient } from "../tmdb/client";

const members = "/api/submission-users";
const subscriptions = "/api/public/subscriptions";
const driveExpiry = "/api/membership-drive-expiry";
const email = "member@example.invalid";
const embyUserId = "ordinary-emby-user";
const initialExpiry = "2026-01-01T00:00:00.000Z";

describe("pending member expiry deletion protects concurrent entitlement changes", () => {
  let database: DatabaseHandle;
  let server: Server;
  let base: string;
  let admin: string;
  let memberId: number;
  const deleteUser = vi.fn<NonNullable<EmbyClient["deleteUser"]>>();

  function request(path: string, method = "GET", payload?: unknown, cookie = admin) {
    return fetch(`${base}${path}`, {
      method,
      headers: { cookie, ...(payload === undefined ? {} : { "content-type": "application/json" }) },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });
  }

  async function assertError(response: Response, code: string) {
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: code });
  }

  function claim() {
    database.db
      .insert(memberExpiryCleanupJobs)
      .values({
        memberId,
        embyUserId,
        serverId: "fixture-server",
        leaseToken: "fixture-claim",
        leaseUntil: Date.now() + 60_000,
      })
      .run();
  }

  async function createCard(): Promise<string> {
    const response = await request("/api/cards", "POST", { kind: "month", count: 1 });
    expect(response.status).toBe(201);
    return ((await response.json()) as { codes: string[] }).codes[0]!;
  }

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-12-01T12:00:00Z"));
    database = createDatabase(":memory:");
    memberId = addSubmissionUser(database.db, { email, subscriptionExpiresAt: initialExpiry }).id;
    database.db.update(submissionUsers).set({ embyUserId }).where(eq(submissionUsers.id, memberId)).run();
    deleteUser.mockReset().mockResolvedValue(undefined);
    const app = createApp({
      database: database.db,
      auth: {
        sessionSecret: "guard-fixture-secret",
        verifyCredentials: staticCredentialVerifier("guard-fixture-password"),
      },
      tmdb: {} as TmdbClient,
      library: createLibraryService([]),
      integrationServices: {
        emby: {
          configured: false,
          systemInfo: async () => ({ id: "fixture-server", serverName: "Fixture", version: "0" }),
          verify: async () => false,
          deleteUser,
        },
        email: {
          configured: false,
          sendTest: async () => {},
          retryPending: async () => {},
          sendNotification: async () => {},
        },
      },
    });
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const login = await request("/api/auth/login", "POST", { password: "guard-fixture-password" }, "");
    expect(login.status).toBe(200);
    admin = login.headers.get("set-cookie")!.split(";")[0]!;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    database.close();
    vi.useRealTimers();
  });

  it("rejects new administrator renewals but returns an already committed renewal without granting more time", async () => {
    const renew = `${members}/${memberId}/renew`;
    const input = { mode: "days", days: 30, requestId: randomUUID(), expectedExpiresAt: initialExpiry };
    const first = await request(renew, "POST", input);
    expect(first.status).toBe(200);
    const currentExpiry = getSubmissionUser(database.db, memberId)!.subscriptionExpiresAt;
    claim();

    await assertError(
      await request(renew, "POST", { ...input, requestId: randomUUID(), expectedExpiresAt: currentExpiry }),
      "renewal_cleanup_pending",
    );
    const replay = await request(renew, "POST", input);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ repeated: true, emailStatus: "unchanged" });
    expect(getSubmissionUser(database.db, memberId)!.subscriptionExpiresAt).toBe(currentExpiry);
    expect(database.db.select().from(renewalEmailOutbox).all()).toHaveLength(1);
  });

  it("preserves unused cards and the verification code while allowing a prior card replay", async () => {
    const oldCard = await createCard();
    const freshCard = await createCard();
    activateMembershipWithCard(database.db, oldCard, email);
    const expiry = getSubmissionUser(database.db, memberId)!.subscriptionExpiresAt;
    claim();

    await assertError(
      await request(`${subscriptions}/card/check`, "POST", { email, cardCode: freshCard }, ""),
      "member_cleanup_pending",
    );
    const code = issueVerificationCode(database.db, email);
    await assertError(
      await request(`${subscriptions}/activate`, "POST", { email, code, cardCode: freshCard }, ""),
      "member_cleanup_pending",
    );
    expect(database.db.select().from(verificationCodes).where(eq(verificationCodes.email, email)).get()?.consumed).toBe(
      false,
    );
    expect(() => activateMembershipWithCard(database.db, freshCard, email)).toThrow("member_cleanup_pending");
    expect(database.db.select().from(cardKeys).where(eq(cardKeys.code, freshCard)).get()?.status).toBe("unused");

    const replay = await request(`${subscriptions}/activate`, "POST", { email, code, cardCode: oldCard }, "");
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ card: { idempotent: true }, emailStatus: "unchanged" });
    expect(getSubmissionUser(database.db, memberId)!.subscriptionExpiresAt).toBe(expiry);
    expect(database.db.select().from(renewalEmailOutbox).all()).toHaveLength(1);
  });

  it("blocks account edits, manual removals and only drive expiry changes that affect the pending record", async () => {
    claim();
    const member = `${members}/${memberId}`;
    await assertError(await request(member, "PUT", { subscriptionExpiresAt: null }), "member_cleanup_pending");
    await assertError(await request(member, "PUT", { enabled: false }), "member_cleanup_pending");
    await assertError(await request(member, "DELETE"), "member_cleanup_pending");
    await assertError(await request(`/api/emby/users/${embyUserId}`, "DELETE"), "member_cleanup_pending");
    await assertError(
      await request(`/api/emby/users/${embyUserId}/policy`, "POST", { IsAdministrator: true }),
      "member_cleanup_pending",
    );
    expect(deleteUser).not.toHaveBeenCalled();

    expect((await request(member, "PUT", { note: "记录备注" })).status).toBe(200);
    expect((await request(driveExpiry, "PUT", { date: "2028-08-31", expectedDate: null })).status).toBe(200);
    await assertError(
      await request(driveExpiry, "PUT", { date: "2025-12-30", expectedDate: "2028-08-31" }),
      "member_cleanup_pending",
    );
    expect(await (await request(driveExpiry)).json()).toMatchObject({ limit: { date: "2028-08-31" } });
    expect(getSubmissionUser(database.db, memberId)).toMatchObject({
      subscriptionExpiresAt: initialExpiry,
      note: "记录备注",
    });
  });

  it("rechecks for a cleanup claim before manual deletion can remove the member after waiting on Emby", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let entered!: () => void;
    const started = new Promise<void>((resolve) => (entered = resolve));
    deleteUser.mockImplementation(async () => {
      entered();
      await held;
    });
    const manual = request(`${members}/${memberId}`, "DELETE");
    await started;
    try {
      claim();
    } finally {
      release();
    }
    await assertError(await manual, "member_cleanup_pending");
    expect(getSubmissionUser(database.db, memberId)?.embyUserId).toBe(embyUserId);
  });
});
