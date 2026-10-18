import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { expect, test, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { startIsolatedServer } from "./real-server";

// Real app HTTP with temporary SQLite and local upstreams; never production data.
let application: Awaited<ReturnType<typeof startIsolatedServer>>;
const externalRequests: string[] = [];
const { version } = JSON.parse(readFileSync(resolve("package.json"), "utf8"));

test.beforeAll(async () => {
  application = await startIsolatedServer();
});

test.afterAll(async () => {
  try {
    expect(application?.blockedRequests(), "Server external requests").toEqual([]);
    expect(externalRequests, "Browser external requests").toEqual([]);
    expect(application?.fixture.unexpected, "Unexpected local upstream requests").toEqual([]);
  } finally {
    await application?.close();
  }
});

async function isolateNetwork(context: BrowserContext) {
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (["http:", "https:"].includes(url.protocol) && url.origin !== application.baseURL) {
      externalRequests.push(url.origin + url.pathname);
      await route.abort();
    } else await route.continue();
  });
}

async function login(page: Page, path = "/login/library") {
  await page.goto(application.baseURL + path);
  await expect(page.getByLabel(`应用版本 ${version}`)).toBeVisible();
  await page.getByLabel("管理员账号").fill("admin");
  await page.getByLabel("管理员口令").fill("admin123");
  await page.getByRole("button", { name: "进入任务中心" }).click();
  await expect(page.locator(".app-shell")).toBeVisible();
  await expect(page.locator(".app-header").getByLabel(`应用版本 ${version}`)).toBeVisible();
}

async function expectNoOverflow(page: Page, selector: string) {
  await expect(page.locator(selector)).toBeVisible();
  const measurements = await page.locator(selector).evaluate((element) => {
    const box = element.getBoundingClientRect();
    return {
      pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      contentOverflow: element.scrollWidth - element.clientWidth,
      left: box.left,
      right: box.right,
      width: window.innerWidth,
    };
  });
  expect(measurements.pageOverflow, `${selector}: page width`).toBeLessThanOrEqual(1);
  expect(measurements.contentOverflow, `${selector}: content width`).toBeLessThanOrEqual(1);
  expect(measurements.left, `${selector}: left edge`).toBeGreaterThanOrEqual(-1);
  expect(measurements.right, `${selector}: right edge`).toBeLessThanOrEqual(measurements.width + 1);
}

async function expectTapTarget(locator: Locator) {
  // Dialog entry transforms briefly scale the target; wait for its final size.
  await expect
    .poll(async () => {
      const box = await locator.boundingBox();
      return box ? Math.min(box.height, box.width) : 0;
    })
    .toBeGreaterThanOrEqual(43.9);
}

