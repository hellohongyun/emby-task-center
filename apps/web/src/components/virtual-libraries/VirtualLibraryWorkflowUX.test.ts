import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import VirtualPlayerAccount from "./VirtualPlayerAccount.vue";
import VirtualLibraryWorkspace from "./VirtualLibraryWorkspace.vue";
import PersonalLibraryOrder from "./PersonalLibraryOrder.vue";
import VirtualMarketDefaults from "./VirtualMarketDefaults.vue";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const items = [
  { id: "mine", name: "我的收藏", kind: "owned" },
  { id: "native", name: "电影", kind: "native" },
];
describe("visible state and independent library settings", () => {
  it("binds the player independently without sending or overwriting new-user default IDs", async () => {
    const fetch = vi.fn(async (url: string, init?: RequestInit) =>
      json(
        url.endsWith("/users")
          ? { users: [{ id: "player", name: "我的 Emby 账号" }] }
          : { libraryIds: ["keep-default"], adminEmbyUserId: init?.method === "PATCH" ? "player" : null },
      ),
    );
    vi.stubGlobal("fetch", fetch);
    const view = render(VirtualPlayerAccount, { props: { requireAuth: vi.fn() } });
    await screen.findByText("尚未绑定", { exact: true });
    await fireEvent.click(screen.getByRole("button", { name: "绑定账号" }));
    await fireEvent.update(screen.getByRole("combobox"), "player");
    await fireEvent.click(screen.getByRole("button", { name: "保存播放器账号" }));
    await screen.findByText("已绑定", { exact: true });
    expect(JSON.parse(fetch.mock.calls.find(([, init]) => init?.method === "PATCH")![1]!.body as string)).toEqual({
      adminEmbyUserId: "player",
    });
    expect(view.emitted().saved).toHaveLength(1);
    expect(screen.getByText(/我的 Emby 账号/)).toBeTruthy();
  });
  it("requires saving or undoing the current page before changing the bound player", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        json(
          url.endsWith("/users")
            ? { users: [{ id: "player", name: "账号" }] }
            : { libraryIds: [], adminEmbyUserId: null },
        ),
      ),
    );
    render(VirtualPlayerAccount, { props: { requireAuth: vi.fn(), pendingChanges: true } });
    await screen.findByText("尚未绑定", { exact: true });
    await fireEvent.click(screen.getByRole("button", { name: "绑定账号" }));
    await fireEvent.update(screen.getByRole("combobox"), "player");
    expect(screen.getByRole("button", { name: "保存播放器账号" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByText(/请先保存或撤销/)).toBeTruthy();
  });
  it("keeps a failed order save visible as unsaved without discarding the draft", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) =>
        init?.method === "PUT"
          ? json({ error: "unavailable" }, 503)
          : json({ items, order: ["mine", "native"], hasPersonalOrder: true }),
      ),
    );
    render(PersonalLibraryOrder, { props: { personal: true, requireAuth: vi.fn() } });
    await screen.findByText("使用个人顺序", { exact: true });
    await fireEvent.click(screen.getByRole("button", { name: "下移 我的收藏" }));
    await fireEvent.click(screen.getByRole("button", { name: "保存顺序" }));
    await screen.findByRole("alert");
    expect(screen.getAllByText("有未保存的更改", { exact: true }).length).toBeGreaterThan(0);
    expect(
      within(screen.getByRole("list", { name: "媒体库显示顺序" })).getAllByRole("listitem")[0]!.textContent,
    ).toContain("电影");
    expect(screen.getByRole("button", { name: "刷新" }).hasAttribute("disabled")).toBe(true);
    await fireEvent.click(screen.getByRole("button", { name: "撤销修改" }));
    expect(screen.queryByText("有未保存的更改", { exact: true })).toBeNull();
  });
  it("shows the protected custom cover and a built-in cover in personal ordering", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json({
          items: [{ ...items[0], posterImageTag: "custom-tag" }, items[1]],
          order: ["mine", "native"],
          hasPersonalOrder: true,
        }),
      ),
    );
    render(PersonalLibraryOrder, { props: { personal: true, requireAuth: vi.fn() } });
    const cover = await screen.findByRole("img", { name: "我的收藏媒体库海报" });
    expect(cover.getAttribute("src")).toBe("/api/public/virtual-library-order/mine/poster?tag=custom-tag");
    expect(screen.getByRole("img", { name: "电影媒体库海报" }).getAttribute("src")).toMatch(/^data:image\/svg\+xml/);
  });
  it("keeps default selections after a failed save and never exposes account binding in that form", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) =>
        init?.method === "PATCH"
          ? json({ error: "unavailable" }, 503)
          : json(
              url.endsWith("/defaults")
                ? { libraryIds: [], adminEmbyUserId: "unchanged" }
                : { libraries: [{ id: "shared", name: "电影精选", authorName: "用户" }] },
            ),
      ),
    );
    render(VirtualMarketDefaults, { props: { requireAuth: vi.fn() } });
    await fireEvent.click(await screen.findByRole("checkbox", { name: "电影精选" }));
    await fireEvent.click(screen.getByRole("button", { name: "保存默认设置" }));
    await screen.findByRole("alert");
    expect((screen.getByRole("checkbox", { name: "电影精选" }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText("有未保存的更改", { exact: true })).toBeTruthy();
    expect(screen.queryByRole("combobox")).toBeNull();
  });
  it("guards tab switches so an unsaved personal order is not silently lost", async () => {
    const fetch = vi.fn(async (url: string) =>
      json(
        url.endsWith("virtual-library-order")
          ? { items, order: ["mine", "native"], hasPersonalOrder: true }
          : url.endsWith("source-items")
            ? { items: [], total: 0 }
            : url.endsWith("source-libraries")
              ? { items: [] }
              : { libraries: [] },
      ),
    );
    vi.stubGlobal("fetch", fetch);
    render(VirtualLibraryWorkspace, { props: { personal: true, requireAuth: vi.fn() } });
    const nav = screen.getByRole("navigation", { name: "虚拟媒体库功能" });
    await fireEvent.click(within(nav).getByRole("button", { name: "我的媒体库顺序" }));
    await fireEvent.click(await screen.findByRole("button", { name: "下移 我的收藏" }));
    await fireEvent.click(within(nav).getByRole("button", { name: "媒体库市场" }));
    await screen.findByRole("alertdialog", { name: "未保存的更改" });
    expect(screen.queryByRole("heading", { name: "虚拟媒体库市场" })).toBeNull();
    await fireEvent.click(screen.getByRole("button", { name: "继续编辑" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    await fireEvent.click(within(nav).getByRole("button", { name: "媒体库市场" }));
    await fireEvent.click(screen.getByRole("button", { name: "放弃更改并切换" }));
    await screen.findByRole("heading", { name: "虚拟媒体库市场" });
    await waitFor(() => expect(fetch.mock.calls.some(([url]) => url.endsWith("virtual-library-market"))).toBe(true));
  });
});
