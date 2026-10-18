import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDatabase, type DatabaseHandle } from "@emby-task-center/database/client";
import { cardKeys, concurrencyEscalationState, submissionUsers } from "@emby-task-center/database/schema";
import type { EmbyClient } from "../integrations/emby-client";
import type { EmailNotifier } from "../notifications/email-service";
import { createCardKeys, redeemCard } from "../subscriptions/cards";
import { createPublicSessionManager } from "../subscriptions/public-session";
import { issueVerificationCode } from "../subscriptions/verification";
import { registerPublicSubscriptionRoutes } from "./public-subscriptions";

const memberEmail = "idempotency@example.invalid";
const originalAt = "2020-01-01T00:00:00.000Z";

describe("old card redemption has no membership or Emby side effects", () => {
  let database: DatabaseHandle;
  let server: Server;
  let baseUrl: string;
  let code: string;
  let emby: EmbyClient;
  let email: EmailNotifier;
  let embyCalls: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(async () => {
    database = createDatabase(":memory:");
    database.db
      .insert(submissionUsers)
      .values({
        email: memberEmail,
        enabled: true,
        subscriptionExpiresAt: originalAt,
        membershipExpiryLabel: "原有效期",
        membershipReminderState: "expired",
        membershipRemindedAt: originalAt,
        embyUserId: "fixture-user",
        embyUsername: memberEmail,
        createdAt: originalAt,
        updatedAt: originalAt,
      })
      .run();
    const member = database.db.select().from(submissionUsers).get()!;
    database.db
      .insert(concurrencyEscalationState)
      .values({
        memberId: member.id,
        disabledUntil: "2099-01-01T00:00:00.000Z",
        updatedAt: originalAt,
      })
      .run();
    code = createCardKeys(database.db, { kind: "month", count: 1 })[0]!;
    redeemCard(database.db, code, memberEmail);
    embyCalls = {
      listUsers: vi.fn(async () => [{ Id: "fixture-user", Name: memberEmail, Policy: { IsDisabled: true } }]),
      createUser: vi.fn(async () => ({ Id: "unexpected-user", Name: memberEmail })),
      setUserPassword: vi.fn(async () => undefined),
      updateUserPolicy: vi.fn(async () => undefined),
      deleteUser: vi.fn(async () => undefined),
      listSessions: vi.fn(async () => []),
    };
    emby = { configured: true, ...embyCalls } as unknown as EmbyClient;
    email = { configured: true, sendNotification: vi.fn(async () => undefined) } as unknown as EmailNotifier;
    const app = express();
    app.use(express.json());
    registerPublicSubscriptionRoutes(app, {
      database: database.db,
      emby,
      email,
      publicSession: createPublicSessionManager("fixture-secret"),
    });
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    database.close();
  });

  function snapshot() {
    return {
      members: database.db.select().from(submissionUsers).all(),
      cards: database.db.select().from(cardKeys).all(),
      frozen: database.db.select().from(concurrencyEscalationState).all(),
    };
  }

  async function activate(verificationCode?: string) {
    const issued = issueVerificationCode(database.db, memberEmail);
    return fetch(`${baseUrl}/api/public/subscriptions/activate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: memberEmail, cardCode: code, code: verificationCode ?? issued }),
    });
  }

  function expectNoExternalCalls() {
    for (const call of Object.values(embyCalls)) expect(call).not.toHaveBeenCalled();
    expect(email.sendNotification).not.toHaveBeenCalled();
  }

  it("does not re-enable an expired/disabled/frozen member or alter reminder state", async () => {
    database.db.update(submissionUsers).set({ enabled: false }).run();
    const before = snapshot();
    const response = await activate();
    expect(response.status).toBe(403);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(await response.json()).toEqual({ error: "member_disabled" });
    expect(snapshot()).toEqual(before);
    expectNoExternalCalls();
  });

  it("preserves a permanent membership's null expiry on replay", async () => {
    database.db.update(submissionUsers).set({ enabled: true, subscriptionExpiresAt: null }).run();
    const before = snapshot();
    const response = await activate();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      member: { subscriptionExpiresAt: null },
      card: { idempotent: true },
    });
    expect(snapshot()).toEqual(before);
    expectNoExternalCalls();
  });

  it("does not retry Emby provisioning when replaying an old card without a linked account", async () => {
    database.db.update(submissionUsers).set({ embyUserId: null, embyUsername: null }).run();
    const before = snapshot();
    const response = await activate();
    expect(response.status).toBe(200);
    await response.json();
    expect(snapshot()).toEqual(before);
    expectNoExternalCalls();
  });

  it("cannot recreate a deleted member with an already consumed card", async () => {
    database.db.delete(concurrencyEscalationState).run();
    database.db.delete(submissionUsers).where(eq(submissionUsers.email, memberEmail)).run();
    const before = snapshot();
    const response = await activate();
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "not_member" });
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(snapshot()).toEqual(before);
    expectNoExternalCalls();
  });

  it("still requires a correct verification code before returning an idempotent result", async () => {
    const before = snapshot();
    const response = await activate("000000");
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "invalid_code" });
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(snapshot()).toEqual(before);
    expectNoExternalCalls();
  });
});
