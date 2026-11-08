import { expect, test } from "@playwright/test";
import { orderViews, startLibraryOrderUpstreams } from "./library-order-fixture";
import { freePort, startIsolatedServer } from "./real-server";

const endpoint = "/api/emby/library-order";
const proxySettings = "/api/virtual-libraries/proxy";
const settingsQuery = "IncludeHidden=true&AllowDynamicChildren=false";
const ownedName = "联动自建虚拟库";
const { movies, series, injected, hidden } = orderViews;

test("admin browser order flows through native Emby and the final TgtoDrive proxy", async ({ browser }) => {
  const upstreams = startLibraryOrderUpstreams();
  const ttd = await upstreams.open(true);
  try {
    const app = await startIsolatedServer({
      startUpstream: () => upstreams.open(false),
      additionalUpstreams: [ttd.baseURL],
    });
    try {
      const port = await freePort();
      const proxy = `http://127.0.0.1:${port}`;
      const context = await browser.newContext({ baseURL: app.baseURL, viewport: { width: 1440, height: 900 } });
      const external: string[] = [];
      await context.route("**/*", (route) => {
        const url = new URL(route.request().url());
        if (url.origin === app.baseURL || !["http:", "https:"].includes(url.protocol)) return route.continue();
        external.push(url.origin + url.pathname);
        return route.abort();
      });
      try {
        const api = context.request;
        const page = await context.newPage();
        await page.goto("/login/library-order");
        await page.getByLabel("管理员账号").fill("admin");
        await page.getByLabel("管理员口令").fill("admin123");
        await page.getByRole("button", { name: "进入任务中心" }).click();
        await expect(page.getByRole("heading", { name: "媒体库顺序", exact: true })).toBeVisible();

        const config = { enabled: true, upstream: ttd.baseURL, port };
        const startProxy = await api.put(proxySettings, { data: config });
        expect(await startProxy.json()).toMatchObject({ status: { running: true, port } });
        const created = await api.post("/api/virtual-libraries", { data: { name: ownedName } });
        expect(created.status()).toBe(201);
        const catalog = async () => {
          const response = await api.get(endpoint);
          expect(response.status()).toBe(200);
          return response.json();
        };
        const owned = (await catalog()).libraries.find((library: { name: string }) => library.name === ownedName).id;
        const member = upstreams.preferences.get("order-member")!;
        member.MyMediaExcludes.push(owned);

        const views = async (base: string, user = "order-member", query = settingsQuery) => {
          const response = await api.get(`${base}/emby/Users/${user}/Views?${query}`, {
            headers: { "X-Emby-Token": `${user}-token` },
          });
          expect(response.status()).toBe(200);
          return (await response.json()) as { Items: Array<{ Id: string; Name: string }>; TotalRecordCount: number };
        };
        const ids = (reply: Awaited<ReturnType<typeof views>>) => reply.Items.map(({ Id }) => Id);
        const initialProxy = [injected.Id, movies.Id, series.Id, hidden.Id, owned];
        expect(ids(await views(proxy))).toEqual(initialProxy);
        await page.reload();
        const names = page.locator(".library-list .library-meta strong");
        await expect(names).toHaveText([injected.Name, movies.Name, series.Name, hidden.Name, ownedName]);
        const toTop = async (name: string) => {
          await page
            .locator(".library-list > li")
            .filter({ hasText: name })
            .getByRole("button", { name: "置顶" })
            .click();
        };
        await toTop(ownedName);
        await toTop(series.Name);
        const expectedNames = [series.Name, ownedName, injected.Name, movies.Name, hidden.Name];
        await expect(names).toHaveText(expectedNames);

        const scope = page.getByRole("combobox", { name: "账号", exact: true });
        await scope.selectOption("one");
        await page.getByRole("combobox", { name: "测试账号", exact: true }).selectOption("order-member");
        const preview = page.getByRole("button", { name: "保存并预览" });
        await preview.click();
        await expect(page.getByText("仅测试直连 Emby，反代继续使用当前设置。", { exact: true })).toBeVisible();
        expect(upstreams.writes).toEqual([]);
        expect(ids(await views(proxy))).toEqual(initialProxy);
        await page.getByRole("button", { name: "确认同步 1 个账号" }).click();
        await expect(page.getByRole("heading", { name: "同步结果" })).toBeVisible();
        expect(upstreams.writes).toEqual([
          { id: "order-member", viaTgtoDrive: false, body: { OrderedViews: [series.Guid, movies.Guid, hidden.Guid] } },
        ]);
        expect((await catalog()).active).toBe(false);
        expect(ids(await views(app.fixture.baseURL))).toEqual([series.Id, movies.Id, hidden.Id]);
        expect(ids(await views(proxy))).toEqual([injected.Id, series.Id, movies.Id, hidden.Id, owned]);

        await scope.selectOption("all");
        await preview.click();
        const memberPreview = page.locator(".preview-list > li").filter({ hasText: "排序会员" });
        await memberPreview.getByText("虚拟库反代（估算）", { exact: true }).click();
        await expect(memberPreview.locator(".comparison > div").last().locator("li")).toHaveText(expectedNames);
        expect(upstreams.writes).toHaveLength(1);
        await page.getByRole("button", { name: "确认同步 1 个账号" }).click();
        await expect(page.getByText("本项目反代正在使用已确认的顺序。", { exact: true })).toBeVisible();
        expect(upstreams.writes).toEqual([
          { id: "order-member", viaTgtoDrive: false, body: { OrderedViews: [series.Guid, movies.Guid, hidden.Guid] } },
          { id: "order-admin", viaTgtoDrive: false, body: { OrderedViews: [series.Guid, movies.Guid, hidden.Guid] } },
        ]);
        expect(member).toMatchObject({ AudioLanguagePreference: "zho", MyMediaExcludes: [hidden.Guid, owned] });
        const expected = [series.Id, owned, injected.Id, movies.Id, hidden.Id];
        expect(ids(await views(proxy))).toEqual(expected);
        expect(ids(await views(ttd.baseURL))).toEqual([injected.Id, series.Id, movies.Id, hidden.Id]);
        expect(ids(await views(proxy, "order-member", "AllowDynamicChildren=false"))).toEqual([
          series.Id,
          injected.Id,
          movies.Id,
        ]);
        expect(ids(await views(proxy, "order-limited"))).toEqual([owned, injected.Id, movies.Id]);
        const paged = await views(proxy, "order-member", `${settingsQuery}&StartIndex=1&Limit=2`);
        expect({ ids: ids(paged), total: paged.TotalRecordCount }).toEqual({ ids: [owned, injected.Id], total: 5 });
        expect((await api.get(`${proxy}/emby/Users/order-member/Views?${settingsQuery}`)).status()).toBe(401);

        const active = await catalog();
        upstreams.setTgtoDriveFailure(true);
        await page.getByRole("button", { name: "刷新", exact: true }).click();
        await expect(page.getByText("媒体库目录已变化", { exact: true })).toBeVisible();
        await preview.click();
        await expect(page.getByRole("alert")).toContainText("读取反代上游的媒体库失败");
        expect(await catalog()).toMatchObject({ savedOrder: active.savedOrder, activeOrder: active.activeOrder });
        expect(upstreams.writes).toHaveLength(2);
        upstreams.setTgtoDriveFailure(false);

        await app.restart();
        await expect
          .poll(async () => (await (await api.get(proxySettings)).json()).status)
          .toMatchObject({ running: true, port });
        expect(await catalog()).toMatchObject({ savedOrder: active.savedOrder, activeOrder: active.activeOrder });
        expect(ids(await views(proxy))).toEqual(expected);
        await page.setViewportSize({ width: 390, height: 844 });
        await page.reload();
        await expect(names).toHaveText(expectedNames);
        await expect(page.getByText("反代正在使用此顺序。", { exact: true })).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
        expect(app.blockedRequests()).toEqual([]);
        expect(external).toEqual([]);
      } finally {
        await context.close();
      }
    } finally {
      await app.close();
    }
  } finally {
    await ttd.close();
  }
});
