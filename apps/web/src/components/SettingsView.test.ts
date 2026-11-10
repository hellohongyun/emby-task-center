import { fireEvent, render, screen, waitFor } from "@testing-library/vue";
import { describe, expect, it, vi } from "vitest";
import SettingsView from "./SettingsView.vue";

const previewProps = { previewEmail: vi.fn(), cancelEmailPreview: vi.fn() };

// 「全局通知收件人」（添加/删除全局收件邮箱）随「任务更新通知」整条链删除（2026-09），
// 对应用例一并移除；这里守住连接状态与"未配置时说清还缺什么"。
describe("SettingsView", () => {
  it("disables an in-flight test and preserves the submitted email in its result", async () => {
    let resolve!: (value: unknown) => void;
    const testEmail = vi.fn(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    render(SettingsView, {
      props: {
        status: { embyConfigured: true, emailConfigured: true },
        loading: false,
        testEmby: vi.fn(),
        testEmail,
        ...previewProps,
      },
    });
    const input = screen.getByPlaceholderText("测试收件邮箱");
    await fireEvent.update(input, "first@example.com");
    await fireEvent.click(screen.getByRole("button", { name: "发送测试" }));
    expect(screen.getByRole("button", { name: "发送中…" })).toBeDisabled();
    await fireEvent.update(input, "second@example.com");
    resolve({ ok: true });
    await waitFor(() => expect(screen.getByText("测试邮件已发送到 first@example.com")).toBeInTheDocument());
    expect(testEmail).toHaveBeenCalledTimes(1);
    expect(testEmail).toHaveBeenCalledWith("first@example.com", "test");
  });

  it("keeps the latest test message when an earlier Emby test finishes afterwards", async () => {
    let resolve!: (value: { serverName: string; version: string }) => void;
    const testEmby = vi.fn(
      () =>
        new Promise<{ serverName: string; version: string }>((done) => {
          resolve = done;
        }),
    );
    render(SettingsView, {
      props: {
        status: { embyConfigured: true, emailConfigured: true },
        loading: false,
        testEmby,
        testEmail: vi.fn().mockResolvedValue({ ok: true }),
        ...previewProps,
      },
    });
    await fireEvent.click(screen.getByRole("button", { name: "测试连接" }));
    await fireEvent.update(screen.getByPlaceholderText("测试收件邮箱"), "member@example.com");
    await fireEvent.click(screen.getByRole("button", { name: "发送测试" }));
    await waitFor(() => expect(screen.getByText("测试邮件已发送到 member@example.com")).toBeInTheDocument());
    resolve({ serverName: "old", version: "1" });
    await waitFor(() => expect(screen.getByRole("button", { name: "测试连接" })).toBeEnabled());
    expect(screen.queryByText("Emby 连接成功：old 1")).not.toBeInTheDocument();
  });
  it("lists the SMTP settings that are still missing instead of a bare 未配置", () => {
    render(SettingsView, {
      props: {
        status: { embyConfigured: false, emailConfigured: false, emailMissing: ["SMTP 服务器", "发件人地址"] },
        loading: false,
        testEmby: vi.fn(),
        testEmail: vi.fn(),
        ...previewProps,
      },
    });
    expect(screen.getByText("还缺：SMTP 服务器、发件人地址")).toBeInTheDocument();
  });

  it("shows Emby and email configuration status", () => {
    render(SettingsView, {
      props: {
        status: { embyConfigured: true, emailConfigured: false },
        loading: false,
        testEmby: vi.fn(),
        testEmail: vi.fn(),
        ...previewProps,
      },
    });
    expect(screen.getByText("Emby API")).toBeInTheDocument();
    expect(screen.getByText("已配置")).toBeTruthy();
    expect(screen.getAllByText("未配置").length).toBeGreaterThan(0);
  });

  it("previews and sends a test for the selected template", async () => {
    const previewEmail = vi.fn().mockResolvedValue({
      subject: "[开心果影院] 示例验证码",
      text: "示例验证码为 123456",
      html: "<!doctype html><html><head></head><body>示例验证码</body></html>",
    });
    const testEmail = vi.fn().mockResolvedValue({ ok: true });
    render(SettingsView, {
      props: {
        status: { embyConfigured: true, emailConfigured: true },
        loading: false,
        testEmby: vi.fn(),
        testEmail,
        previewEmail,
        cancelEmailPreview: vi.fn(),
      },
    });

    expect(previewEmail).not.toHaveBeenCalled();
    await fireEvent.update(screen.getByRole("combobox", { name: "邮件类型" }), "login");
    await fireEvent.click(screen.getByRole("button", { name: "预览邮件" }));
    expect(await screen.findByText("[开心果影院] 示例验证码")).toBeVisible();
    const frame = screen.getByTitle("邮件 HTML 预览");
    expect(frame).toHaveAttribute("sandbox", "");
    expect(frame.getAttribute("srcdoc")).toContain("Content-Security-Policy");
    expect(frame.getAttribute("srcdoc")).toContain("<body>示例验证码</body>");
    expect(screen.getByText("示例验证码为 123456")).toBeInTheDocument();
    expect(previewEmail).toHaveBeenCalledWith("login");

    await fireEvent.update(screen.getByRole("textbox", { name: "测试收件邮箱" }), "member@example.com");
    await fireEvent.click(screen.getByRole("button", { name: "发送测试" }));
    expect(await screen.findByText("「登录验证码」测试邮件已发送到 member@example.com")).toBeVisible();
    expect(testEmail).toHaveBeenCalledWith("member@example.com", "login");
  });

  it("clears a pending preview on template change and previews while SMTP is unconfigured", async () => {
    let resolve!: (value: { subject: string; text: string; html: string }) => void;
    const old = new Promise((done) => {
      resolve = done;
    });
    const previewEmail = vi
      .fn()
      .mockReturnValueOnce(old)
      .mockResolvedValueOnce({ subject: "续期示例", text: "续期正文", html: "<p>续期正文</p>" });
    const cancelEmailPreview = vi.fn();
    render(SettingsView, {
      props: {
        status: { embyConfigured: true, emailConfigured: false },
        loading: false,
        testEmby: vi.fn(),
        testEmail: vi.fn(),
        previewEmail,
        cancelEmailPreview,
      },
    });

    expect(screen.getByRole("button", { name: "发送测试" })).toBeDisabled();
    await fireEvent.click(screen.getByRole("button", { name: "预览邮件" }));
    expect(screen.getByRole("button", { name: "预览加载中…" })).toBeDisabled();
    await fireEvent.update(screen.getByRole("combobox", { name: "邮件类型" }), "renewal");
    expect(cancelEmailPreview).toHaveBeenCalledOnce();
    await fireEvent.click(screen.getByRole("button", { name: "预览邮件" }));
    expect(await screen.findByText("续期示例")).toBeVisible();
    resolve({ subject: "旧预览", text: "", html: "" });
    await old;
    expect(screen.getByText("续期示例")).toBeVisible();
    expect(screen.queryByText("旧预览")).not.toBeInTheDocument();
  });
});
