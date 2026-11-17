import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import VirtualMarketView from "./VirtualMarketView.vue";
import VirtualLibraryAuthor from "./VirtualLibraryAuthor.vue";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const library = {
  id: "shared",
  name: "精选",
  collectionType: "mixed",
  authorName: "用户",
  authorAvatarUrl: "/avatar",
  owned: false,
  enabled: false,
  itemCount: 0,
};
const film = { itemId: "film", name: "测试电影", year: 2026, type: "Movie", imageTag: "tag" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe("market library preview", () => {
  it("previews disabled libraries with the viewer's image paths and never subscribes", async () => {
    const fetch = vi.fn(async (url: string) =>
      json(
        url.includes("/details")
          ? { library, items: [film], total: 1, startIndex: 0, limit: 40 }
          : { libraries: [library] },
      ),
    );
    vi.stubGlobal("fetch", fetch);
    render(VirtualMarketView, { props: { personal: true, requireAuth: vi.fn() } });
    const opener = (await screen.findAllByRole("button", { name: "查看 精选 详情" }))[0]!;
    opener.focus();
    await fireEvent.click(opener);
    const dialog = await screen.findByRole("dialog", { name: "精选 详情" });
    await within(dialog).findByRole("heading", { name: "测试电影" });
    expect(dialog.querySelector(".vmd-summary")).toHaveTextContent("混合库 · 1 项内容");
    expect(within(dialog).getByRole("img", { name: "测试电影 海报" })).toHaveAttribute(
      "src",
      "/api/public/virtual-library-market/shared/items/film/poster?tag=tag",
    );
    expect(fetch.mock.calls.some(([url]) => url.includes("subscription"))).toBe(false);
    await fireEvent.keyDown(within(dialog).getByRole("button", { name: "关闭媒体库详情" }), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(opener);
    expect(document.body.style.overflow).toBe("");
  });

  it("keeps subscription controls separate from preview controls", async () => {
    const fetch = vi.fn(async (url: string) =>
      json(url.endsWith("subscription") ? { enabled: true } : { libraries: [library] }),
    );
    vi.stubGlobal("fetch", fetch);
    render(VirtualMarketView, { props: { personal: true, requireAuth: vi.fn() } });
    await fireEvent.click(await screen.findByRole("button", { name: "启用媒体库" }));
    await screen.findByRole("button", { name: "关闭媒体库" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(fetch.mock.calls.some(([url]) => url.includes("details"))).toBe(false);
  });

  it("pages content and applies explicitly local search, then closes through the backdrop", async () => {
    const fetch = vi.fn(async (url: string) =>
      json(
        url.includes("/details")
          ? {
              library,
              items: [{ ...film, name: url.includes("startIndex=40") ? "第二页电影" : film.name }],
              total: 41,
              startIndex: url.includes("startIndex=40") ? 40 : 0,
              limit: 40,
            }
          : { libraries: [library] },
      ),
    );
    vi.stubGlobal("fetch", fetch);
    render(VirtualMarketView, { props: { personal: true, requireAuth: vi.fn() } });
    await fireEvent.click((await screen.findAllByRole("button", { name: "查看 精选 详情" }))[0]!);
    await fireEvent.click(await screen.findByRole("button", { name: "下一页" }));
    await screen.findByRole("heading", { name: "第二页电影" });
    expect(fetch.mock.calls.some(([url]) => url.endsWith("details?startIndex=40&limit=40"))).toBe(true);
    await fireEvent.update(screen.getByRole("searchbox", { name: "搜索本页影片" }), "不存在");
    expect(screen.getByText("没有匹配的影片")).toBeTruthy();
    await fireEvent.click(document.querySelector(".vmd-backdrop")!);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("distinguishes loading and upstream errors from an empty library and retries", async () => {
    let finish!: (response: Response) => void;
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json({ libraries: [library] }))
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValueOnce(json({ library, items: [], total: 0, startIndex: 0, limit: 40 }));
    vi.stubGlobal("fetch", fetch);
    render(VirtualMarketView, { props: { personal: true, requireAuth: vi.fn() } });
    await fireEvent.click((await screen.findAllByRole("button", { name: "查看 精选 详情" }))[0]!);
    expect(screen.getByText("正在读取媒体库内容…")).toBeTruthy();
    expect(screen.queryByText("此库尚无影片。")).toBeNull();
    finish(json({ error: "emby_account_required" }, 403));
    expect(await screen.findByRole("alert")).toHaveTextContent("绑定 Emby 账号");
    await fireEvent.click(screen.getByRole("button", { name: "重试读取内容" }));
    await screen.findByText("此库尚无影片。");
  });

  it("uses stable fallback avatars for members, administrators, and system authors", async () => {
    const view = render(VirtualLibraryAuthor, { props: { library } });
    await fireEvent.error(view.container.querySelector("img")!);
    expect(view.container.querySelector(".member-avatar")).toHaveTextContent("用");
    await view.rerender({ library: { ...library, authorAvatarUrl: null, authorName: "管理员" } });
    expect(view.container.querySelector(".member-avatar")).toHaveTextContent("管");
    await view.rerender({ library: { ...library, authorAvatarUrl: null, source: "tgtodrive" } });
    expect(view.container.querySelector(".member-avatar")).toHaveTextContent("系");
  });

  it.each([
    ["virtual_library_not_found", "该媒体库已下架、被移除或无权查看"],
    ["upstream_catalog_unavailable", "媒体库来源暂时无法读取"],
    ["invalid_upstream_catalog", "媒体库来源返回的内容格式异常"],
    ["emby_not_configured", "管理员尚未配置 Emby 服务"],
  ])("shows a clear Chinese message for %s without unrelated binding advice", async (code, message) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.includes("/details") ? json({ error: code }, 503) : json({ libraries: [library] }),
      ),
    );
    render(VirtualMarketView, { props: { personal: true, requireAuth: vi.fn() } });
    await fireEvent.click((await screen.findAllByRole("button", { name: "查看 精选 详情" }))[0]!);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(message!);
    expect(alert).not.toHaveTextContent(code!);
    expect(alert).not.toHaveTextContent("绑定");
  });

  it("explains that an empty system library comes from its source", async () => {
    const systemLibrary = { ...library, source: "tgtodrive" };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        json(
          url.includes("/details")
            ? { library: systemLibrary, items: [], total: 0, startIndex: 0, limit: 40 }
            : { libraries: [systemLibrary] },
        ),
      ),
    );
    render(VirtualMarketView, { props: { personal: true, requireAuth: vi.fn() } });
    await fireEvent.click((await screen.findAllByRole("button", { name: "查看 精选 详情" }))[0]!);
    await screen.findByText("来源暂未返回影片，请稍后重试。");
    expect(screen.queryByText("作者添加内容后会在这里展示。")).toBeNull();
  });
});
