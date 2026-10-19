import { fireEvent, render, screen, waitFor, within } from "@testing-library/vue";
import { afterEach, expect, it, vi } from "vitest";
import VirtualLibrariesPage from "./VirtualLibrariesPage.vue";
import { APP_SERVICES, type AppServices } from "../state/app-services";
import type { VirtualLibraryMappingIssue } from "@emby-task-center/contracts/virtual-library";

const movie = { itemId: "42", name: "周末电影", type: "Movie", year: 2026, imageTag: null };
const library = {
  id: "virtual-one",
  name: "周末精选",
  collectionType: "mixed",
  sortOrder: 0,
  itemCount: 0,
  createdAt: "",
  updatedAt: "",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
afterEach(() => vi.unstubAllGlobals());

function setup(failed = false, issues: VirtualLibraryMappingIssue[] = []) {
  let added = false;
  let libraries = [library];
  const fetch = vi.fn(async (url: string, options?: RequestInit) => {
    if (url === "/api/virtual-libraries/proxy" && options?.method === "PUT") {
      const config = JSON.parse(String(options.body));
      return json({
        config,
        status: { running: config.enabled, port: config.enabled ? config.port : null, error: null },
      });
    }
    if (url === "/api/virtual-libraries/proxy")
      return json({
        config: { enabled: false, upstream: "", port: 8097 },
        status: { running: false, port: null, error: null },
      });
    if (url === "/api/virtual-libraries/source-libraries")
      return json({ items: [{ id: "origin", name: "原始电影库" }] });
    if (url.startsWith("/api/virtual-libraries/source-items?")) return json({ items: [movie], total: 1 });
    if (url.endsWith("/items") && options?.method === "POST") {
      if (failed)
        return json({ error: "item_type_mismatch", message: "影片类型与当前媒体库不兼容，请改为混合库" }, 400);
      added = true;
      return json({ items: [movie] });
    }
    if (url.endsWith("/items/42") && options?.method === "DELETE") {
      added = false;
      return new Response(null, { status: 204 });
    }
    if (url.endsWith("/items")) return json({ items: added || issues.length ? [movie] : [], issues });
    if (url === "/api/virtual-libraries" && options?.method === "POST") {
      const created = { ...library, ...JSON.parse(String(options.body)), id: "virtual-new" };
      libraries = [...libraries, created];
      return json({ library: created });
    }
    if (url === "/api/virtual-libraries")
      return json({ libraries: libraries.map((value) => ({ ...value, itemCount: added ? 1 : 0 })) });
    throw new Error(`Unexpected request ${url}`);
  });
  vi.stubGlobal("fetch", fetch);
  render(VirtualLibrariesPage, {
    global: { provide: { [APP_SERVICES]: { requireAuth: vi.fn() } as unknown as AppServices } },
  });
  return fetch;
}

it("maps existing movies into a mixed library and removes only the mapping", async () => {
  const fetch = setup();
  const checkbox = await screen.findByRole("checkbox", { name: "选择 周末电影" });
  await fireEvent.click(checkbox);
  await fireEvent.click(screen.getByRole("button", { name: "加入已选（1）" }));
  const content = screen.getByRole("region", { name: "已加入的内容" });
  expect(await within(content).findByText("周末电影")).toBeInTheDocument();
  expect(fetch).toHaveBeenCalledWith(
    "/api/virtual-libraries/virtual-one/items",
    expect.objectContaining({ method: "POST", body: JSON.stringify({ itemIds: ["42"] }) }),
  );
  await fireEvent.click(within(content).getByRole("button", { name: "从虚拟库移除 周末电影" }));
  expect(await within(content).findByText(/还没有内容/)).toBeInTheDocument();
  const deletes = fetch.mock.calls.filter(([, options]) => options?.method === "DELETE");
  expect(deletes).toHaveLength(1);
  expect(deletes[0]?.[0]).toBe("/api/virtual-libraries/virtual-one/items/42");
});

it("shows unresolved mapping explanations while keeping poster cards and removal available", async () => {
  setup(false, [
    { itemId: "42", reason: "ambiguous", message: "《周末电影》存在多个相同 TMDB 的来源，未自动重新关联。" },
    { itemId: "43", reason: "unidentified", message: "《周末剧集》未保存 TMDB 编号，无法自动重新关联。" },
  ]);
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("存在多个相同 TMDB 的来源");
  expect(alert).toHaveTextContent("未保存 TMDB 编号");
  expect(alert).toHaveTextContent("关联已保留");
  expect(alert).toHaveTextContent("刷新");
  expect(alert).toHaveTextContent("重新选择对应作品");
  const content = screen.getByRole("region", { name: "已加入的内容" });
  expect(within(content).getByRole("button", { name: "从虚拟库移除 周末电影" })).toBeEnabled();
  expect(within(content).getByText("周末电影")).toBeInTheDocument();
});

it("shows add failures and keeps the selection available for retry", async () => {
  setup(true);
  await fireEvent.click(await screen.findByRole("checkbox", { name: "选择 周末电影" }));
  await fireEvent.click(screen.getByRole("button", { name: "加入已选（1）" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("影片类型与当前媒体库不兼容，请改为混合库");
  expect(screen.getByRole("checkbox", { name: "选择 周末电影" })).toBeChecked();
  await waitFor(() => expect(screen.getByRole("button", { name: "加入已选（1）" })).toBeEnabled());
});

it("creates a new library with its display type and explicit sort order", async () => {
  const fetch = setup();
  await screen.findByRole("checkbox", { name: "选择 周末电影" });
  await fireEvent.click(screen.getByRole("button", { name: "＋ 新建虚拟媒体库" }));
  await fireEvent.update(screen.getByRole("textbox", { name: "媒体库名称" }), "精选电影");
  await fireEvent.update(screen.getByRole("combobox", { name: "显示类型" }), "movies");
  await fireEvent.update(screen.getByRole("spinbutton", { name: "排序" }), "-2");
  await fireEvent.click(screen.getByRole("button", { name: "保存媒体库" }));
  expect(await screen.findByRole("button", { name: /精选电影 电影/ })).toHaveAttribute("aria-pressed", "true");
  expect(fetch).toHaveBeenCalledWith(
    "/api/virtual-libraries",
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ name: "精选电影", collectionType: "movies", sortOrder: -2 }),
    }),
  );
});

