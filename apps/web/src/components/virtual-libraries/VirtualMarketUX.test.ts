import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import VirtualMarketView from "./VirtualMarketView.vue";
import { DEFAULT_LIBRARY_POSTER_URL } from "@emby-task-center/contracts/library-poster";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const libraries = [
  { id: "mine", name: "自有合集", authorName: "自己", owned: true, enabled: true },
  { id: "enabled", name: "动画精选", authorName: "作者甲", owned: false, enabled: true },
  { id: "disabled", name: "纪录片精选", authorName: "作者乙", owned: false, enabled: false },
];
describe("market status and per-library actions", () => {
  it("shows persistent statuses separately from action buttons and filters real subscription counts", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ libraries })));
    render(VirtualMarketView, { props: { personal: true, requireAuth: vi.fn() } });
    await screen.findByRole("heading", { name: "动画精选" });
    expect(within(screen.getByRole("article", { name: "自有合集" })).getByText("自己创建")).toBeTruthy();
    expect(within(screen.getByRole("article", { name: "动画精选" })).getByText("已启用", { exact: true })).toBeTruthy();
    expect(
      within(screen.getByRole("article", { name: "纪录片精选" })).getByText("未启用", { exact: true }),
    ).toBeTruthy();
    await fireEvent.click(screen.getByRole("button", { name: "已启用 1" }));
    expect(screen.getAllByRole("article")).toHaveLength(1);
    expect(screen.getByRole("heading", { name: "动画精选" })).toBeTruthy();
    await fireEvent.click(screen.getByRole("button", { name: "未启用 1" }));
    expect(screen.getAllByRole("article")).toHaveLength(1);
    expect(screen.getByRole("heading", { name: "纪录片精选" })).toBeTruthy();
  });
  it("searches library names and authors and provides a filtered empty state", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ libraries })));
    render(VirtualMarketView, { props: { personal: true, requireAuth: vi.fn() } });
    await screen.findByRole("heading", { name: "动画精选" });
    await fireEvent.update(screen.getByRole("searchbox", { name: "搜索市场" }), "作者乙");
    expect(screen.getAllByRole("article")).toHaveLength(1);
    await fireEvent.update(screen.getByRole("searchbox", { name: "搜索市场" }), "不存在");
    expect(screen.queryAllByRole("article")).toHaveLength(0);
    expect(screen.getByRole("heading", { name: "没有匹配的媒体库" })).toBeTruthy();
  });
  it("keeps other cards usable and prevents duplicate toggles while one library is pending", async () => {
    let finish!: (response: Response) => void;
    const fetch = vi.fn((_url: unknown, init?: RequestInit) =>
      init?.method
        ? new Promise<Response>((resolve) => (finish = resolve))
        : Promise.resolve(json({ libraries: structuredClone(libraries) })),
    );
    vi.stubGlobal("fetch", fetch);
    render(VirtualMarketView, { props: { personal: true, requireAuth: vi.fn() } });
    const card = await screen.findByRole("article", { name: "纪录片精选" });
    await fireEvent.click(within(card).getByRole("button", { name: "启用媒体库" }));
    expect(within(card).getByRole("button").hasAttribute("disabled")).toBe(true);
    expect(
      within(screen.getByRole("article", { name: "动画精选" }))
        .getByRole("button")
        .hasAttribute("disabled"),
    ).toBe(false);
    await fireEvent.click(within(card).getByRole("button"));
    expect(fetch.mock.calls.filter(([, init]) => init?.method === "PUT")).toHaveLength(1);
    finish(json({ enabled: true }));
    await screen.findByText("已启用「纪录片精选」，播放器刷新后显示。");
    expect(within(card).getByText("已启用", { exact: true })).toBeTruthy();
    expect(within(card).getByRole("button", { name: "关闭媒体库" })).toBeTruthy();
  });
  it("retains the previous subscription status after a failed save", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json({ libraries: structuredClone(libraries) }))
      .mockResolvedValueOnce(json({ message: "保存失败测试" }, 503));
    vi.stubGlobal("fetch", fetch);
    render(VirtualMarketView, { props: { personal: true, requireAuth: vi.fn() } });
    const card = await screen.findByRole("article", { name: "纪录片精选" });
    await fireEvent.click(within(card).getByRole("button", { name: "启用媒体库" }));
    await waitFor(() => expect(within(card).getByRole("alert").textContent).toContain("保存失败测试"));
    expect(within(card).getByText("未启用", { exact: true })).toBeTruthy();
    expect(within(card).getByRole("button", { name: "启用媒体库" }).hasAttribute("disabled")).toBe(false);
  });
  it("replaces a failed poster with a readable cover", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(json({ libraries: [{ ...libraries[2], posterImageTag: "poster" }] })),
    );
    const view = render(VirtualMarketView, { props: { personal: true, requireAuth: vi.fn() } });
    await screen.findByRole("heading", { name: "纪录片精选" });
    await fireEvent.error(view.container.querySelector("img")!);
    expect(view.container.querySelector("img")).toHaveAttribute("src", DEFAULT_LIBRARY_POSTER_URL);
  });
});
