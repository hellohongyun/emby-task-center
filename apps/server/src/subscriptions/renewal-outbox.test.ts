import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createDatabase, type DatabaseHandle } from "@emby-task-center/database/client";
import { renewalEmailOutbox, submissionUsers } from "@emby-task-center/database/schema";
import type { EmailNotifier } from "../notifications/email-service";
import { deliverRenewalReceipt, enqueueRenewalReceipt, retryRenewalReceipts } from "./renewal-outbox";
import { renewMember, renewalSchema } from "./admin-renewal";

describe("durable renewal notification outbox", () => {
  let directory: string;
  let handle: DatabaseHandle;
  const send = vi.fn<EmailNotifier["sendNotification"]>();
  let email: EmailNotifier;
  const receipt = {
    email: "member@example.invalid",
    method: "管理员续期：增加30天",
    previousExpiresAt: "2026-01-01T00:00:00.000Z",
    subscriptionExpiresAt: "2030-01-01T00:00:00.000Z",
    expiryLabel: "假期结束到期",
  };
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "renewal-outbox-"));
    handle = createDatabase(join(directory, "test.db"));
    send.mockReset().mockResolvedValue();
    email = { configured: true, sendNotification: send } as unknown as EmailNotifier;
  });
  afterEach(() => {
    vi.useRealTimers();
    handle.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const row = () => handle.db.select().from(renewalEmailOutbox).get()!;
  const makeDue = () => handle.db.update(renewalEmailOutbox).set({ nextAttemptAt: "2000-01-01T00:00:00.000Z" }).run();

  it("persists a failed delivery, retries from a reopened database and never normally sends the same receipt twice", async () => {
    enqueueRenewalReceipt(handle.db, "admin:1:test", receipt);
    enqueueRenewalReceipt(handle.db, "admin:1:test", { ...receipt, expiryLabel: "do not overwrite" });
    send.mockRejectedValueOnce(new Error("do not persist SMTP credentials"));
    expect(await deliverRenewalReceipt(handle.db, email, "admin:1:test")).toBe("pending");
    expect(row()).toMatchObject({ attempts: 1, sentAt: null, leaseToken: null, lastError: "delivery_failed" });
    expect(Date.parse(row().nextAttemptAt)).toBeGreaterThan(Date.now() + 299_000);
    expect(row().text).toContain("假期结束到期");
    handle.close();
    handle = createDatabase(join(directory, "test.db"));
    await retryRenewalReceipts(handle.db, email);
    expect(send).toHaveBeenCalledTimes(1);
    makeDue();
    await retryRenewalReceipts(handle.db, email);
    expect(send).toHaveBeenCalledTimes(2);
    expect(row().sentAt).toBeTruthy();
    await retryRenewalReceipts(handle.db, email);
    expect(await deliverRenewalReceipt(handle.db, email, "admin:1:test")).toBe("sent");
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("keeps unconfigured mail pending and recovers when SMTP becomes available", async () => {
    enqueueRenewalReceipt(handle.db, "card:1", receipt);
    email.configured = false;
    expect(await deliverRenewalReceipt(handle.db, email, "card:1")).toBe("pending");
    await retryRenewalReceipts(handle.db, email);
    expect(row().attempts).toBe(0);
    expect(send).not.toHaveBeenCalled();
    email.configured = true;
    await retryRenewalReceipts(handle.db, email);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("renders a queued receipt created by the old version with the current brand", async () => {
    enqueueRenewalReceipt(handle.db, "card:legacy", receipt);
    handle.db.update(renewalEmailOutbox).set({ text: "历史续期内容\n\n—— 天鸿影院", html: "<p>天鸿影院</p>" }).run();
    expect(await deliverRenewalReceipt(handle.db, email, "card:legacy")).toBe("sent");
    const [, , text, html] = send.mock.calls[0]!;
    expect(text).toBe("历史续期内容");
    expect(html).toContain("开心果影院");
    expect(html).toContain("历史续期内容");
    expect(html).not.toContain("天鸿影院");
    expect(row().text).toContain("天鸿影院");
  });

  it("merges retry rounds and holds a lease across independent database connections", async () => {
    enqueueRenewalReceipt(handle.db, "card:2", receipt);
    let finish!: () => void;
    send.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const other = createDatabase(join(directory, "test.db"));
    try {
      const first = retryRenewalReceipts(handle.db, email);
      expect(retryRenewalReceipts(handle.db, email)).toBe(first);
      expect(await deliverRenewalReceipt(other.db, email, "card:2")).toBe("pending");
      expect(send).toHaveBeenCalledTimes(1);
      finish();
      await first;
      expect(row().sentAt).toBeTruthy();
    } finally {
      other.close();
    }
  });

  it("refreshes ownership while an actual slow send is live instead of retrying a raced request", async () => {
    vi.useFakeTimers();
    enqueueRenewalReceipt(handle.db, "card:3", receipt);
    let finish!: () => void;
    send.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const active = deliverRenewalReceipt(handle.db, email, "card:3");
    await vi.advanceTimersByTimeAsync(150_000);
    expect(Date.parse(row().leaseUntil!)).toBeGreaterThan(Date.now());
    expect(await deliverRenewalReceipt(handle.db, email, "card:3")).toBe("pending");
    expect(send).toHaveBeenCalledTimes(1);
    finish();
    await active;
    expect(row().sentAt).toBeTruthy();
  });

  it("reclaims an abandoned lease after a process interruption", async () => {
    enqueueRenewalReceipt(handle.db, "card:4", receipt);
    handle.db.update(renewalEmailOutbox).set({ leaseToken: "abandoned", leaseUntil: "2000-01-01T00:00:00.000Z" }).run();
    expect(await deliverRenewalReceipt(handle.db, email, "card:4")).toBe("sent");
    expect(row().leaseToken).toBeNull();
  });

  it("rolls back expiry and audit if the transaction cannot persist its receipt", () => {
    const timestamp = new Date().toISOString();
    const user = handle.db
      .insert(submissionUsers)
      .values({
        email: receipt.email,
        subscriptionExpiresAt: "2030-01-01T00:00:00.000Z",
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .returning()
      .get();
    const request = renewalSchema.parse({
      mode: "days",
      days: 30,
      requestId: "00000000-0000-4000-8000-000000000001",
      expectedExpiresAt: user.subscriptionExpiresAt,
    });
    // Exercise the transactional boundary using a fixture database trigger.
    handle.db.run(
      sql`CREATE TRIGGER fixture_fail_outbox BEFORE INSERT ON renewal_email_outbox BEGIN SELECT RAISE(ABORT,'fixture write failure'); END`,
    );
    expect(() => renewMember(handle.db, user.id, request)).toThrow();
    expect(
      handle.db.select().from(submissionUsers).where(eq(submissionUsers.id, user.id)).get()?.subscriptionExpiresAt,
    ).toBe(user.subscriptionExpiresAt);
  });
  it("returns pending on claim failure and on SMTP success whose durable sent marker cannot be saved", async () => {
    enqueueRenewalReceipt(handle.db, "card:fault", receipt);
    handle.db.run(
      sql`CREATE TRIGGER fixture_fail_claim BEFORE UPDATE ON renewal_email_outbox BEGIN SELECT RAISE(ABORT,'fixture claim failure'); END`,
    );
    expect(await deliverRenewalReceipt(handle.db, email, "card:fault")).toBe("pending");
    expect(send).not.toHaveBeenCalled();
    handle.db.run(sql`DROP TRIGGER fixture_fail_claim`);
    handle.db.run(
      sql`CREATE TRIGGER fixture_fail_mark BEFORE UPDATE ON renewal_email_outbox WHEN NEW.sent_at IS NOT NULL BEGIN SELECT RAISE(ABORT,'fixture marker failure'); END`,
    );
    expect(await deliverRenewalReceipt(handle.db, email, "card:fault")).toBe("pending");
    expect(send).toHaveBeenCalledTimes(1);
    expect(row().sentAt).toBeNull();
    expect(row().leaseToken).toBeTruthy();
  });
  it("does not report sent if another owner replaced the lease before completion", async () => {
    enqueueRenewalReceipt(handle.db, "card:ownership", receipt);
    send.mockImplementation(async () => {
      handle.db.update(renewalEmailOutbox).set({ leaseToken: "other-owner" }).run();
    });
    expect(await deliverRenewalReceipt(handle.db, email, "card:ownership")).toBe("pending");
    expect(row().sentAt).toBeNull();
  });
});
