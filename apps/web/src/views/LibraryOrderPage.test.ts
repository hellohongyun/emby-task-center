import { cleanup, fireEvent, render, screen, within } from "@testing-library/vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryHistory, createRouter, RouterView } from "vue-router";

import LibraryOrderPage from "./LibraryOrderPage.vue";

const endpoint = "/api/emby/library-order";
const proxyReady = { proxyConfigured: true, proxyEnabled: true, proxyRunning: true };
const catalog = {
  libraries: [
    { id: "a", name: "电影", kind: "native", visibleUsers: 2, inOrderedViews: true, direct: true },
    { id: "b", name: "剧集", kind: "native", visibleUsers: 2, inOrderedViews: true, direct: true },
    { id: "c", name: "上层库", kind: "virtual", visibleUsers: 1, inOrderedViews: false, direct: true },
    { id: "d", name: "虚拟动画", kind: "owned", visibleUsers: 2, inOrderedViews: false, direct: false },
  ],
  order: ["a", "b", "c", "d"],
  saved: false,
  active: false,
  activeOrder: [],
  updatedAt: null,
  users: [
    { id: "admin", name: "管理员", isAdministrator: true, isDisabled: false },
    { id: "member", name: "会员", isAdministrator: false, isDisabled: false },
  ],
  warnings: ["1 个非原生媒体库不在 Emby Library/VirtualFolders 中，写入 OrderedViews 后可能不生效。"],
  proxy: { configured: true, enabled: true, running: true, port: 8097, upstream: "https://proxy.test" },
};
const preview = {
  previewToken: "preview-1",
  libraries: ["剧集", "虚拟动画", "电影", "上层库"],
  proxyChanged: true,
  ...proxyReady,
  users: [
    {
      id: "admin",
      name: "管理员",
      isAdministrator: true,
      isDisabled: false,
      status: "change",
      before: ["电影", "剧集", "上层库"],
      after: ["剧集", "电影", "上层库"],
      proxyBefore: ["电影", "剧集", "上层库", "虚拟动画"],
      proxyAfter: ["剧集", "虚拟动画", "电影", "上层库"],
    },
    {
      id: "member",
      name: "会员",
      isAdministrator: false,
      isDisabled: false,
      status: "change",
      before: ["电影", "剧集"],
      after: ["剧集", "电影"],
      proxyBefore: ["电影", "剧集", "虚拟动画"],
      proxyAfter: ["剧集", "虚拟动画", "电影"],
    },
  ],
  warnings: [],
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

function stub(fetchImpl: typeof fetch) {
  const mock = vi.fn(fetchImpl);
  vi.stubGlobal("fetch", mock);
  return mock;
}

function savedBody(order: string[]) {
  return {
    order,
    updatedAt: "2026-11-08T00:00:00.000Z",
    libraries: order.map((id) => catalog.libraries.find((library) => library.id === id)!),
  };
}

async function renderPage() {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: "/", component: LibraryOrderPage }],
  });
  await router.push("/");
  return render(RouterView, { global: { plugins: [router] } });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("LibraryOrderPage", () => {
  it("saves the manual order, previews all accounts, and applies after confirmation", async () => {
    const fetchMock = stub(async (input, init) => {
      if (input === endpoint && !init?.method) return json(catalog);
      if (input === endpoint && init?.method === "PUT") {
        const body = JSON.parse(String(init.body));
        return json(savedBody(body.order));
      }
      if (input === `${endpoint}/preview`) {
        const [admin, member] = preview.users;
        return json({
          ...preview,
          users: [
            admin,
            {
              ...member,
              proxyBefore: undefined,
              proxyAfter: undefined,
              proxyReason: "library_order_proxy_read_failed",
            },
          ],
        });
      }
      if (input === `${endpoint}/apply`) {
        return json({
          ...proxyReady,
          order: ["b", "d", "a", "c"],
          proxyActivated: true,
          users: [
            { id: "admin", name: "管理员", isAdministrator: true, isDisabled: false, status: "updated" },
            {
              id: "member",
              name: "会员",
              isAdministrator: false,
              isDisabled: false,
              status: "failed",
              reason: "library_order_verify_failed",
            },
          ],
        });
      }
      throw new Error(`unexpected request ${input}`);
    });

    await renderPage();
    expect(await screen.findByRole("heading", { name: "全部媒体库" })).toBeInTheDocument();
    expect(screen.getByText(/4 个库/)).toBeInTheDocument();
    expect(screen.getByText("本项目虚拟库")).toBeInTheDocument();
    expect(screen.getByText("反代已启用，但尚未确认管理员顺序。")).toBeInTheDocument();
    expect(screen.queryByText("有未保存修改")).not.toBeInTheDocument();
    expect(
      screen.getByText("1 个非原生媒体库不在 Emby Library/VirtualFolders 中，写入 OrderedViews 后可能不生效。"),
    ).toBeInTheDocument();

    await fireEvent.click(await screen.findByRole("button", { name: "下移 电影" }));
    expect(screen.getByText("有未保存修改")).toBeInTheDocument();
    await fireEvent.click(screen.getByRole("button", { name: "撤销修改" }));
    expect(screen.queryByText("有未保存修改")).not.toBeInTheDocument();
    await fireEvent.click(screen.getByRole("button", { name: "下移 电影" }));
    await fireEvent.click(screen.getByRole("button", { name: "上移 虚拟动画" }));
    await fireEvent.click(screen.getByRole("button", { name: "上移 虚拟动画" }));
    await fireEvent.click(screen.getByRole("button", { name: "保存并预览" }));
    expect(await screen.findByRole("heading", { name: "同步预览" })).toBeInTheDocument();
    expect(fetchMock.mock.calls.map(([url, init]) => [url, init?.method])).toEqual([
      [endpoint, undefined],
      [endpoint, "PUT"],
      [`${endpoint}/preview`, "POST"],
    ]);
    expect(JSON.parse(String(fetchMock.mock.calls[1]![1]!.body))).toEqual({ order: ["b", "d", "a", "c"] });
    expect(JSON.parse(String(fetchMock.mock.calls[2]![1]!.body))).toEqual({});
    expect(screen.getByText(/预览 2 个原生 Emby 账号/)).toBeInTheDocument();
    const [native] = screen.getAllByText("直连原生 Emby");
    const proxy = screen.getByText("虚拟库反代（估算）");
    expect(screen.getByText(/读取反代上游的媒体库失败/)).toBeInTheDocument();
    expect(within(native!.parentElement!).queryByText("虚拟动画")).not.toBeInTheDocument();
    expect(within(proxy.parentElement!).getAllByText("虚拟动画")).toHaveLength(2);

    await fireEvent.click(screen.getByRole("button", { name: "确认同步 2 个账号" }));
    expect(await screen.findByRole("heading", { name: "同步结果" })).toBeInTheDocument();
    expect(screen.getByText("已同步 1")).toBeInTheDocument();
    expect(screen.getByText("失败 1")).toBeInTheDocument();
    expect(screen.getByText("反代正在使用此顺序。")).toBeInTheDocument();
    expect(JSON.parse(String(fetchMock.mock.calls[3]![1]!.body))).toEqual({ previewToken: "preview-1" });
  });

  it("can preview a single test account before applying to everyone", async () => {
    const fetchMock = stub(async (input, init) => {
      if (input === endpoint && !init?.method) return json(catalog);
      if (input === endpoint && init?.method === "PUT") return json(savedBody(catalog.order));
      if (input === `${endpoint}/preview`) {
        return json({ ...preview, proxyChanged: false, users: [{ ...preview.users[1], proxyAfter: undefined }] });
      }
      if (input === `${endpoint}/apply`) {
        return json({
          ...proxyReady,
          order: catalog.order,
          proxyActivated: false,
          users: [{ ...catalog.users[1], status: "updated" }],
        });
      }
      throw new Error(`unexpected request ${input}`);
    });
    await renderPage();
    await screen.findByRole("heading", { name: "全部媒体库" });
    await fireEvent.update(screen.getByRole("combobox", { name: "账号" }), "one");
    await fireEvent.update(await screen.findByRole("combobox", { name: "测试账号" }), "member");
    await fireEvent.click(screen.getByRole("button", { name: "保存并预览" }));
    await screen.findByRole("heading", { name: "同步预览" });
    const lastCall = fetchMock.mock.calls[fetchMock.mock.calls.length - 1]!;
    expect(JSON.parse(String(lastCall[1]!.body))).toEqual({ userIds: ["member"] });
    expect(screen.queryByText("虚拟库反代（估算）")).not.toBeInTheDocument();
    expect(screen.getByText("仅测试直连 Emby，反代继续使用当前设置。")).toBeInTheDocument();
    await fireEvent.click(screen.getByRole("button", { name: "确认同步 1 个账号" }));
    expect(await screen.findByText("本次为直连测试。反代继续使用当前设置。")).toBeInTheDocument();
    expect(screen.getByText("反代已启用，但尚未确认管理员顺序。")).toBeInTheDocument();
  });

  it("filters the visible list and disables reordering while searching", async () => {
    stub(async (input, init) => {
      if (input === endpoint && !init?.method) return json(catalog);
      throw new Error(`unexpected request ${input}`);
    });
    const view = await renderPage();
    await screen.findByRole("heading", { name: "全部媒体库" });
    const search = screen.getByRole("searchbox", { name: "搜索媒体库" });
    await fireEvent.update(search, "虚拟");
    expect(view.container.querySelectorAll(".library-list > li")).toHaveLength(1);
    expect(screen.getByText("虚拟动画")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "下移 电影" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "上移 虚拟动画" })).toBeDisabled();
    await fireEvent.update(search, "");
    expect(view.container.querySelectorAll(".library-list > li")).toHaveLength(4);
  });

  it("can preview a direct test and refresh when a partial catalog differs from the saved order", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockResolvedValueOnce(
      json({
        ...catalog,
        saved: true,
        savedOrder: catalog.order,
        order: ["a", "b", "d"],
        libraries: catalog.libraries.filter(({ id }) => id !== "c"),
      }),
    );
    fetchMock.mockResolvedValueOnce(json({ ...preview, proxyChanged: false, users: [preview.users[0]] }));
    fetchMock.mockResolvedValueOnce(json({ ...catalog, saved: true, savedOrder: catalog.order }));
    vi.stubGlobal("fetch", fetchMock);

    await renderPage();
    expect(await screen.findByText("媒体库目录已变化")).toBeInTheDocument();
    await fireEvent.update(screen.getByRole("combobox", { name: "账号" }), "one");
    await fireEvent.click(screen.getByRole("button", { name: "保存并预览" }));
    expect(await screen.findByRole("heading", { name: "同步预览" })).toBeInTheDocument();
    await fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    expect(await screen.findByText("上层库")).toBeInTheDocument();
    expect(fetchMock.mock.calls.map(([url, init]) => [url, init?.method])).toEqual([
      [endpoint, undefined],
      [`${endpoint}/preview`, "POST"],
      [endpoint, undefined],
    ]);
  });

  it("does not offer apply when every selected account already matches", async () => {
    stub(async (input, init) => {
      if (input === endpoint && !init?.method) {
        return json({ ...catalog, saved: true, savedOrder: catalog.order, active: true, activeOrder: catalog.order });
      }
      if (input === `${endpoint}/preview`)
        return json({
          ...preview,
          proxyChanged: false,
          users: preview.users.map((user) => ({ ...user, status: "unchanged", before: user.after, after: user.after })),
        });
      throw new Error(`unexpected request ${input}`);
    });
    await renderPage();
    await screen.findByRole("heading", { name: "全部媒体库" });
    await fireEvent.click(screen.getByRole("button", { name: "保存并预览" }));
    await screen.findByRole("heading", { name: "同步预览" });
    expect(screen.getByRole("button", { name: "无需同步" })).toBeDisabled();
    expect(screen.getByText("顺序一致 2")).toBeInTheDocument();
    expect(screen.getByText("本项目反代已使用此顺序。")).toBeInTheDocument();
  });

  it.each([
    [true, true, undefined, "确认后，本项目反代将使用此顺序。", "本项目反代正在使用已确认的顺序。"],
    [
      false,
      false,
      "library_order_proxy_disabled",
      "确认后会保存反代顺序。本项目反代尚未启用。",
      "反代顺序已确认。启用本项目反代后，可通过该入口查看新顺序。",
    ],
    [
      true,
      false,
      "library_order_proxy_not_running",
      "确认后会保存反代顺序。本项目反代尚未监听。",
      "反代顺序已确认。请检查本项目反代的监听状态。",
    ],
  ])(
    "reports a confirmed proxy-only change with enabled=%s and running=%s",
    async (enabled, running, reason, previewMessage, resultMessage) => {
      const draft = ["a", "d", "b", "c"];
      const proxy = { ...proxyReady, proxyEnabled: enabled, proxyRunning: running };
      const fetchMock = stub(async (input, init) => {
        if (input === endpoint && !init?.method) {
          return json({
            ...catalog,
            saved: true,
            order: draft,
            savedOrder: draft,
            active: true,
            activeOrder: catalog.order,
          });
        }
        if (input === `${endpoint}/preview`) {
          return json({
            ...preview,
            ...proxy,
            libraries: ["电影", "虚拟动画", "剧集", "上层库"],
            users: preview.users.map((user) => ({
              ...user,
              status: "unchanged",
              after: user.before,
              proxyAfter: ["电影", "虚拟动画", ...user.before.slice(1)],
            })),
          });
        }
        if (input === `${endpoint}/apply`) {
          return json({
            ...proxy,
            order: draft,
            proxyActivated: true,
            proxyReason: reason,
            users: catalog.users.map((user) => ({ ...user, status: "unchanged" })),
          });
        }
        throw new Error(`unexpected request ${input}`);
      });

      await renderPage();
      expect(await screen.findByText("反代当前使用上次确认的顺序。")).toBeInTheDocument();
      await fireEvent.click(screen.getByRole("button", { name: "保存并预览" }));
      expect(await screen.findByText(previewMessage)).toBeInTheDocument();
      await fireEvent.click(await screen.findByRole("button", { name: "确认反代顺序" }));
      expect(await screen.findByText(resultMessage)).toBeInTheDocument();
      expect(screen.getByText("顺序一致 2")).toBeInTheDocument();
      expect(fetchMock.mock.calls.map(([url, init]) => [url, init?.method])).toEqual([
        [endpoint, undefined],
        [`${endpoint}/preview`, "POST"],
        [`${endpoint}/apply`, "POST"],
      ]);
    },
  );
});
