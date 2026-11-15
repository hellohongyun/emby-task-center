import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import nodemailer from "nodemailer";
import { createEmailNotifier } from "./email-service";
import { isEmailDeliveryDisabled } from "./email-delivery-policy";

vi.mock("nodemailer", () => ({ default: { createTransport: vi.fn() } }));
const smtp = { host: "smtp.example.invalid", port: 465, fromAddress: "sender@example.invalid" };
beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllEnvs());

describe("environment email delivery guard", () => {
  it.each([undefined, "development", "preview", "staging"])("disables unapproved runtime %s", (mode) => {
    expect(isEmailDeliveryDisabled({ NODE_ENV: mode })).toBe(true);
    expect(isEmailDeliveryDisabled({ NODE_ENV: mode, EMAIL_DELIVERY_DISABLED: "false" })).toBe(true);
  });
  it.each(["production", "test"])("requires no disable flag in %s", (mode) => {
    expect(isEmailDeliveryDisabled({ NODE_ENV: mode })).toBe(false);
    expect(isEmailDeliveryDisabled({ NODE_ENV: mode, EMAIL_DELIVERY_DISABLED: "true" })).toBe(true);
  });
  it("blocks every path without reading SMTP or constructing a transport", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("EMAIL_DELIVERY_DISABLED", "true");
    const resolve = vi.fn(() => smtp);
    const notifier = createEmailNotifier({ resolve });
    expect(notifier.deliveryDisabled).toBe(true);
    expect(notifier.configured).toBe(false);
    expect(notifier.missingFields?.()).toEqual([]);
    await expect(notifier.sendTest("recipient@example.invalid")).rejects.toThrow("email_delivery_disabled");
    await expect(notifier.sendNotification("recipient@example.invalid", "subject", "text")).rejects.toThrow(
      "email_delivery_disabled",
    );
    // No database access is allowed during disabled retries either.
    await expect(
      notifier.retryPending(
        new Proxy({} as never, {
          get() {
            throw new Error("database accessed");
          },
        }),
      ),
    ).resolves.toBeUndefined();
    expect(resolve).not.toHaveBeenCalled();
    expect(nodemailer.createTransport).not.toHaveBeenCalled();
  });
  it("checks the guard again even after a transport has been cached", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("EMAIL_DELIVERY_DISABLED", "false");
    const sendMail = vi.fn().mockResolvedValue({});
    vi.mocked(nodemailer.createTransport).mockReturnValue({ sendMail } as never);
    const resolve = vi.fn(() => smtp);
    const notifier = createEmailNotifier({ resolve });
    await notifier.sendTest("recipient@example.invalid");
    expect(sendMail).toHaveBeenCalledTimes(1);
    vi.stubEnv("EMAIL_DELIVERY_DISABLED", "true");
    resolve.mockClear();
    expect(notifier.configured).toBe(false);
    await expect(notifier.sendNotification("recipient@example.invalid", "subject", "text")).rejects.toThrow(
      "email_delivery_disabled",
    );
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(resolve).not.toHaveBeenCalled();
  });
  it("applies a live development-mode toggle in production without resolving SMTP while disabled", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("EMAIL_DELIVERY_DISABLED", "false");
    let development = true;
    const sendMail = vi.fn().mockResolvedValue({});
    vi.mocked(nodemailer.createTransport).mockReturnValue({ sendMail } as never);
    const resolve = vi.fn(() => smtp);
    const notifier = createEmailNotifier({ resolve, isDeliveryDisabled: () => development });
    expect(notifier.deliveryDisabled).toBe(true);
    expect(notifier.configured).toBe(false);
    await expect(notifier.sendTest("recipient@example.invalid")).rejects.toThrow("email_delivery_disabled");
    expect(resolve).not.toHaveBeenCalled();
    expect(nodemailer.createTransport).not.toHaveBeenCalled();
    development = false;
    expect(notifier.configured).toBe(true);
    await notifier.sendTest("recipient@example.invalid");
    expect(sendMail).toHaveBeenCalledTimes(1);
    development = true;
    resolve.mockClear();
    expect(notifier.configured).toBe(false);
    await expect(notifier.sendNotification("recipient@example.invalid", "subject", "text")).rejects.toThrow(
      "email_delivery_disabled",
    );
    expect(resolve).not.toHaveBeenCalled();
    expect(sendMail).toHaveBeenCalledTimes(1);
  });
});
