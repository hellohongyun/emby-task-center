import { describe, expect, it, vi } from "vitest";
import nodemailer from "nodemailer";

import { createEmailNotifier, type EmailOptions } from "./email-service";

vi.mock("nodemailer", () => ({
  default: { createTransport: vi.fn() },
}));

/**
 * 任务更新邮件（sendTaskUpdate、它的 HTML 模板、以及任务/全局收件人的读取）
 * 随「任务更新通知」整条链删除（2026-09）：追更下线后那个发送方再无调用方。
 * 这里只守住仍在使用的两条链：测试邮件（sendTest）与"保存 SMTP 设置无需重启"（resolve）。
 */
describe("email notifier", () => {
  it("sends a readable Chinese test email through the configured sender", async () => {
    const sendMail = vi.fn().mockResolvedValue({ messageId: "test" });
    vi.mocked(nodemailer.createTransport).mockReturnValue({ sendMail } as never);
    const notifier = createEmailNotifier({
      host: "smtp.qq.com",
      port: 465,
      secure: true,
      user: "sender@example.com",
      password: "secret",
      fromName: "天鸿影院",
      fromAddress: "sender@example.com",
    });

    await notifier.sendTest("recipient@example.com");

    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        from: '"天鸿影院" <sender@example.com>',
        to: "recipient@example.com",
        subject: "[媒体任务中心] 邮件服务测试",
        text: expect.stringContaining("邮件服务配置正常"),
        html: expect.stringContaining("邮件服务配置正常"),
      }),
    );
  });

  it("treats a relay that needs no auth as configured (主机+端口+发件人地址即可)", async () => {
    const sendMail = vi.fn().mockResolvedValue({ messageId: "test" });
    const createTransport = vi.mocked(nodemailer.createTransport);
    createTransport.mockReturnValue({ sendMail } as never);
    createTransport.mockClear();
    const notifier = createEmailNotifier({ host: "relay.lan", port: 25, fromAddress: "ops@example.com" });

    expect(notifier.configured).toBe(true);
    expect(notifier.missingFields?.()).toEqual([]);

    await notifier.sendTest("recipient@example.com");

    expect(sendMail).toHaveBeenCalledTimes(1);
    const transportOptions = createTransport.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    expect(transportOptions?.host).toBe("relay.lan");
    // 没有用户名/口令就不该塞 auth，否则中继服务器会当成"认证失败"。
    expect(transportOptions?.auth).toBeUndefined();
  });

  it("follows the live resolver, so saving SMTP settings applies without a restart", async () => {
    const sendMail = vi.fn().mockResolvedValue({ messageId: "test" });
    vi.mocked(nodemailer.createTransport).mockReturnValue({ sendMail } as never);
    // 模拟运行时快照：后台保存设置后这里的内容会变。
    let live: EmailOptions = { host: "", port: 587, fromAddress: "" };
    const notifier = createEmailNotifier({ resolve: () => live });

    expect(notifier.configured).toBe(false);
    expect(notifier.missingFields?.()).toEqual(["email.host", "email.fromAddress"]);

    // 保存 SMTP（同一个进程、不重启）
    live = { host: "smtp.example.com", port: 465, secure: true, fromAddress: "ops@example.com" };

    expect(notifier.configured).toBe(true);
    expect(notifier.missingFields?.()).toEqual([]);
    await notifier.sendTest("recipient@example.com");
    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({ from: '"天鸿影院" <ops@example.com>' }));
  });
});