it("saves the enabled reverse proxy and displays the actual listening port", async () => {
  const fetch = setup();
  await screen.findByRole("checkbox", { name: "选择 周末电影" });
  await fireEvent.update(screen.getByRole("textbox", { name: /TgtoDrive 的 Emby 反代地址/ }), "http://tgtd.local:8096");
  await fireEvent.update(screen.getByRole("spinbutton", { name: "监听端口" }), "8098");
  await fireEvent.click(screen.getByRole("checkbox", { name: "启用客户端反代" }));
  await fireEvent.click(screen.getByRole("button", { name: "保存反代设置" }));
  expect(await screen.findByText("http://localhost:8098")).toBeInTheDocument();
  expect(fetch).toHaveBeenCalledWith(
    "/api/virtual-libraries/proxy",
    expect.objectContaining({
      method: "PUT",
      body: JSON.stringify({ enabled: true, upstream: "http://tgtd.local:8096", port: 8098 }),
    }),
  );
});

it("disables proxy refresh while its configuration is being saved", async () => {
  const fetch = setup();
  await screen.findByRole("checkbox", { name: "选择 周末电影" });
  let finish!: (response: Response) => void;
  fetch.mockImplementationOnce(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  );
  await fireEvent.click(screen.getByRole("button", { name: "保存反代设置" }));
  expect(screen.getByRole("button", { name: "刷新状态" })).toBeDisabled();
  finish(
    json({ config: { enabled: false, upstream: "", port: 8097 }, status: { running: false, port: null, error: null } }),
  );
  expect(await screen.findByRole("button", { name: "保存反代设置" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "刷新状态" })).toBeEnabled();
});

it("uses each pasted name in the existing picker and advances only after a successful manual add", async () => {
  const fetch = setup();
  await screen.findByRole("checkbox", { name: "选择 周末电影" });
  await fireEvent.update(screen.getByRole("textbox", { name: "影片名单" }), "周末电影\n第二个片名\n没有片源");
  await fireEvent.click(screen.getByRole("button", { name: "开始逐项选片" }));
  const search = screen.getByRole("searchbox", { name: "搜索 Emby 内容" });
  await waitFor(() => expect(search).toHaveValue("周末电影"));
  await waitFor(() => expect(screen.getByRole("checkbox", { name: "选择 周末电影" })).toBeEnabled());
  expect(fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
  await fireEvent.click(screen.getByRole("checkbox", { name: "选择 周末电影" }));
  await fireEvent.click(screen.getByRole("button", { name: "加入已选（1）" }));
  await waitFor(() => expect(search).toHaveValue("第二个片名"));
  await waitFor(() => expect(screen.getByRole("button", { name: "跳过此项" })).toBeEnabled());
  await fireEvent.click(screen.getByRole("button", { name: "跳过此项" }));
  await waitFor(() => expect(search).toHaveValue("没有片源"));
  expect(fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  const searches = fetch.mock.calls.filter(([url]) => url.includes("/source-items?"));
  expect(searches.map(([url]) => new URL(url, "http://test").searchParams.get("searchTerm"))).toEqual([
    "",
    "周末电影",
    "第二个片名",
    "没有片源",
  ]);
});

it("keeps the current queued name and selected version after the existing add API rejects it", async () => {
  setup(true);
  await screen.findByRole("checkbox", { name: "选择 周末电影" });
  await fireEvent.update(screen.getByRole("textbox", { name: "影片名单" }), "周末电影\n第二个片名");
  await fireEvent.click(screen.getByRole("button", { name: "开始逐项选片" }));
  await waitFor(() => expect(screen.getByRole("checkbox", { name: "选择 周末电影" })).toBeEnabled());
  await fireEvent.click(screen.getByRole("checkbox", { name: "选择 周末电影" }));
  await fireEvent.click(screen.getByRole("button", { name: "加入已选（1）" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("影片类型与当前媒体库不兼容");
  expect(screen.getByRole("searchbox", { name: "搜索 Emby 内容" })).toHaveValue("周末电影");
  expect(screen.getByRole("checkbox", { name: "选择 周末电影" })).toBeChecked();
});
