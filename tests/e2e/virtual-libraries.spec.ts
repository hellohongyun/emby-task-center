import { createServer } from "node:net";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { startIsolatedServer } from "./real-server";

async function freePort() {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const address = probe.address();
  if (!address || typeof address === "string") throw new Error("fixture_port_missing");
  await new Promise<void>((resolve, reject) => probe.close((error) => (error ? reject(error) : resolve())));
  return address.port;
}

test("virtual libraries persist mappings and appear beside original Emby libraries through the real proxy", async ({
  browser,
}) => {
  const application = await startIsolatedServer();
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const externalRequests: string[] = [];
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (["http:", "https:"].includes(url.protocol) && url.origin !== application.baseURL) {
      externalRequests.push(url.origin + url.pathname);
      await route.abort();
    } else await route.continue();
  });
  try {
    const page = await context.newPage();
    await page.goto(`${application.baseURL}/login/virtual-libraries`);
    await page.getByLabel("管理员账号").fill("admin");
    await page.getByLabel("管理员口令").fill("admin123");
    await page.getByRole("button", { name: "进入任务中心" }).click();
    await expect(page.getByRole("heading", { name: "虚拟媒体库", exact: true })).toBeVisible();
    await expect(page.getByRole("checkbox", { name: "启用客户端反代" })).not.toBeChecked();
    const initialProxy = await context.request.get(`${application.baseURL}/api/virtual-libraries/proxy`);
    expect(await initialProxy.json()).toMatchObject({ config: { enabled: false }, status: { running: false } });
    const sourceLibraries = await context.request.get(`${application.baseURL}/api/virtual-libraries/source-libraries`);
    expect((await sourceLibraries.json()).items).toEqual([{ id: "fixture-movies", name: "隔离测试电影库" }]);

    await page.getByRole("button", { name: "＋ 新建虚拟媒体库" }).click();
    await page.getByLabel("媒体库名称").fill("隔离虚拟精选");
    await page.getByLabel("显示类型").selectOption("mixed");
    await page.getByLabel("排序", { exact: true }).fill("-1");
    await page.getByRole("button", { name: "保存媒体库", exact: true }).click();
    await expect(page.getByRole("button", { name: /隔离虚拟精选 混合/ })).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("combobox", { name: "源媒体库", exact: true }).selectOption("fixture-movies");
    await page.getByLabel("搜索 Emby 内容").fill("隔离测试电影");
    await page.getByRole("button", { name: "搜索", exact: true }).click();
    await page.getByRole("checkbox", { name: "选择 隔离测试电影", exact: true }).check();
    await page.getByRole("button", { name: "加入已选（1）" }).click();
    const mapped = page.getByRole("region", { name: "已加入的内容" });
    await expect(mapped.getByText("隔离测试电影", { exact: true })).toBeVisible();
    await page.reload();
    await expect(mapped.getByText("隔离测试电影", { exact: true })).toBeVisible();

    const librariesResponse = await context.request.get(`${application.baseURL}/api/virtual-libraries`);
    const libraries = (await librariesResponse.json()).libraries as Array<{
      id: string;
      name: string;
      itemCount: number;
    }>;
    const library = libraries.find((item) => item.name === "隔离虚拟精选")!;
    expect(library.itemCount).toBe(1);
    const incompatibleChange = await context.request.patch(
      `${application.baseURL}/api/virtual-libraries/${library.id}`,
      {
        data: { collectionType: "tvshows" },
      },
    );
    expect(incompatibleChange.status()).toBe(400);
    expect(await incompatibleChange.json()).toMatchObject({ error: "virtual_library_type_mismatch" });
    const protectedItems = await context.request.get(
      `${application.baseURL}/api/virtual-libraries/${library.id}/items`,
    );
    expect((await protectedItems.json()).items).toEqual([expect.objectContaining({ itemId: "fixture-movie" })]);
    await page.getByRole("button", { name: "编辑媒体库", exact: true }).click();
    await page.getByLabel("显示类型").selectOption("tvshows");
    const form = page.locator(".vl-library-form");
    await expect(form.getByRole("button", { name: "保存媒体库", exact: true })).toBeDisabled();
    await expect(form.getByRole("alert")).toContainText("混合");
    await page.getByLabel("显示类型").selectOption("mixed");
    await expect(form.getByRole("button", { name: "保存媒体库", exact: true })).toBeEnabled();
    await form.getByRole("button", { name: "取消", exact: true }).click();
    const port = await freePort();
    await page.getByRole("textbox", { name: /TgtoDrive 的 Emby 反代地址/ }).fill(application.fixture.baseURL);
    await page.getByLabel("监听端口").fill(String(port));
    await page.getByRole("checkbox", { name: "启用客户端反代" }).check();
    await page.getByRole("button", { name: "保存反代设置" }).click();
    await expect(page.getByText(`http://127.0.0.1:${port}`, { exact: true })).toBeVisible();

    const proxy = `http://127.0.0.1:${port}`;
    const views = await context.request.get(`${proxy}/Users/fixture-user/Views`, {
      headers: { "X-Emby-Token": "local-fixture-only" },
    });
    expect(views.status()).toBe(200);
    const viewItems = (await views.json()).Items as Array<{ Id: string; Name: string }>;
    expect(viewItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ Id: "fixture-movies", Name: "隔离测试电影库" }),
        expect.objectContaining({ Id: library.id, Name: "隔离虚拟精选" }),
      ]),
    );
    const scopedUrl = `${proxy}/Users/fixture-user/Items?ParentId=${encodeURIComponent(library.id)}&Recursive=true`;
    const scoped = await context.request.get(scopedUrl);
    expect(scoped.status()).toBe(200);
    expect((await scoped.json()).Items).toEqual([
      expect.objectContaining({ Id: "fixture-movie", Name: "隔离测试电影" }),
    ]);
    // This preview contains only the isolated local fixture, never a user's real library.
    await page.screenshot({ path: resolve(".local/virtual-libraries-mvp.png"), fullPage: true });

    const typed = await context.request.post(`${application.baseURL}/api/virtual-libraries`, {
      data: { name: "隔离剧集库", collectionType: "tvshows" },
    });
    expect(typed.status()).toBe(201);
    await page.reload();
    await page.getByRole("button", { name: /隔离剧集库 剧集/ }).click();
    await page.getByRole("combobox", { name: "源媒体库", exact: true }).selectOption("fixture-movies");
    const movieCheckbox = page.getByRole("checkbox", { name: "选择 隔离测试电影", exact: true });
    await expect(movieCheckbox).toBeDisabled();
    await expect(
      page
        .getByRole("region", { name: "从 Emby 选择内容" })
        .getByText("剧集库只允许加入整部剧；需要加入电影时，请改为混合库。", { exact: true }),
    ).toBeVisible();
    await page.screenshot({ path: resolve(".local/virtual-library-type-guard.png"), fullPage: true });
    await page.getByRole("button", { name: /隔离虚拟精选 混合/ }).click();

    await mapped.getByRole("button", { name: "从虚拟库移除 隔离测试电影" }).click();
    await expect(mapped.getByText(/还没有内容/)).toBeVisible();
    const removed = await context.request.get(scopedUrl);
    expect((await removed.json()).Items).toEqual([]);
    const original = await context.request.get(`${application.fixture.baseURL}/Items?Ids=fixture-movie`);
    expect((await original.json()).Items).toEqual([expect.objectContaining({ Id: "fixture-movie" })]);
    expect(application.fixture.hits.filter((hit) => hit.method === "DELETE")).toEqual([]);
    expect(application.blockedRequests(), "Server must not access external upstreams").toEqual([]);
    expect(externalRequests, "Browser must not access external URLs").toEqual([]);
    expect(application.fixture.unexpected, "All upstream calls must match local fixtures").toEqual([]);
  } finally {
    try {
      await context.close();
    } finally {
      await application.close();
    }
  }
});
