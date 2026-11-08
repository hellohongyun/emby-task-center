import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express, { type ErrorRequestHandler } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createDatabase, type DatabaseHandle } from "@emby-task-center/database/client";
import { cardKeys, renewalEmailOutbox, submissionUsers, userMailPreferences } from "@emby-task-center/database/schema";
import type { EmailNotifier } from "../notifications/email-service";
import { registerMemberRenewal } from "./member-renewal";
import { registerPublicSubscriptionRoutes } from "./public-subscriptions";
import { createPublicSessionManager } from "../subscriptions/public-session";
import { createCardKeys } from "../subscriptions/cards";
import { issueVerificationCode } from "../subscriptions/verification";
import { retryRenewalReceipts } from "../subscriptions/renewal-outbox";
import { activateCardForTest, postSubscription } from "../test-support/card-activation";

describe("administrator and card renewal notification HTTP flows", () => {
  let handle: DatabaseHandle;
  let server: Server;
  let base: string;
  let user: typeof submissionUsers.$inferSelect;
  const send = vi.fn<EmailNotifier["sendNotification"]>();
  let email: EmailNotifier;
  beforeEach(async () => {
    handle = createDatabase(":memory:");
    const timestamp = new Date().toISOString();
    user = handle.db
      .insert(submissionUsers)
      .values({
        email: "receipt@example.invalid",
        subscriptionExpiresAt: "2030-01-01T00:00:00.000Z",
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .returning()
      .get();
    send.mockReset().mockResolvedValue();
    email = { configured: true, sendNotification: send } as unknown as EmailNotifier;
    const app = express();
    app.use(express.json());
    registerMemberRenewal(app, { database: handle.db, email });
    registerPublicSubscriptionRoutes(app, {
      database: handle.db,
      email,
      publicSession: createPublicSessionManager("receipt-secret"),
    });
    const errors: ErrorRequestHandler = (_error, _request, response, _next) => {
      response.status(500).json({ error: "fixture_transaction_failed" });
    };
    app.use(errors);
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    handle.close();
  });
  async function post(path: string, body: unknown) {
    const response = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(200);
    return await response.json();
  }
  function renew(expiryLabel = "劳动节结束到期") {
    return {
      mode: "days",
      days: 30,
      requestId: randomUUID(),
      expectedExpiresAt: user.subscriptionExpiresAt,
      expiryLabel,
    };
  }
  async function redeem(cardCode: string, address = user.email) {
    const code = issueVerificationCode(handle.db, address);
    return post("/api/public/subscriptions/activate", { email: address, code, cardCode });
  }

  it("sends an admin receipt despite reminder opt-out, with named expiry, and skips idempotent replays", async () => {
    handle.db
      .insert(userMailPreferences)
      .values({
        email: user.email,
        mailType: "membership_reminder",
        enabled: false,
        updatedAt: new Date().toISOString(),
      })
      .run();
    const input = renew();
    const result = await post(`/api/submission-users/${user.id}/renew`, input);
    expect(result).toMatchObject({ emailStatus: "sent", user: { membershipExpiryLabel: input.expiryLabel } });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toBe(user.email);
    expect(send.mock.calls[0]![2]).toContain(input.expiryLabel);
    expect(await post(`/api/submission-users/${user.id}/renew`, input)).toMatchObject({
      repeated: true,
      emailStatus: "unchanged",
    });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("preserves a saved admin renewal on SMTP failure and retries the durable receipt", async () => {
    send.mockRejectedValueOnce(new Error("SMTP unavailable"));
    const input = renew();
    const result = await post(`/api/submission-users/${user.id}/renew`, input);
    expect(result.emailStatus).toBe("pending");
    expect(result.user.subscriptionExpiresAt).toBe("2030-01-31T00:00:00.000Z");
    expect(await post(`/api/submission-users/${user.id}/renew`, input)).toMatchObject({
      repeated: true,
      emailStatus: "unchanged",
    });
    expect(send).toHaveBeenCalledTimes(1);
    handle.db.update(renewalEmailOutbox).set({ nextAttemptAt: "2000-01-01T00:00:00.000Z" }).run();
    await retryRenewalReceipts(handle.db, email);
    expect(send).toHaveBeenCalledTimes(2);
    expect(handle.db.select().from(renewalEmailOutbox).get()?.sentAt).toBeTruthy();
  });

  it("queues card renewal once, preserves expiry after mail failure, then retries without exposing the card code", async () => {
    const card = createCardKeys(handle.db, {
      kind: "custom",
      count: 1,
      expiresAt: "2031-05-01",
      expiryLabel: "假期结束到期",
    })[0]!;
    send.mockRejectedValueOnce(new Error("SMTP unavailable"));
    const result = await redeem(card);
    expect(result).toMatchObject({ emailStatus: "pending", member: { membershipExpiryLabel: "假期结束到期" } });
    const expiry = result.member.subscriptionExpiresAt;
    const queued = handle.db.select().from(renewalEmailOutbox).get()!;
    expect(JSON.stringify(queued)).not.toContain(card);
    expect(queued.text).toContain("卡密续期");
    expect(queued.text).not.toContain("密码");
    expect(await redeem(card)).toMatchObject({
      emailStatus: "unchanged",
      card: { idempotent: true },
      member: { subscriptionExpiresAt: expiry },
    });
    expect(send).toHaveBeenCalledTimes(1);
    handle.db.update(renewalEmailOutbox).set({ nextAttemptAt: "2000-01-01T00:00:00.000Z" }).run();
    await retryRenewalReceipts(handle.db, email);
    expect(send).toHaveBeenCalledTimes(2);
    expect(
      handle.db.select().from(submissionUsers).where(eq(submissionUsers.id, user.id)).get()?.subscriptionExpiresAt,
    ).toBe(expiry);
  });

  it("keeps first-time activation separate from renewal receipt and leaves unconfigured receipts pending", async () => {
    const card = createCardKeys(handle.db, { kind: "month", count: 1 })[0]!;
    const activated = await activateCardForTest(base, handle.db, "100001037@qq.com", card);
    expect(activated.status).toBe(200);
    expect(await activated.json()).not.toHaveProperty("emailStatus");
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[2]).toContain("邮箱验证码");
    expect(handle.db.select().from(renewalEmailOutbox).all()).toHaveLength(0);
    email.configured = false;
    const result = await post(`/api/submission-users/${user.id}/renew`, renew());
    expect(result.emailStatus).toBe("pending");
    expect(handle.db.select().from(renewalEmailOutbox).get()?.attempts).toBe(0);
  });
  it("does not consume a card or change expiry when receipt persistence fails, and accepts a fresh-code retry", async () => {
    const card = createCardKeys(handle.db, { kind: "month", count: 1 })[0]!;
    handle.db.run(
      sql`CREATE TRIGGER fixture_fail_receipt BEFORE INSERT ON renewal_email_outbox BEGIN SELECT RAISE(ABORT,'fixture receipt failure'); END`,
    );
    const failed = await fetch(`${base}/api/public/subscriptions/activate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: user.email, cardCode: card, code: issueVerificationCode(handle.db, user.email) }),
    });
    expect(failed.status).toBe(500);
    expect(handle.db.select().from(cardKeys).where(eq(cardKeys.code, card)).get()?.status).toBe("unused");
    expect(
      handle.db.select().from(submissionUsers).where(eq(submissionUsers.id, user.id)).get()?.subscriptionExpiresAt,
    ).toBe(user.subscriptionExpiresAt);
    expect(handle.db.select().from(renewalEmailOutbox).all()).toHaveLength(0);
    expect(send).not.toHaveBeenCalled();
    handle.db.run(sql`DROP TRIGGER fixture_fail_receipt`);
    const succeeded = await redeem(card);
    expect(succeeded).toMatchObject({
      emailStatus: "sent",
      member: { subscriptionExpiresAt: "2030-01-31T00:00:00.000Z" },
    });
    expect(handle.db.select().from(cardKeys).where(eq(cardKeys.code, card)).get()?.status).toBe("used");
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("also rolls back first-time card consumption if member insertion fails", async () => {
    const card = createCardKeys(handle.db, { kind: "month", count: 1 })[0]!;
    const address = "100001038@qq.com";
    await post("/api/public/subscriptions/code", { email: address, cardCode: card });
    const code = send.mock.calls[0]?.[2].match(/验证码：(\d{6})/)?.[1];
    expect(code).toMatch(/^\d{6}$/);
    const { registrationToken } = await post("/api/public/subscriptions/register/verify", {
      email: address,
      cardCode: card,
      code,
    });
    const activation = { email: address, cardCode: card, registrationToken };
    handle.db.run(
      sql`CREATE TRIGGER fixture_fail_signup BEFORE INSERT ON submission_users BEGIN SELECT RAISE(ABORT,'fixture signup failure'); END`,
    );
    const failed = await postSubscription(base, "activate", activation);
    expect(failed.status).toBe(500);
    expect(handle.db.select().from(cardKeys).where(eq(cardKeys.code, card)).get()?.status).toBe("unused");
    expect(handle.db.select().from(submissionUsers).where(eq(submissionUsers.email, address)).get()).toBeUndefined();
    handle.db.run(sql`DROP TRIGGER fixture_fail_signup`);
    expect(await post("/api/public/subscriptions/activate", activation)).not.toHaveProperty("emailStatus");
    expect(handle.db.select().from(renewalEmailOutbox).all()).toHaveLength(0);
  });
});
