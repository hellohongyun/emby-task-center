import { fireEvent, render, screen, waitFor } from "@testing-library/vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import MembershipDriveExpirySettings from "./MembershipDriveExpirySettings.vue";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

const limit = { date: "2028-08-31", expiresAt: "2028-08-31T15:59:59.999Z" };
afterEach(() => vi.unstubAllGlobals());

describe("membership drive expiry settings", () => {
  it("leaves the cap unknown after a read failure and recovers without activating the proposed date", async () => {
    const mock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({}, 503))
      .mockResolvedValueOnce(json({ limit: null }));
    vi.stubGlobal("fetch", mock);
    render(MembershipDriveExpirySettings, { props: { requireAuth: vi.fn() } });
    expect(await screen.findByRole("alert")).toHaveTextContent("读取网盘到期设置失败");
    const save = screen.getByRole("button", { name: "保存网盘到期日" });
    expect(save).toBeDisabled();
    await fireEvent.click(screen.getByRole("button", { name: "重新读取设置" }));
    await screen.findByText(/当前未设置上限/);
    expect(save).toBeEnabled();
    expect(mock.mock.calls.every(([, init]) => init?.method !== "PUT")).toBe(true);
  });

  it("prefills the date without enabling the cap until explicitly saved", async () => {
    const mock = vi.fn<typeof fetch>(async (_url, init) =>
      init?.method === "PUT"
        ? json({ limit, changedMembers: 4, releasedMembers: 2, syncPending: 1 })
        : json({ limit: null }),
    );
    vi.stubGlobal("fetch", mock);
    const view = render(MembershipDriveExpirySettings, { props: { requireAuth: vi.fn() } });
    await screen.findByText(/当前未设置上限/);
    expect(screen.getByLabelText("网盘到期日")).toHaveValue("2028-08-31");
    expect(mock).toHaveBeenCalledTimes(1);
    await fireEvent.click(screen.getByRole("button", { name: "保存网盘到期日" }));
    await screen.findByText(/已更新 4 位会员，2 位会员的待激活时长已释放/);
    expect(screen.getByText(/1 个 Emby 账号待同步/)).toBeInTheDocument();
    expect(JSON.parse(mock.mock.calls[1]![1]!.body as string)).toEqual({ date: "2028-08-31", expectedDate: null });
    expect(view.emitted("membersChanged")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "保存网盘到期日" })).toBeDisabled();
  });

  it("holds the edited date after a conflict and requires an updated expected date before saving", async () => {
    const external = { date: "2029-01-01", expiresAt: "2029-01-01T15:59:59.999Z" };
    let read = 0;
    let write = 0;
    const mock = vi.fn<typeof fetch>(async (_url, init) => {
      if (init?.method !== "PUT") return json({ limit: read++ ? external : limit });
      if (write++ === 0) return json({ error: "drive_expiry_changed" }, 409);
      return json({
        limit: { date: "2029-06-01", expiresAt: "2029-06-01T15:59:59.999Z" },
        changedMembers: 0,
        releasedMembers: 0,
        syncPending: 0,
      });
    });
    vi.stubGlobal("fetch", mock);
    render(MembershipDriveExpirySettings, { props: { requireAuth: vi.fn() } });
    await screen.findByText(/当前上限 2028-08-31/);
    const date = screen.getByLabelText("网盘到期日");
    const save = screen.getByRole("button", { name: "保存网盘到期日" });
    await fireEvent.update(date, "2029-06-01");
    await fireEvent.click(save);
    expect(await screen.findByRole("alert")).toHaveTextContent("请重新读取设置");
    expect(save).toBeDisabled();
    await fireEvent.click(screen.getByRole("button", { name: "重新读取设置" }));
    await screen.findByText(/当前上限 2029-01-01/);
    expect(date).toHaveValue("2029-06-01");
    expect(save).toBeEnabled();
    await fireEvent.click(save);
    await waitFor(() => expect(screen.getByText(/当前上限 2029-06-01/)).toBeInTheDocument());
    expect(JSON.parse(mock.mock.calls[3]![1]!.body as string)).toEqual({
      date: "2029-06-01",
      expectedDate: "2029-01-01",
    });
  });
});
