import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { freePort, startIsolatedServer } from "./real-server";
import { marketEmails, seedMarketMembers, startMarketFixture } from "./market-fixture";
import { pngPoster } from "../../apps/server/src/virtual-libraries/poster-fixtures";

async function openWorkspace(page: Page, base: string) {
  await page.goto(base + "/");
  await expect(page.getByRole("navigation", { name: "移动端导航" })).toBeVisible();
  if (await page.getByRole("checkbox", { name: /14 天免打扰/ }).isVisible()) {
    await page.getByRole("checkbox", { name: /14 天免打扰/ }).check();
    await page.getByRole("button", { name: "我知道了", exact: true }).click();
  }
  await page
    .getByRole("navigation", { name: "移动端导航" })
    .getByRole("button", { name: "虚拟库", exact: true })
    .click();
}

test("market publication, subscriptions, personal order, admin inspection and revocation use real APIs", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const app = await startIsolatedServer({ seedDatabase: seedMarketMembers, startUpstream: startMarketFixture });
  const owner = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const other = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const admin = await browser.newContext({ viewport: { width: 1440, height: 950 } });
  const contexts: BrowserContext[] = [owner, other, admin];
  for (const context of contexts)
    await context.route("**/*", (route) =>
      new URL(route.request().url()).origin === app.baseURL ? route.continue() : route.abort(),
    );
  try {
    for (const [index, context] of [owner, other].entries())
      expect(
        (
          await context.request.post(app.baseURL + "/api/public/subscriptions/login", {
            data: { email: marketEmails[index], code: "314159" },
          })
        ).status(),
      ).toBe(200);
    expect(
      (
        await admin.request.post(app.baseURL + "/api/auth/login", { data: { username: "admin", password: "admin123" } })
      ).status(),
    ).toBe(200);
    const created = await owner.request.post(app.baseURL + "/api/public/virtual-libraries", {
      data: { name: "同源市场精选", collectionType: "mixed" },
    });
    expect(created.status()).toBe(201);
    const id = (await created.json()).library.id;
    expect(
      (
        await owner.request.post(`${app.baseURL}/api/public/virtual-libraries/${id}/items`, {
          data: { itemIds: ["fixture-movie"] },
        })
      ).status(),
    ).toBe(200);
    const ownerPage = await owner.newPage();
    await openWorkspace(ownerPage, app.baseURL);
    await expect(ownerPage.locator(".vl-poster-preview img")).toHaveAttribute("src", /^data:image\/svg\+xml/);
    expect(
      (
        await owner.request.put(`${app.baseURL}/api/public/virtual-libraries/${id}/poster`, {
          data: pngPoster(120, 240),
          headers: { "Content-Type": "image/png" },
        })
      ).status(),
    ).toBe(200);
    await ownerPage.reload();
    await openWorkspace(ownerPage, app.baseURL);
    await ownerPage.getByRole("button", { name: "上架市场", exact: true }).click();
    await expect(ownerPage.getByRole("heading", { name: "已上架市场" })).toBeVisible();
    const otherPage = await other.newPage();
    await openWorkspace(otherPage, app.baseURL);
    await otherPage.getByRole("button", { name: "媒体库市场", exact: true }).click();
    await expect(otherPage.getByRole("heading", { name: "同源市场精选" })).toBeVisible();
    const cover = otherPage.getByRole("img", { name: "同源市场精选媒体库海报" });
    await expect(cover).toHaveAttribute("src", /\/poster\?tag=/);
    await expect.poll(() => cover.evaluate((image: HTMLImageElement) => image.naturalHeight)).toBe(240);
    await expect(cover).toHaveCSS("object-fit", "contain");
    await otherPage.getByRole("button", { name: "启用媒体库", exact: true }).click();
    await expect(otherPage.getByRole("button", { name: "关闭媒体库", exact: true })).toBeVisible();
    expect(
      (
        await other.request.patch(`${app.baseURL}/api/public/virtual-libraries/${id}`, { data: { name: "越权修改" } })
      ).status(),
    ).toBe(404);
    expect(
      (
        await other.request.put(`${app.baseURL}/api/public/virtual-library-market/owned/${id}/publication`, {
          data: { published: false },
        })
      ).status(),
    ).toBe(404);
    await otherPage.getByRole("button", { name: "我的媒体库顺序", exact: true }).click();
    await expect(otherPage.getByRole("img", { name: "同源市场精选媒体库海报" })).toHaveAttribute(
      "src",
      /\/api\/public\/virtual-library-order\/[^/]+\/poster\?tag=/,
    );
    await otherPage.getByRole("button", { name: "上移 同源市场精选", exact: true }).click();
    await expect(otherPage.getByText("有未保存的更改", { exact: true }).first()).toBeVisible();
    await otherPage
      .getByRole("navigation", { name: "虚拟媒体库功能" })
      .getByRole("button", { name: "媒体库市场", exact: true })
      .click();
    await expect(otherPage.getByRole("alertdialog", { name: "未保存的更改" })).toBeVisible();
    await otherPage.getByRole("button", { name: "继续编辑", exact: true }).click();
    await otherPage.getByRole("button", { name: "保存顺序", exact: true }).click();
    await expect(otherPage.getByRole("status")).toContainText("个人顺序已保存");
    expect((await (await other.request.get(app.baseURL + "/api/public/virtual-library-order")).json()).order[0]).toBe(
      id,
    );
    const adminPage = await admin.newPage();
    await adminPage.goto(app.baseURL + "/login/virtual-libraries");
    await adminPage.getByRole("button", { name: "用户库查看", exact: true }).click();
    await adminPage.getByRole("button", { name: new RegExp(`同源市场精选 ${marketEmails[0]}`) }).click();
    await expect(adminPage.getByText("隔离测试电影", { exact: true })).toBeVisible();
    const itemPoster = adminPage.getByRole("img", { name: "隔离测试电影 海报", exact: true });
    await expect(itemPoster).toHaveAttribute("src", /\/user-libraries\/[^/]+\/items\/fixture-movie\/poster/);
    await expect(itemPoster).toHaveJSProperty("naturalWidth", 1);
    await expect(adminPage.locator(".vm-account")).toHaveCount(0);
    for (const width of [320, 390]) {
      await adminPage.setViewportSize({ width, height: 844 });
      const picker = adminPage.getByRole("button", { name: "切换媒体库", exact: true });
      await expect(picker).toHaveAttribute("aria-expanded", "false");
      await picker.click();
      await adminPage.getByRole("button", { name: new RegExp(`同源市场精选 ${marketEmails[0]}`) }).click();
      await expect(picker).toHaveAttribute("aria-expanded", "false");
      expect(await adminPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    await adminPage.setViewportSize({ width: 1440, height: 950 });
    expect(await adminPage.getByRole("button", { name: /^(编辑|删除|上架|下架)/ }).count()).toBe(0);
    await adminPage.getByRole("button", { name: "新用户默认设置", exact: true }).click();
    await adminPage.getByRole("checkbox", { name: "同源市场精选", exact: true }).check();
    await adminPage.getByRole("button", { name: "保存默认设置", exact: true }).click();
    await expect(adminPage.getByRole("status")).toContainText("已保存");
    expect(
      (await (await admin.request.get(app.baseURL + "/api/virtual-library-market/defaults")).json()).libraryIds,
    ).toEqual([id]);
    const port = await freePort();
    expect(
      (
        await admin.request.put(app.baseURL + "/api/virtual-libraries/proxy", {
          data: { enabled: true, port, upstream: app.fixture.baseURL },
        })
      ).status(),
    ).toBe(200);
    const proxy = `http://127.0.0.1:${port}`;
    expect(
      (
        await other.request.post(proxy + "/Users/AuthenticateByName", {
          data: { Username: marketEmails[1], Pw: "fixture-password" },
        })
      ).status(),
    ).toBe(200);
    const headers = { "X-Emby-Token": "other-token" };
    const views = async () =>
      (
        (await (await other.request.get(proxy + "/Users/other-user/Views", { headers })).json()).Items as {
          Id: string;
        }[]
      ).map((item) => item.Id);
    expect(await views()).toEqual([id, "fixture-movies"]);
    await app.restart();
    expect(await views()).toEqual([id, "fixture-movies"]);
    await otherPage.reload();
    await openWorkspace(otherPage, app.baseURL);
    await otherPage.getByRole("button", { name: "我的媒体库顺序", exact: true }).click();
    await otherPage.getByRole("button", { name: "恢复默认", exact: true }).click();
    await expect(otherPage.getByRole("status")).toContainText("已恢复默认");
    expect(await views()).toEqual(["fixture-movies", id]);
    await otherPage.getByRole("button", { name: "媒体库市场", exact: true }).click();
    await otherPage.getByRole("button", { name: "关闭媒体库", exact: true }).click();
    await expect(otherPage.getByRole("button", { name: "启用媒体库", exact: true })).toBeVisible();
    expect(await views()).toEqual(["fixture-movies"]);
    await otherPage.getByRole("button", { name: "启用媒体库", exact: true }).click();
    await expect(otherPage.getByRole("button", { name: "关闭媒体库", exact: true })).toBeVisible();
    await ownerPage.getByRole("button", { name: "下架市场", exact: true }).click();
    await expect(ownerPage.getByRole("button", { name: "上架市场", exact: true })).toBeVisible();
    expect(await views()).toEqual(["fixture-movies"]);
    for (const suffix of [`/Items/${id}`, `/Items?ParentId=${id}`, `/Items/${id}/Images/Primary`])
      expect((await other.request.get(proxy + suffix, { headers })).status()).toBe(404);
    expect((await other.request.get(`${app.baseURL}/api/public/virtual-library-market/${id}/poster`)).status()).toBe(
      404,
    );
    await ownerPage.getByRole("button", { name: "上架市场", exact: true }).click();
    await expect(ownerPage.getByRole("button", { name: "下架市场", exact: true })).toBeVisible();
    expect(await views()).toEqual(["fixture-movies"]);
    const market = await (await other.request.get(app.baseURL + "/api/public/virtual-library-market")).json();
    expect(market.libraries.find((library: { id: string }) => library.id === id).enabled).toBe(false);
    for (const page of [ownerPage, otherPage, adminPage])
      for (const width of [320, 390, 1440]) {
        await page.setViewportSize({ width, height: 950 });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      }
    expect(app.blockedRequests()).toEqual([]);
    expect(app.fixture.unexpected).toEqual([]);
  } finally {
    await Promise.allSettled(contexts.map((context) => context.close()));
    await app.close();
  }
});
