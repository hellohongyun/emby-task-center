import { mkdirSync } from "node:fs";
import BetterSqlite3 from "better-sqlite3";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { startIsolatedServer } from "./real-server";
import { marketEmails } from "./market-fixture";
import { previewLibrary, privateLibrary, seedPreviewDatabase, startPreviewFixture } from "./market-preview-fixture";
import { verifyOrderExtremes } from "./market-order-extremes";

async function loadedImage(image: Locator) {
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBeGreaterThan(0);
}

async function noOverflow(page: Page, dialog?: Locator) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  if (dialog) expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
}

async function openMarket(page: Page, base: string) {
  await page.goto(base + "/");
  await expect(page.getByRole("navigation", { name: "移动端导航" })).toBeVisible();
  const notice = page.getByRole("checkbox", { name: /14 天免打扰/ });
  if (await notice.isVisible()) {
    await notice.check();
    await page.getByRole("button", { name: "我知道了", exact: true }).click();
  }
  await page
    .getByRole("navigation", { name: "移动端导航" })
    .getByRole("button", { name: "虚拟库", exact: true })
    .click();
  await page.getByRole("button", { name: "媒体库市场", exact: true }).click();
}

test("published library preview loads avatars and paginated films without enabling subscriptions", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  let databasePath = "";
  const app = await startIsolatedServer({
    seedDatabase(path) {
      databasePath = path;
      seedPreviewDatabase(path);
    },
    startUpstream: startPreviewFixture,
    qqAvatarFixture: true,
  });
  const member = await browser.newContext({ viewport: { width: 390, height: 950 } });
  const admin = await browser.newContext({ viewport: { width: 1440, height: 950 } });
  const owner = await browser.newContext();
  const external: string[] = [];
  for (const context of [member, admin, owner])
    await context.route("**/*", (route) => {
      if (new URL(route.request().url()).origin === app.baseURL) return route.continue();
      external.push(route.request().url());
      return route.abort();
    });
  try {
    for (const [context, email] of [
      [member, marketEmails[1]],
      [owner, marketEmails[0]],
    ] as const)
      expect(
        (
          await context.request.post(app.baseURL + "/api/public/subscriptions/login", {
            data: { email, code: "314159" },
          })
        ).status(),
      ).toBe(200);
    expect(
      (
        await admin.request.post(app.baseURL + "/api/auth/login", {
          data: { username: "admin", password: "admin123" },
        })
      ).status(),
    ).toBe(200);
    const marketUrl = app.baseURL + "/api/public/virtual-library-market";
    const currentLibrary = async () =>
      (await (await member.request.get(marketUrl)).json()).libraries.find(
        (entry: { id: string }) => entry.id === previewLibrary.id,
      );
    expect((await currentLibrary()).enabled).toBe(false);
    const page = await member.newPage();
    await openMarket(page, app.baseURL);
    const card = page.locator(".vm-card").filter({ has: page.getByRole("heading", { name: previewLibrary.name }) });
    await loadedImage(card.locator(".vl-author img"));
    await expect(card).not.toContainText(marketEmails[0]);
    await expect(card).not.toContainText("123456789");
    const trigger = page.getByRole("button", { name: `查看 ${previewLibrary.name} 详情`, exact: true }).first();
    const dialog = page.getByRole("dialog", { name: `${previewLibrary.name} 详情`, exact: true });
    mkdirSync(".local", { recursive: true });
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 950 });
      await trigger.click();
      await expect(dialog).toBeVisible();
      await expect(dialog.locator(".vul-film")).toHaveCount(40);
      const film = dialog.getByRole("article", { name: "本地影片 00", exact: true });
      await loadedImage(film.getByRole("img", { name: "本地影片 00 海报", exact: true }));
      await expect(film).toContainText("2020");
      await expect(film).toContainText("电影");
      await loadedImage(dialog.locator(".vl-author img"));
      await noOverflow(page, dialog);
      const close = dialog.getByRole("button", { name: "关闭媒体库详情", exact: true });
      const bounds = await close.boundingBox();
      expect(bounds!.width).toBeGreaterThanOrEqual(40);
      expect(bounds!.height).toBeGreaterThanOrEqual(40);
      await dialog.evaluate(async (element) => {
        const animations: Animation[] = [];
        for (let node: Element | null = element; node; node = node.parentElement)
          animations.push(
            ...node
              .getAnimations()
              .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity),
          );
        await Promise.allSettled(animations.map((animation) => animation.finished));
        await new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())));
      });
      await page.screenshot({ path: `.local/market-preview-${width}.png`, fullPage: true, animations: "disabled" });
      if (width === 390) {
        const layers = await dialog.evaluate((element) => {
          const styles = [];
          for (let node: Element | null = element; node; node = node.parentElement) {
            const style = getComputedStyle(node);
            styles.push({ className: node.className, backgroundColor: style.backgroundColor, opacity: style.opacity });
          }
          return styles;
        });
        console.log("390px modal computed layers:", JSON.stringify(layers));
        expect(layers[0]!.backgroundColor).toMatch(/^rgb\(/);
        expect(layers.every((layer) => layer.opacity === "1")).toBe(true);
        await page.evaluate(
          () => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))),
        );
        await page.screenshot({
          path: ".local/market-preview-390-viewport.png",
          fullPage: false,
          animations: "disabled",
        });
      }
      await dialog.getByLabel("搜索本页影片").fill("本地影片 00");
      await expect(dialog.locator(".vul-film")).toHaveCount(1);
      await dialog.getByLabel("搜索本页影片").fill("");
      await dialog.getByLabel("内容类型").selectOption("Series");
      await expect(dialog.locator(".vul-film")).toHaveCount(20);
      await dialog.getByLabel("内容类型").selectOption("");
      await dialog.getByRole("button", { name: "下一页", exact: true }).click();
      await expect(dialog.locator(".vul-film")).toHaveCount(3);
      await expect(dialog.getByRole("article", { name: "本地影片 40", exact: true })).toBeVisible();
      await expect(dialog.getByRole("button", { name: "下一页", exact: true })).toBeDisabled();
      await noOverflow(page, dialog);
      await close.focus();
      await page.keyboard.press("Shift+Tab");
      await expect(dialog.getByRole("button", { name: "上一页", exact: true })).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(close).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      await expect(trigger).toBeFocused();
      expect((await currentLibrary()).enabled).toBe(false);
      await noOverflow(page);
      await card.screenshot({ path: `.local/market-preview-card-${width}.png` });
    }
    await trigger.focus();
    await page.keyboard.press("Enter");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "关闭媒体库详情", exact: true }).click();
    await expect(trigger).toBeFocused();
    const sqlite = new BetterSqlite3(databasePath, { readonly: true, fileMustExist: true });
    try {
      expect(sqlite.prepare("SELECT * FROM virtual_library_subscriptions").all()).toEqual([]);
    } finally {
      sqlite.close();
    }
    const ownerPage = await owner.newPage();
    await ownerPage.setViewportSize({ width: 390, height: 950 });
    await verifyOrderExtremes(ownerPage, app.baseURL);

    const adminPage = await admin.newPage();
    await adminPage.goto(app.baseURL + "/login/virtual-libraries");
    await adminPage.getByRole("button", { name: "用户库查看", exact: true }).click();
    const sidebar = adminPage.getByRole("complementary", { name: "用户媒体库列表" });
    await sidebar.getByRole("button", { name: `${previewLibrary.name} ${marketEmails[0]}`, exact: true }).click();
    await loadedImage(sidebar.locator(".vl-author img").first());
    await loadedImage(adminPage.locator(".vul-current .vl-author img"));
    await loadedImage(adminPage.getByRole("img", { name: "本地影片 00 海报", exact: true }));
    await adminPage.screenshot({ path: ".local/market-preview-admin-1440.png", fullPage: true });
    for (const width of [390, 320]) {
      await adminPage.setViewportSize({ width, height: 950 });
      await noOverflow(adminPage);
      await loadedImage(adminPage.locator(".vul-current .vl-author img"));
      const picker = adminPage.getByRole("button", { name: "切换媒体库", exact: true });
      await picker.click();
      await loadedImage(sidebar.locator(".vl-author img").first());
      await noOverflow(adminPage);
      await adminPage.screenshot({ path: `.local/market-preview-admin-${width}.png`, fullPage: true });
      await adminPage.getByRole("button", { name: "收起选择", exact: true }).click();
    }
    const blocked = async (id: string, item: string) => {
      for (const suffix of ["details", "author-avatar", `items/${item}/poster`])
        expect((await member.request.get(`${marketUrl}/${id}/${suffix}`)).status()).toBe(404);
    };
    await blocked(privateLibrary, "private-film");
    expect(
      (
        await owner.request.put(`${marketUrl}/owned/${previewLibrary.id}/publication`, {
          data: { published: false },
        })
      ).status(),
    ).toBe(200);
    await blocked(previewLibrary.id, "preview-film-0");
    expect(app.blockedRequests()).toEqual([]);
    expect(app.fixture.unexpected).toEqual([]);
    expect(external).toEqual([]);
  } finally {
    await Promise.allSettled([member, admin, owner].map((context) => context.close()));
    await app.close();
  }
});
