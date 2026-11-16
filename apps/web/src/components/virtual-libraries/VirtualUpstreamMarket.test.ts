import { cleanup, fireEvent, render, screen, within } from "@testing-library/vue";
import { afterEach, expect, it, vi } from "vitest";
import VirtualUpstreamMarket from "./VirtualUpstreamMarket.vue";
import VirtualMarketView from "./VirtualMarketView.vue";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const candidate = { sourceId: "ttd-123", name: "科幻专题", collectionType: "movies" };
const library = {
  id: "market-123",
  name: candidate.name,
  source: "tgtodrive",
  available: true,
  published: true,
  owned: false,
  canSubscribe: true,
  enabled: false,
  authorName: "系统自带",
  posterImageTag: "cover-v1",
};
const catalog = { configured: true, libraries: [], candidates: [candidate], lastSyncedAt: "2026-11-16T01:00:00Z" };

it("loads only when expanded and synchronizes and imports explicit candidate IDs", async () => {
  const fetch = vi.fn(async (_url: string, init?: RequestInit) =>
    json(
      init?.method === "POST" && _url.endsWith("/import")
        ? { ...catalog, libraries: [library], candidates: [{ ...candidate, imported: true }] }
        : catalog,
    ),
  );
  vi.stubGlobal("fetch", fetch);
  const view = render(VirtualUpstreamMarket, { props: { requireAuth: vi.fn() } });
  expect(fetch).not.toHaveBeenCalled();
  await fireEvent.click(screen.getByRole("button", { name: "管理接入" }));
  await screen.findByRole("checkbox", { name: "接入 科幻专题" });
  await fireEvent.click(screen.getByRole("button", { name: "同步来源列表" }));
  await screen.findByText("来源列表已同步，选择要接入市场的虚拟库。");
  expect(fetch.mock.calls.some(([url, init]) => url.endsWith("/upstream/sync") && init?.method === "POST")).toBe(true);
  await fireEvent.click(screen.getByRole("button", { name: "全选待接入" }));
  await fireEvent.click(screen.getByRole("button", { name: "接入选中的 1 个库" }));
  await screen.findByText("已接入 1 个虚拟库，用户现在可以在市场选择启用。");
  const imported = fetch.mock.calls.find(([url]) => url.endsWith("/import"))!;
  expect(JSON.parse(imported[1]!.body as string)).toEqual({ sourceIds: ["ttd-123"] });
  expect(screen.queryByRole("checkbox")).toBeNull();
  expect(screen.getByRole("button", { name: "下架 科幻专题" })).toBeTruthy();
  expect(view.emitted().changed).toHaveLength(2);
});

it("retains selection on import failure and prevents duplicate submission", async () => {
  let complete!: (response: Response) => void;
  const fetch = vi.fn((_url: string, init?: RequestInit) =>
    init?.method === "POST"
      ? new Promise<Response>((resolve) => {
          complete = resolve;
        })
      : Promise.resolve(json(catalog)),
  );
  vi.stubGlobal("fetch", fetch);
  render(VirtualUpstreamMarket, { props: { requireAuth: vi.fn() } });
  await fireEvent.click(screen.getByRole("button", { name: "管理接入" }));
  await fireEvent.click(await screen.findByRole("checkbox", { name: "接入 科幻专题" }));
  await fireEvent.click(screen.getByRole("button", { name: "接入选中的 1 个库" }));
  const button = screen.getByRole("button", { name: "正在接入…" });
  expect(button).toBeDisabled();
  await fireEvent.click(button);
  expect(fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  complete(json({ message: "接入暂不可用" }, 503));
  await screen.findByRole("alert");
  expect(screen.getByRole("checkbox", { name: "接入 科幻专题" })).toBeChecked();
  expect(screen.getByRole("button", { name: "接入选中的 1 个库" })).toBeEnabled();
});

it("reports missing configuration and changes publication without an upstream content write", async () => {
  const fetch = vi.fn(async (_url: string, init?: RequestInit) =>
    json(
      init?.method === "PUT"
        ? { library: { ...library, published: false } }
        : { ...catalog, configured: false, candidates: [], libraries: [library] },
    ),
  );
  vi.stubGlobal("fetch", fetch);
  render(VirtualUpstreamMarket, { props: { requireAuth: vi.fn() } });
  await fireEvent.click(screen.getByRole("button", { name: "管理接入" }));
  await screen.findByText("来源未配置");
  expect(screen.getByRole("button", { name: "同步来源列表" })).toBeDisabled();
  expect(screen.getByText(/请先检查反代上游/)).toBeTruthy();
  await fireEvent.click(screen.getByRole("button", { name: "下架 科幻专题" }));
  await screen.findByText(/已下架，重新上架后需用户再次启用/);
  expect(JSON.parse(fetch.mock.calls.find(([, init]) => init?.method === "PUT")![1]!.body as string)).toEqual({
    published: false,
  });
});

it("shows source and author maintenance in the subscriber market without administrator import controls", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => json({ libraries: [library] })),
  );
  render(VirtualMarketView, { props: { personal: true, requireAuth: vi.fn() } });
  const card = await screen.findByRole("article", { name: candidate.name });
  expect(within(card).getByText("系统自带媒体库，内容、名称和海报更新后同步展示。")).toBeTruthy();
  expect(within(card).getByRole("img")).toHaveAttribute(
    "src",
    "/api/public/virtual-library-market/market-123/poster?tag=cover-v1",
  );
  expect(within(card).getByRole("button", { name: "启用媒体库" })).toBeEnabled();
  expect(screen.queryByRole("button", { name: "管理接入" })).toBeNull();
});
