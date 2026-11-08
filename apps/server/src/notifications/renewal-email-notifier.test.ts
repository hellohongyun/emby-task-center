import nodemailer from "nodemailer";
import { describe, expect, it, vi } from "vitest";
import { createDatabase } from "@emby-task-center/database/client";
import { createEmailNotifier } from "./email-service";
import { enqueueRenewalReceipt } from "../subscriptions/renewal-outbox";

vi.mock("nodemailer", () => ({ default: { createTransport: vi.fn() } }));
describe("existing notifier renewal retry integration", () => {
  it("uses the existing SMTP sender for pending receipts and sets finite protocol timeouts", async () => {
    const database = createDatabase(":memory:");
    try {
      const sendMail = vi.fn().mockResolvedValue({ messageId: "fixture" });
      vi.mocked(nodemailer.createTransport).mockReturnValue({ sendMail } as never);
      const notifier = createEmailNotifier({
        host: "fixture.invalid",
        port: 25,
        fromAddress: "sender@example.invalid",
      });
      enqueueRenewalReceipt(database.db, "card:fixture", {
        email: "recipient@example.invalid",
        method: "卡密续期",
        previousExpiresAt: null,
        subscriptionExpiresAt: "2030-01-01T00:00:00.000Z",
      });
      await notifier.retryPending(database.db);
      await notifier.retryPending(database.db);
      expect(sendMail).toHaveBeenCalledTimes(1);
      expect(sendMail).toHaveBeenCalledWith(
        expect.objectContaining({ to: "recipient@example.invalid", subject: expect.stringContaining("会员续期") }),
      );
      expect(vi.mocked(nodemailer.createTransport).mock.calls[0]![0]).toMatchObject({
        connectionTimeout: 15_000,
        greetingTimeout: 15_000,
        socketTimeout: 30_000,
      });
    } finally {
      database.close();
    }
  });
});
