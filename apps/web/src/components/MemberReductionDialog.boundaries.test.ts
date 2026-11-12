import { fireEvent, render, screen, waitFor } from "@testing-library/vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import MemberReductionDialog from "./MemberReductionDialog.vue";
import type { SubmissionUser } from "../types";

const day = 86_400_000;
const member = {
  id: 1,
  email: "member@example.com",
  subscriptionExpiresAt: "2030-01-10T00:00:00.000Z",
  deferredMembershipMs: 1.5 * day,
} as SubmissionUser;
const props = { member, requireAuth: vi.fn(), driveExpiry: null };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("reduction dialog boundaries", () => {
  it.each(["-1", "0", "1.5", "", "36501"])("blocks invalid days %s even on direct form submit", async (value) => {
    const request = vi.fn();
    vi.stubGlobal("fetch", request);
    render(MemberReductionDialog, { props });
    const input = screen.getByLabelText("减少天数");
    await fireEvent.update(input, value);
    expect(screen.getByRole("button", { name: "确认减少天数" })).toBeDisabled();
    expect(screen.getByText(/扣减后到期时间：/)).toHaveTextContent("请输入 1–36500 天");
    await fireEvent.submit(input.closest("form")!);
    expect(request).not.toHaveBeenCalled();
  });

  it("accepts the maximum day count and keeps a partial deferred day exact", async () => {
    const request = vi.fn<typeof fetch>(async () => json({ emailStatus: "sent" }));
    vi.stubGlobal("fetch", request);
    render(MemberReductionDialog, { props });
    await fireEvent.update(screen.getByLabelText("减少天数"), "2");
    expect(screen.getByText(/扣减后到期时间：/)).toHaveTextContent(
      new Date("2030-01-09T12:00:00.000Z").toLocaleString(),
    );
    expect(screen.getByText("扣减后待激活时长：0 天")).toBeInTheDocument();
    await fireEvent.update(screen.getByLabelText("减少天数"), "36500");
    const expected = new Date(Date.parse(member.subscriptionExpiresAt!) - 36498.5 * day).toLocaleString();
    expect(screen.getByText(/扣减后到期时间：/)).toHaveTextContent(expected);
    await fireEvent.click(screen.getByRole("button", { name: "确认减少天数" }));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    expect(JSON.parse(request.mock.calls[0]![1]!.body as string).days).toBe(36500);
  });

  it("keeps a concurrent membership refresh out of the preview and optimistic concurrency guard", async () => {
    const request = vi.fn<typeof fetch>(async () => json({ error: "reduction_expiry_changed" }, 409));
    vi.stubGlobal("fetch", request);
    const view = render(MemberReductionDialog, { props });
    await fireEvent.update(screen.getByLabelText("减少天数"), "4");
    const preview = screen.getByText(/扣减后到期时间：/).textContent;
    await view.rerender({
      ...props,
      member: { ...member, subscriptionExpiresAt: "2031-06-01T00:00:00.000Z", deferredMembershipMs: 100 * day },
    });
    expect(screen.getByText(/扣减后到期时间：/).textContent).toBe(preview);
    expect(screen.getByText("现有待激活时长：1 天 12 小时")).toBeInTheDocument();
    await fireEvent.click(screen.getByRole("button", { name: "确认减少天数" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("已变更");
    expect(JSON.parse(request.mock.calls[0]![1]!.body as string)).toMatchObject({
      expectedExpiresAt: member.subscriptionExpiresAt,
      expectedDeferredMembershipMs: 1.5 * day,
    });
    expect(view.emitted("saved")).toBeUndefined();
  });

  it.each([
    [500, "upstream temporarily unavailable"],
    [409, JSON.stringify({ error: "new_unknown_error" })],
    [200, "not-json"],
  ])("locks an ambiguous response %s without claiming success or retrying", async (status, body) => {
    const request = vi.fn<typeof fetch>(async () => new Response(body, { status }));
    vi.stubGlobal("fetch", request);
    const view = render(MemberReductionDialog, { props });
    await fireEvent.click(screen.getByRole("button", { name: "确认减少天数" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("结果未确认");
    const submit = screen.getByRole("button", { name: "确认减少天数" });
    expect(submit).toBeDisabled();
    await fireEvent.submit(submit.closest("form")!);
    expect(request).toHaveBeenCalledTimes(1);
    expect(view.emitted("saved")).toBeUndefined();
  });

  it("blocks Escape while saving and ignores a successful reply after the dialog is destroyed", async () => {
    let finish!: (response: Response) => void;
    const request = vi.fn<typeof fetch>(() => new Promise((resolve) => (finish = resolve)));
    vi.stubGlobal("fetch", request);
    const view = render(MemberReductionDialog, { props });
    await fireEvent.click(screen.getByRole("button", { name: "确认减少天数" }));
    await fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(view.emitted("close")).toBeUndefined();
    view.unmount();
    expect(request.mock.calls[0]![1]!.signal!.aborted).toBe(true);
    finish(json({ emailStatus: "sent", embyStatus: "synced" }));
    await Promise.resolve();
    await Promise.resolve();
    expect(view.emitted("saved")).toBeUndefined();
  });

  it("wraps keyboard focus, closes with Escape when idle and returns focus to the opener", async () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    const view = render(MemberReductionDialog, { props });
    try {
      const first = screen.getByLabelText("减少天数");
      const last = screen.getByRole("button", { name: "确认减少天数" });
      // Testing Library unwraps VTU's root after mount, which resets jsdom focus.
      first.focus();
      await fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
      expect(last).toHaveFocus();
      await fireEvent.keyDown(last, { key: "Tab" });
      expect(first).toHaveFocus();
      await fireEvent.keyDown(first, { key: "Escape" });
      expect(view.emitted("close")).toHaveLength(1);
      view.unmount();
      expect(opener).toHaveFocus();
    } finally {
      opener.remove();
    }
  });
});
