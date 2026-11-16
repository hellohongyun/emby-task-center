import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import VirtualMarketView from "./VirtualMarketView.vue";
import VirtualLibraryPublication from "./VirtualLibraryPublication.vue";
import PersonalLibraryOrder from "./PersonalLibraryOrder.vue";
import VirtualUserLibraries from "./VirtualUserLibraries.vue";
import VirtualMarketDefaults from "./VirtualMarketDefaults.vue";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const library = {
  id: "shared",
  name: "精选",
  collectionType: "mixed",
  sortOrder: 0,
  itemCount: 3,
  createdAt: "",
  updatedAt: "",
  published: true,
  authorName: "作者",
  owned: false,
  enabled: false,
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
describe("market views use real API contracts", () => {
  it("enables another author's library without offering editing or publishing controls", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json({ libraries: [library] }))
      .mockResolvedValueOnce(json({ enabled: true }));
    vi.stubGlobal("fetch", fetch);
    render(VirtualMarketView, { props: { personal: true, requireAuth: vi.fn() } });
    await fireEvent.click(await screen.findByRole("button", { name: "启用媒体库" }));
    await screen.findByRole("button", { name: "关闭媒体库" });
    expect(fetch.mock.calls[1]![0]).toBe("/api/public/virtual-library-market/shared/subscription");
    expect(JSON.parse(fetch.mock.calls[1]![1].body)).toEqual({ enabled: true });
    expect(screen.queryByRole("button", { name: "编辑媒体库" })).toBeNull();
    expect(screen.queryByText("3 项内容")).toBeNull();
  });
  it("keeps the owner library distinct and does not let the owner subscribe twice", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ libraries: [{ ...library, owned: true }] })));
    render(VirtualMarketView, { props: { personal: true, requireAuth: vi.fn() } });
    await screen.findByText(/自己创建的库始终可见/);
    expect(screen.queryByRole("button", { name: "启用媒体库" })).toBeNull();
  });
  it("publishes the same library through the owner endpoint", async () => {
    // Publication permission comes from the current role's own-library endpoint.
    const fetch = vi.fn().mockResolvedValue(json({ library: { ...library, published: false } }));
    vi.stubGlobal("fetch", fetch);
    const view = render(VirtualLibraryPublication, {
      props: { library: library as never, personal: true, requireAuth: vi.fn() },
    });
    await fireEvent.click(screen.getByRole("button", { name: "下架市场" }));
    await waitFor(() => expect(view.emitted().saved).toHaveLength(1));
    expect(fetch.mock.calls[0]![0]).toBe("/api/public/virtual-library-market/owned/shared/publication");
    expect(JSON.parse(fetch.mock.calls[0]![1].body)).toEqual({ published: false });
  });
  it("does not offer subscription switches for another role's library owned by the same player account", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(json({ libraries: [{ ...library, owned: false, canSubscribe: false }] })),
    );
    render(VirtualMarketView, { props: { requireAuth: vi.fn() } });
    await screen.findByText("当前账号自有媒体库，始终可见。");
    expect(screen.queryByRole("button", { name: "启用媒体库" })).toBeNull();
    expect(screen.queryByRole("button", { name: "关闭媒体库" })).toBeNull();
  });
  it("moves owned libraries after native libraries and persists only the personal order", async () => {
    const items = [
      { id: "mine", name: "私人", kind: "owned" },
      { id: "native", name: "电影", kind: "native" },
    ];
    const fetch = vi
      .fn()
      .mockImplementation(async () => json({ items, order: ["mine", "native"], hasPersonalOrder: true }));
    vi.stubGlobal("fetch", fetch);
    render(PersonalLibraryOrder, { props: { personal: true, requireAuth: vi.fn() } });
    await fireEvent.click(await screen.findByRole("button", { name: "下移 私人" }));
    await fireEvent.click(screen.getByRole("button", { name: "保存顺序" }));
    await waitFor(() =>
      expect(
        fetch.mock.calls.some(([url, init]) => url === "/api/public/virtual-library-order" && init.method === "PUT"),
      ).toBe(true),
    );
    expect(JSON.parse(fetch.mock.calls.find(([, init]) => init.method === "PUT")![1].body)).toEqual({
      order: ["native", "mine"],
    });
  });
  it("restores personal defaults without sending subscription changes", async () => {
    const fetch = vi.fn().mockImplementation(async () => json({ items: [], order: [], hasPersonalOrder: false }));
    vi.stubGlobal("fetch", fetch);
    render(PersonalLibraryOrder, { props: { personal: true, requireAuth: vi.fn() } });
    await waitFor(() => expect(screen.getByRole("button", { name: "恢复默认" }).hasAttribute("disabled")).toBe(false));
    await fireEvent.click(screen.getByRole("button", { name: "恢复默认" }));
    await screen.findByText(/已恢复默认/);
    expect(fetch.mock.calls.find(([, init]) => init.method === "DELETE")![0]).toBe("/api/public/virtual-library-order");
    expect(fetch.mock.calls.every(([url]) => !String(url).includes("subscription"))).toBe(true);
  });
  it("shows admin user-library content read-only", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(json({ libraries: [{ ...library, ownerEmail: "member@example.com" }] }))
        .mockResolvedValueOnce(
          json({ items: [{ itemId: "film", name: "影片", year: 2026, type: "Movie", imageTag: null }] }),
        ),
    );
    render(VirtualUserLibraries, { props: { requireAuth: vi.fn() } });
    await screen.findByRole("button", { name: /精选 member@example.com/ });
    await screen.findByRole("heading", { name: "影片" });
    expect(screen.getByText("2026", { exact: true })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^(删除|编辑|上架|下架)/ })).toBeNull();
  });
  it("saves only new-user defaults without changing the player binding", async () => {
    const fetch = vi.fn(async (url: string, init?: RequestInit) =>
      json(
        init?.method === "PATCH"
          ? { libraryIds: ["shared"], adminEmbyUserId: "admin-id" }
          : url.endsWith("/defaults")
            ? { libraryIds: [], adminEmbyUserId: "admin-id" }
            : { libraries: [library] },
      ),
    );
    vi.stubGlobal("fetch", fetch);
    render(VirtualMarketDefaults, { props: { requireAuth: vi.fn() } });
    await fireEvent.click(await screen.findByRole("checkbox", { name: "精选" }));
    expect(screen.queryByRole("combobox")).toBeNull();
    await fireEvent.click(screen.getByRole("button", { name: "保存默认设置" }));
    await waitFor(() =>
      expect(fetch.mock.calls.some(([, init]) => (init as RequestInit)?.method === "PATCH")).toBe(true),
    );
    const call = fetch.mock.calls.find(([, init]) => (init as RequestInit)?.method === "PATCH")!;
    expect(JSON.parse((call[1] as RequestInit).body as string)).toEqual({
      libraryIds: ["shared"],
    });
  });
  it("does not overwrite defaults when their initial read fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.endsWith("/defaults")
          ? json({ error: "unavailable" }, 500)
          : json(url.endsWith("/users") ? { users: [] } : { libraries: [library] }),
      ),
    );
    render(VirtualMarketDefaults, { props: { requireAuth: vi.fn() } });
    await screen.findByRole("alert");
    expect(screen.getByRole("button", { name: "保存默认设置" }).hasAttribute("disabled")).toBe(true);
  });
  it("allows saving defaults after a formerly selected library is no longer available", async () => {
    const fetch = vi.fn(async (url: string, _init?: RequestInit) =>
      json(
        url.endsWith("/defaults")
          ? { libraryIds: ["shared", "off-shelf"], adminEmbyUserId: null }
          : url.endsWith("/users")
            ? { users: [] }
            : { libraries: [library] },
      ),
    );
    vi.stubGlobal("fetch", fetch);
    render(VirtualMarketDefaults, { props: { requireAuth: vi.fn() } });
    await screen.findByRole("checkbox", { name: "精选" });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "保存默认设置" }).hasAttribute("disabled")).toBe(false),
    );
    await fireEvent.click(screen.getByRole("button", { name: "保存默认设置" }));
    await waitFor(() => expect(fetch.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(true));
    expect(
      JSON.parse(fetch.mock.calls.find(([, init]) => init?.method === "PATCH")![1]!.body as string).libraryIds,
    ).toEqual(["shared"]);
  });
  it("aborts pending market requests on unmount", async () => {
    let signal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((_url, init) => {
        signal = init.signal;
        return new Promise(() => undefined);
      }),
    );
    const view = render(VirtualMarketView, { props: { personal: true, requireAuth: vi.fn() } });
    view.unmount();
    expect(signal?.aborted).toBe(true);
  });
});