for (const width of [320, 390, 768]) {
  test(`${width}px: library search, details and virtual-library mapping remain usable`, async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width, height: 844 }, isMobile: true, hasTouch: true });
    await isolateNetwork(context);
    const page = await context.newPage();
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    try {
      await login(page);
      const movie = page.getByRole("button", { name: "查看 隔离测试电影", exact: true });
      await expect(movie).toBeVisible();
      await expect(movie.locator(".poster-fallback")).toBeVisible();
      await expectNoOverflow(page, ".library-view");
      await page.getByRole("searchbox", { name: "搜索片名", exact: true }).fill("没有这部影片");
      await expect(movie).toHaveCount(0);
      await page.getByRole("searchbox", { name: "搜索片名", exact: true }).fill("隔离测试电影");
      await expect(movie).toBeVisible();

      const toggle = page.getByRole("button", { name: /^展开筛选/ });
      if (width <= 700) {
        await expect(toggle).toHaveAttribute("aria-expanded", "false");
        await expect(page.locator(".filter-rows")).toBeHidden();
        await expectTapTarget(toggle);
        await toggle.click();
        const collapse = page.getByRole("button", { name: /^收起筛选/ });
        await expect(collapse).toHaveAttribute("aria-expanded", "true");
        await expect(page.locator(".filter-rows")).toBeVisible();
        await expectNoOverflow(page, ".filter-shell");
        await collapse.click();
        await expect(page.locator(".filter-rows")).toBeHidden();
      } else await expect(page.locator(".filter-rows")).toBeVisible();

      await movie.click();
      const dialog = page.getByRole("dialog", { name: "隔离测试电影 管理详情", exact: true });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByText(/本地库存/)).toBeVisible();
      await expectNoOverflow(page, ".detail-sheet");
      const close = dialog.getByRole("button", { name: "关闭详情", exact: true });
      await expectTapTarget(close);
      await close.click();
      await expect(dialog).toHaveCount(0);
      if (width === 390) {
        await movie.scrollIntoViewIfNeeded();
        await page.screenshot({ path: resolve(".local/mobile-library.png") });
      }

      const navigation = page.getByRole("navigation", { name: "移动导航" });
      await navigation.getByRole("button", { name: "更多菜单" }).click();
      const more = page.getByRole("dialog", { name: "更多功能", exact: true });
      await expect(more).toBeVisible();
      await more.getByRole("button", { name: "虚拟媒体库", exact: true }).click();
      await expect(more).toHaveCount(0);
      await expect(page.getByRole("heading", { name: "虚拟媒体库", exact: true })).toBeVisible();
      await expectNoOverflow(page, ".vl-page");

      const create = page.getByRole("button", { name: "＋ 新建虚拟媒体库", exact: true });
      await expectTapTarget(create);
      await create.click();
      const form = page.locator(".vl-library-form");
      await page.getByLabel("媒体库名称").fill(`手机精选 ${width}`);
      await page.getByLabel("显示类型").selectOption("mixed");
      await page.getByLabel("排序", { exact: true }).fill("-1");
      await expectNoOverflow(page, ".vl-library-form");
      await expectTapTarget(form.getByRole("button", { name: "保存媒体库", exact: true }));
      await form.getByRole("button", { name: "保存媒体库", exact: true }).click();
      await expect(page.getByRole("button", { name: new RegExp(`手机精选 ${width} 混合`) })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      const source = page.getByRole("region", { name: "从 Emby 选择内容", exact: true });
      await source.getByRole("combobox", { name: "源媒体库", exact: true }).selectOption("fixture-movies");
      await source.getByLabel("搜索 Emby 内容").fill("隔离测试电影");
      await source.getByRole("button", { name: "搜索", exact: true }).click();
      await source.getByRole("checkbox", { name: "选择 隔离测试电影", exact: true }).check();
      await expectNoOverflow(page, ".vl-search");
      await expectTapTarget(source.getByRole("button", { name: "加入已选（1）", exact: true }));
      await source.getByRole("button", { name: "加入已选（1）", exact: true }).click();
      const added = page.getByRole("region", { name: "已加入的内容", exact: true });
      await expect(added.getByText("隔离测试电影", { exact: true })).toBeVisible();
      await expect(added.locator(".poster-fallback")).toBeVisible();
      await expectNoOverflow(page, ".vl-page");
      if (width === 390) {
        await added.scrollIntoViewIfNeeded();
        await page.screenshot({ path: resolve(".local/mobile-virtual-libraries.png") });
      }
      await page.getByRole("button", { name: "编辑媒体库", exact: true }).click();
      await expect(form).toBeVisible();
      await expect(page.getByLabel("媒体库名称")).toHaveValue(`手机精选 ${width}`);
      await expectNoOverflow(page, ".vl-library-form");
      await form.getByRole("button", { name: "取消", exact: true }).click();
      await expect(form).toHaveCount(0);

      await navigation.getByRole("button", { name: "更多菜单" }).click();
      const cardsEntry = more.getByRole("button", { name: "卡密", exact: true });
      await expectTapTarget(cardsEntry);
      await cardsEntry.click();
      await expect(page).toHaveURL(`${application.baseURL}/login/cardKeys`);
      await expect(page.getByRole("heading", { name: "卡密", exact: true })).toBeVisible();
      await expect(page.locator(".mobile-brand")).toContainText("卡密");
      await expect(more).toHaveCount(0);
      await expect(navigation.getByRole("button", { name: "更多菜单" })).toHaveClass(/active/);
      if (width === 390) await page.screenshot({ path: resolve(".local/mobile-card-keys.png") });
      expect(pageErrors).toEqual([]);
    } finally {
      await context.close();
    }
  });
}

test("desktop keeps expanded library filters and the virtual-library sidebar", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await isolateNetwork(context);
  try {
    const page = await context.newPage();
    await login(page);
    await expect(page.getByRole("button", { name: "查看 隔离测试电影", exact: true })).toBeVisible();
    await expect(page.locator(".filter-rows")).toBeVisible();
    await expect(page.locator(".filter-toggle")).toBeHidden();
    await expect(page.getByRole("navigation", { name: "移动导航" })).toBeHidden();
    await expectNoOverflow(page, ".library-view");
    const created = await context.request.post(`${application.baseURL}/api/virtual-libraries`, {
      data: { name: "桌面布局精选", collectionType: "mixed" },
    });
    expect(created.status()).toBe(201);
    await page
      .getByRole("navigation", { name: "主导航" })
      .getByRole("button", { name: "虚拟媒体库", exact: true })
      .click();
    await expectNoOverflow(page, ".vl-page");
    const sidebar = await page.locator(".vl-libraries").boundingBox();
    const content = await page.locator(".vl-main").boundingBox();
    expect(sidebar).not.toBeNull();
    expect(content).not.toBeNull();
    expect(content!.x).toBeGreaterThanOrEqual(sidebar!.x + sidebar!.width);
  } finally {
    await context.close();
  }
});
