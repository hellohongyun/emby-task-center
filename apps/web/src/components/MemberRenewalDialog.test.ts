import { fireEvent, render, screen, waitFor } from "@testing-library/vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import MemberRenewalDialog from "./MemberRenewalDialog.vue";
import type { SubmissionUser } from "../types";

const member = {
  id: 1,
  email: "member@example.com",
  subscriptionExpiresAt: "2030-01-01T00:00:00.000Z",
} as SubmissionUser;
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("MemberRenewalDialog", () => {
  it("previews days, prevents duplicate submission, and uses a valid request id without secure-context randomUUID", async () => {
    let finish!: (value: Response) => void;
    const mock = vi.fn<typeof fetch>(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    vi.stubGlobal("fetch", mock);
    const { emitted } = render(MemberRenewalDialog, { props: { member, requireAuth: vi.fn() } });
    expect(screen.getByText(/续期后/).textContent).toContain("2030");
    await fireEvent.update(screen.getByLabelText("增加天数", { selector: "input[type=number]" }), "60");
    await fireEvent.update(screen.getByLabelText("续期原因（可选）"), "提意见奖励");
    await fireEvent.update(screen.getByLabelText("到期时间名称（可选）"), "  劳动节假期结束到期  ");
    expect(screen.getByText("劳动节假期结束到期")).toBeInTheDocument();
    expect(screen.getByText(/续期后/).textContent).toContain("2030");
    await fireEvent.click(screen.getByRole("button", { name: "确认续期" }));
    expect(screen.getByRole("button", { name: "正在续期…" })).toBeDisabled();
    const sent = JSON.parse(mock.mock.calls[0]![1]!.body as string);
    expect(sent).toMatchObject({
      mode: "days",
      days: 60,
      reason: "提意见奖励",
      expiryLabel: "劳动节假期结束到期",
      expectedExpiresAt: member.subscriptionExpiresAt,
    });
    expect(sent.requestId).toMatch(/^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/);
    finish(json({ embyStatus: "restore_failed" }));
    await waitFor(() => expect(JSON.stringify(emitted("saved"))).toContain("有效期已保存"));
    expect(mock).toHaveBeenCalledTimes(1);
  });
  it("submits a calendar date, keeps a conflict visible, and leaves the form available", async () => {
    const mock = vi.fn().mockResolvedValue(json({ error: "renewal_date_not_later" }, 409));
    vi.stubGlobal("fetch", mock);
    const { emitted } = render(MemberRenewalDialog, { props: { member, requireAuth: vi.fn() } });
    await fireEvent.click(screen.getByLabelText("续到指定日期"));
    await fireEvent.update(screen.getByLabelText("到期日期"), "2027-05-01");
    expect(screen.getByText(/2027-05-01 当天结束/)).toBeInTheDocument();
    await fireEvent.click(screen.getByRole("button", { name: "确认续期" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("续期不能缩短有效期"));
    expect(JSON.parse(mock.mock.calls[0]![1].body)).toMatchObject({
      mode: "date",
      date: "2027-05-01",
      expiryLabel: null,
    });
    expect(emitted("saved")).toBeUndefined();
  });
  it("suppresses a late response after leaving and cancels the request", async () => {
    let finish!: (value: Response) => void;
    const mock = vi.fn<typeof fetch>(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    vi.stubGlobal("fetch", mock);
    const requireAuth = vi.fn();
    const view = render(MemberRenewalDialog, { props: { member, requireAuth } });
    await fireEvent.click(screen.getByRole("button", { name: "确认续期" }));
    view.unmount();
    expect(mock.mock.calls[0]![1]!.signal!.aborted).toBe(true);
    finish(json({}, 401));
    await Promise.resolve();
    expect(requireAuth).not.toHaveBeenCalled();
    expect(view.emitted("saved")).toBeUndefined();
  });
  it("ends the wait on a stalled response body without retrying the write", async () => {
    vi.useFakeTimers();
    const mock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => new Promise(() => {}) });
    vi.stubGlobal("fetch", mock);
    render(MemberRenewalDialog, { props: { member, requireAuth: vi.fn() } });
    await fireEvent.click(screen.getByRole("button", { name: "确认续期" }));
    await vi.advanceTimersByTimeAsync(90001);
    expect(screen.getByRole("alert")).toHaveTextContent("续期结果未确认");
    expect(mock).toHaveBeenCalledTimes(1);
  });
  it("shows a fixed expiry label alongside its real date and clears the label when left blank", async () => {
    const mock = vi.fn<typeof fetch>(async () => json({ emailStatus: "sent" }));
    vi.stubGlobal("fetch", mock);
    const view = render(MemberRenewalDialog, { props: { member, requireAuth: vi.fn() } });
    await fireEvent.click(screen.getByLabelText("续到指定日期"));
    await fireEvent.update(screen.getByLabelText("到期日期"), "2031-05-01");
    const name = screen.getByLabelText("到期时间名称（可选）");
    expect(name).toHaveAttribute("maxlength", "60");
    await fireEvent.update(name, "劳动节到期");
    expect(screen.getByText("劳动节到期")).toBeInTheDocument();
    expect(screen.getByText(/2031-05-01 当天结束/)).toBeInTheDocument();
    await fireEvent.update(name, "   ");
    expect(screen.queryByText("劳动节到期")).not.toBeInTheDocument();
    await fireEvent.click(screen.getByRole("button", { name: "确认续期" }));
    await waitFor(() => expect(view.emitted("saved")).toHaveLength(1));
    expect(JSON.parse(mock.mock.calls[0]![1]!.body as string)).toMatchObject({
      mode: "date",
      date: "2031-05-01",
      expiryLabel: null,
    });
  });
  it.each([
    ["sent", "续期通知邮件已发送"],
    ["failed", "通知邮件发送失败"],
    ["not_configured", "邮件服务尚未配置"],
    ["unchanged", "本次重复请求未重复发送"],
  ])("reports %s notification status without repeating the renewal", async (emailStatus, text) => {
    const mock = vi.fn<typeof fetch>(async () => json({ emailStatus }));
    vi.stubGlobal("fetch", mock);
    const view = render(MemberRenewalDialog, { props: { member, requireAuth: vi.fn() } });
    await fireEvent.click(screen.getByRole("button", { name: "确认续期" }));
    await waitFor(() => expect(JSON.stringify(view.emitted("saved"))).toContain(text));
    expect(JSON.stringify(view.emitted("saved"))).toContain("已续期");
    expect(mock).toHaveBeenCalledTimes(1);
  });
  it("reports queued mail as pending with automatic retry instead of claiming delivery", async () => {
    const mock = vi.fn<typeof fetch>(async () => json({ emailStatus: "pending" }));
    vi.stubGlobal("fetch", mock);
    const view = render(MemberRenewalDialog, { props: { member, requireAuth: vi.fn() } });
    await fireEvent.click(screen.getByRole("button", { name: "确认续期" }));
    await waitFor(() => expect(view.emitted("saved")).toHaveLength(1));
    const receipt = JSON.stringify(view.emitted("saved"));
    expect(receipt).toContain("续期已保存");
    expect(receipt).toContain("通知邮件待发送，系统将自动补发");
    expect(receipt).toContain("无需重复续期");
    expect(receipt).not.toContain("邮件已发送");
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it("previews the capped expiry and sends the original deferred balance to guard concurrent renewals", async () => {
    const day = 86_400_000;
    const driveExpiry = { date: "2030-01-20", expiresAt: "2030-01-20T23:59:59.999Z" };
    const mock = vi.fn<typeof fetch>(async () =>
      json({
        user: { subscriptionExpiresAt: driveExpiry.expiresAt, deferredMembershipMs: 12 * day + 1 },
        emailStatus: "sent",
        embyStatus: "restricted",
      }),
    );
    vi.stubGlobal("fetch", mock);
    const view = render(MemberRenewalDialog, {
      props: { member: { ...member, deferredMembershipMs: 2 * day }, requireAuth: vi.fn(), driveExpiry },
    });
    expect(screen.getByText("续期后：").textContent).toContain("2030-01-20 当天结束");
    expect(screen.getByText(/预计待激活 12 天/)).toBeInTheDocument();
    await fireEvent.update(screen.getByLabelText("到期时间名称（可选）"), "劳动节到期");
    expect(screen.queryByText("劳动节到期")).not.toBeInTheDocument();
    await fireEvent.click(screen.getByRole("button", { name: "确认续期" }));
    await waitFor(() => expect(JSON.stringify(view.emitted("saved"))).toContain("待激活 12 天"));
    expect(JSON.stringify(view.emitted("saved"))).toContain("账号仍受当前有效期");
    expect(JSON.parse(mock.mock.calls[0]![1]!.body as string)).toMatchObject({
      days: 30,
      expectedDeferredMembershipMs: 2 * day,
      expiryLabel: "劳动节到期",
    });
  });
  it("keeps the server calendar date and refuses to reuse a stale cap preview", async () => {
    const driveExpiry = { date: "2030-01-20", expiresAt: "2030-01-20T15:59:59.999Z" };
    const mock = vi.fn<typeof fetch>(async () => json({ error: "renewal_drive_expiry_changed" }, 409));
    vi.stubGlobal("fetch", mock);
    const props = { member, requireAuth: vi.fn(), requireDriveExpiry: true, driveExpiry };
    const view = render(MemberRenewalDialog, { props });
    await fireEvent.click(screen.getByLabelText("续到指定日期"));
    const date = screen.getByLabelText("到期日期");
    await fireEvent.update(date, "2030-02-20");
    await view.rerender({ ...props, driveExpiry: { date: "2030-02-01", expiresAt: "2030-02-01T15:59:59.999Z" } });
    expect(screen.getByText("续期后：").textContent).toContain("2030-01-20 当天结束（服务器时区）");
    const submit = screen.getByRole("button", { name: "确认续期" });
    await fireEvent.click(submit);
    expect(await screen.findByRole("alert")).toHaveTextContent("网盘到期日已变更");
    expect(date).toHaveValue("2030-02-20");
    expect(submit).toBeDisabled();
    expect(JSON.parse(mock.mock.calls[0]![1]!.body as string)).toMatchObject({
      mode: "date",
      date: "2030-02-20",
      expectedDriveExpiryDate: "2030-01-20",
    });
  });

  it("waits for a successfully read cap when the member page requires a trustworthy preview", () => {
    const mock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", mock);
    render(MemberRenewalDialog, { props: { member, requireAuth: vi.fn(), requireDriveExpiry: true } });
    expect(screen.getByRole("alert")).toHaveTextContent("重新读取设置后再续期");
    expect(screen.queryByRole("button", { name: "确认续期" })).not.toBeInTheDocument();
    expect(mock).not.toHaveBeenCalled();
  });
});
