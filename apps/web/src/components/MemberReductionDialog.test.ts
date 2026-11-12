import { fireEvent, render, screen, waitFor } from "@testing-library/vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import MemberReductionDialog from "./MemberReductionDialog.vue";
import type { SubmissionUser } from "../types";

const day = 86_400_000;
const member = {
  id: 1,
  email: "member@example.com",
  subscriptionExpiresAt: "2030-01-10T00:00:00.000Z",
  deferredMembershipMs: 3 * day,
} as SubmissionUser;
const props = { member, requireAuth: vi.fn(), driveExpiry: null };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("MemberReductionDialog", () => {
  it("previews deferred-first deduction and submits one guarded request while busy", async () => {
    let finish!: (response: Response) => void;
    const request = vi.fn<typeof fetch>(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    vi.stubGlobal("fetch", request);
    const view = render(MemberReductionDialog, { props });
    const before = screen.getByText(/扣减后到期时间：/).textContent;
    expect(screen.getByText("扣减后待激活时长：2 天")).toBeInTheDocument();
    await fireEvent.update(screen.getByLabelText("减少天数"), "3");
    expect(screen.getByText(/扣减后到期时间：/).textContent).toBe(before);
    expect(screen.getByText("扣减后待激活时长：0 天")).toBeInTheDocument();
    await fireEvent.update(screen.getByLabelText("减少天数"), "5");
    expect(screen.getByText(/扣减后到期时间：/).textContent).toContain(
      new Date("2030-01-08T00:00:00.000Z").toLocaleString(),
    );
    await fireEvent.update(screen.getByLabelText("扣减原因（可选）"), "调整赠送天数");
    await fireEvent.click(screen.getByRole("button", { name: "确认减少天数" }));
    expect(screen.getByRole("button", { name: "正在扣减…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "取消" })).toBeDisabled();
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]?.[0]).toBe("/api/submission-users/1/reduce-days");
    const input = JSON.parse(request.mock.calls[0]![1]!.body as string);
    expect(input).toMatchObject({
      days: 5,
      reason: "调整赠送天数",
      expectedExpiresAt: member.subscriptionExpiresAt,
      expectedDeferredMembershipMs: 3 * day,
      expectedDriveExpiryDate: null,
    });
    expect(input.requestId).toMatch(/^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/);
    finish(json({ emailStatus: "sent", embyStatus: "synced" }));
    await waitFor(() => expect(JSON.stringify(view.emitted("saved"))).toContain("扣减通知邮件已发送"));
  });

  it("warns when subtraction causes expiry, including the existing cleanup rule", async () => {
    render(MemberReductionDialog, { props });
    await fireEvent.update(screen.getByLabelText("减少天数"), "36500");
    expect(screen.getByRole("alert")).toHaveTextContent("扣减后已过期");
    expect(screen.getByRole("alert")).toHaveTextContent("停用 Emby");
    expect(screen.getByRole("alert")).toHaveTextContent("过期自动清理");
    expect(screen.getByRole("button", { name: "确认减少天数" })).toBeEnabled();
    await fireEvent.update(screen.getByLabelText("减少天数"), "0");
    expect(screen.getByRole("button", { name: "确认减少天数" })).toBeDisabled();
  });

  it.each(["reduction_expiry_changed", "reduction_drive_expiry_changed", "reduction_cleanup_pending"])(
    "locks an obsolete preview on %s",
    async (error) => {
      const request = vi.fn<typeof fetch>(async () => json({ error }, 409));
      vi.stubGlobal("fetch", request);
      render(MemberReductionDialog, { props });
      await fireEvent.click(screen.getByRole("button", { name: "确认减少天数" }));
      expect(await screen.findByRole("alert")).toHaveTextContent(/变更|清理/);
      expect(screen.getByRole("button", { name: "确认减少天数" })).toBeDisabled();
      expect(request).toHaveBeenCalledTimes(1);
    },
  );

  it("reports pending email and an unconfirmed Emby sync without claiming rollback", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => json({ emailStatus: "pending", embyStatus: "sync_failed" })),
    );
    const view = render(MemberReductionDialog, { props });
    await fireEvent.click(screen.getByRole("button", { name: "确认减少天数" }));
    await waitFor(() => expect(view.emitted("saved")).toHaveLength(1));
    const message = JSON.stringify(view.emitted("saved"));
    expect(message).toContain("已减少");
    expect(message).toContain("状态同步未确认");
    expect(message).toContain("通知邮件待发送，系统将自动补发");
    expect(message).not.toContain("邮件已发送");
  });

  it("requires a known drive cap and prevents unlimited membership deduction", () => {
    const request = vi.fn();
    vi.stubGlobal("fetch", request);
    const view = render(MemberReductionDialog, { props: { member, requireAuth: vi.fn() } });
    expect(screen.getByRole("alert")).toHaveTextContent("无法核对网盘");
    expect(screen.queryByRole("button", { name: "确认减少天数" })).toBeNull();
    view.unmount();
    render(MemberReductionDialog, { props: { ...props, member: { ...member, followsDriveExpiry: true } } });
    expect(screen.getByRole("alert")).toHaveTextContent("不支持减少天数");
    expect(request).not.toHaveBeenCalled();
  });

  it("preserves the preview snapshot if the cap prop changes before submission", async () => {
    const request = vi.fn<typeof fetch>(async () => json({ emailStatus: "sent" }));
    vi.stubGlobal("fetch", request);
    const view = render(MemberReductionDialog, { props });
    await view.rerender({ ...props, driveExpiry: { date: "2031-01-01", expiresAt: "2031-01-01T00:00:00.000Z" } });
    await fireEvent.click(screen.getByRole("button", { name: "确认减少天数" }));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    expect(JSON.parse(request.mock.calls[0]![1]!.body as string).expectedDriveExpiryDate).toBeNull();
  });

  it("requires auth on a current 401 but ignores late replies after unmount", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => json({}, 401)),
    );
    const requireAuth = vi.fn();
    const view = render(MemberReductionDialog, { props: { ...props, requireAuth } });
    await fireEvent.click(screen.getByRole("button", { name: "确认减少天数" }));
    await waitFor(() => expect(requireAuth).toHaveBeenCalledOnce());
    view.unmount();
    requireAuth.mockClear();
    let finish!: (response: Response) => void;
    const request = vi.fn<typeof fetch>(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    vi.stubGlobal("fetch", request);
    const late = render(MemberReductionDialog, { props: { ...props, requireAuth } });
    await fireEvent.click(screen.getByRole("button", { name: "确认减少天数" }));
    late.unmount();
    expect(request.mock.calls[0]![1]!.signal!.aborted).toBe(true);
    finish(json({}, 401));
    await Promise.resolve();
    expect(requireAuth).not.toHaveBeenCalled();
    expect(late.emitted("saved")).toBeUndefined();
  });

  it("does not retry a timed-out mutation and requires a refresh", async () => {
    vi.useFakeTimers();
    const request = vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => new Promise(() => {}) });
    vi.stubGlobal("fetch", request);
    render(MemberReductionDialog, { props });
    await fireEvent.click(screen.getByRole("button", { name: "确认减少天数" }));
    await vi.advanceTimersByTimeAsync(90001);
    expect(screen.getByRole("alert")).toHaveTextContent("不要重复扣减");
    expect(screen.getByRole("button", { name: "确认减少天数" })).toBeDisabled();
    expect(request).toHaveBeenCalledTimes(1);
  });
});
