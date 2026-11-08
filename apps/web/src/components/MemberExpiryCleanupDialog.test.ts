import { cleanup, fireEvent, render, screen } from "@testing-library/vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import MemberExpiryCleanupDialog from "./MemberExpiryCleanupDialog.vue";

const base = "/api/member-expiry-cleanup";
const expiresAt = "2025-11-01T12:00:00.000Z";
const preview = {
  previewToken: "preview-1",
  days: 14,
  candidates: [
    { id: 1, email: "linked@example.test", expiresAt, linked: true },
    { id: 2, email: "local@example.test", expiresAt, linked: false },
  ],
  blocked: [{ id: 3, email: "admin@example.test", expiresAt, reason: "administrator" }],
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const previewButton = () => screen.getByRole("button", { name: /预览清理范围|重新预览/ });
const approve = () => fireEvent.click(screen.getByRole("checkbox", { name: /包括历史过期会员/ }));

function setup(fetchImpl: typeof fetch) {
  const mock = vi.fn(fetchImpl);
  vi.stubGlobal("fetch", mock);
  return { mock, view: render(MemberExpiryCleanupDialog, { props: { requireAuth: vi.fn() } }) };
}

beforeEach(() => {
  Object.defineProperties(HTMLDialogElement.prototype, {
    showModal: {
      configurable: true,
      value(this: HTMLDialogElement) {
        this.open = true;
      },
    },
    close: {
      configurable: true,
      value(this: HTMLDialogElement) {
        this.open = false;
      },
    },
  });
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal");
  Reflect.deleteProperty(HTMLDialogElement.prototype, "close");
  vi.unstubAllGlobals();
});

describe("MemberExpiryCleanupDialog", () => {
  it("validates days, displays candidates and protects a single confirmed save", async () => {
    let finish!: (value: Response) => void;
    const { mock, view } = setup(async (_input, init) => {
      if (init?.method === "POST") return json(preview);
      if (init?.method === "PUT")
        return new Promise<Response>((resolve) => {
          finish = resolve;
        });
      return json({ days: null });
    });
    await screen.findByText("当前已关闭");
    const days = screen.getByRole("spinbutton", { name: "过期天数" });
    for (const value of ["0", "1.5", "3651", ""]) {
      await fireEvent.update(days, value);
      expect(previewButton()).toBeDisabled();
    }
    await fireEvent.update(days, "14");
    await fireEvent.click(previewButton());
    const confirm = await screen.findByRole("button", { name: "确认启用自动删除" });
    expect(screen.getByRole("heading", { name: "当前清理预览" })).toHaveFocus();
    expect(screen.getByText("符合删除条件（2 位）")).toBeInTheDocument();
    expect(screen.getByText("local@example.test")).toBeInTheDocument();
    expect(screen.getByText(/仅会员记录/)).toBeInTheDocument();
    expect(screen.getByText("Emby 管理员受保护")).toBeInTheDocument();
    expect(confirm).toBeDisabled();
    expect(mock.mock.calls.map(([url]) => url)).toEqual([base, `${base}/preview`]);
    expect(JSON.parse(mock.mock.calls[1]![1]!.body as string)).toEqual({ days: 14 });
    await approve();
    await fireEvent.click(confirm);
    await fireEvent.click(confirm);
    expect(confirm).toBeDisabled();
    await fireEvent(screen.getByRole("dialog"), new Event("cancel", { cancelable: true }));
    expect(view.emitted("close")).toBeUndefined();
    expect(mock.mock.calls.filter(([, init]) => init?.method === "PUT")).toHaveLength(1);
    expect(JSON.parse(mock.mock.calls[2]![1]!.body as string)).toEqual({
      days: 14,
      expectedDays: null,
      previewToken: "preview-1",
    });
    finish(json({ days: 14 }));
    await screen.findByText(/设置已保存/);
    expect(screen.getByText("当前规则 · 过期满 14 天")).toBeInTheDocument();
  });

  it("clears confirmation on edit and requires a new preview after the old preview expires", async () => {
    const { mock } = setup(async (_input, init) => {
      if (init?.method === "POST") return json({ ...preview, candidates: [], blocked: [] });
      if (init?.method === "PUT") return json({ error: "member_cleanup_preview_expired" }, 409);
      return json({ days: 14 });
    });
    await screen.findByText("当前规则 · 过期满 14 天");
    await fireEvent.click(previewButton());
    const update = () => screen.findByRole("button", { name: "确认更新自动删除" });
    await update();
    expect(screen.getByText(/当前没有符合删除条件/)).toBeInTheDocument();
    await approve();
    const days = screen.getByRole("spinbutton", { name: "过期天数" });
    await fireEvent.update(days, "15");
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    await fireEvent.update(days, "14");
    await fireEvent.click(previewButton());
    expect(await update()).toBeDisabled();
    await approve();
    await fireEvent.click(await update());
    expect(await screen.findByRole("alert")).toHaveTextContent("预览已失效");
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(mock.mock.calls.filter(([, init]) => init?.method === "PUT")).toHaveLength(1);
  });

  it("disables without a preview, and requires a policy reload before retrying a conflicting update", async () => {
    let read = 0;
    let write = 0;
    const { mock } = setup(async (_input, init) => {
      if (init?.method === "PUT") {
        return write++ === 0 ? json({ error: "member_cleanup_policy_changed" }, 409) : json({ days: null });
      }
      return json({ days: read++ === 0 ? 14 : 18 });
    });
    const disable = await screen.findByRole("button", { name: "关闭自动删除" });
    await fireEvent.click(disable);
    expect(await screen.findByRole("alert")).toHaveTextContent("已被其他操作修改");
    expect(disable).toBeDisabled();
    await fireEvent.click(screen.getByRole("button", { name: "重新读取设置" }));
    await screen.findByText("当前规则 · 过期满 18 天");
    await fireEvent.click(disable);
    await screen.findByText("自动删除已关闭。");
    expect(mock.mock.calls.map(([url]) => url)).toEqual([base, base, base, base]);
    expect(JSON.parse(mock.mock.calls[3]![1]!.body as string)).toEqual({ days: null, expectedDays: 18 });
  });
});
