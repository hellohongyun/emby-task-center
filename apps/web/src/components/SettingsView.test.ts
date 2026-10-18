import { fireEvent, render, screen, waitFor } from "@testing-library/vue";
import { describe, expect, it, vi } from "vitest";
import SettingsView from "./SettingsView.vue";

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
      props: { status: { embyConfigured: true, emailConfigured: true }, loading: false, testEmby: vi.fn(), testEmail },
    });
    const input = screen.getByPlaceholderText("测试收件邮箱");
    await fireEvent.update(input, "first@example.com");
    await fireEvent.click(screen.getByRole("button", { name: "发送测试" }));
    expect(screen.getByRole("button", { name: "发送中…" })).toBeDisabled();
    await fireEvent.update(input, "second@example.com");
    resolve({ ok: true });
    await waitFor(() => expect(screen.getByText("测试邮件已发送到 first@example.com")).toBeInTheDocument());
    expect(testEmail).toHaveBeenCalledTimes(1);
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
      },
    });
    expect(screen.getByText("Emby API")).toBeInTheDocument();
    expect(screen.getByText("已配置")).toBeTruthy();
    expect(screen.getAllByText("未配置").length).toBeGreaterThan(0);
  });
});
