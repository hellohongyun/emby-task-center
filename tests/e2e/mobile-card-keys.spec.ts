import { resolve } from "node:path";
import { expect, test, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { startIsolatedServer } from "./real-server";

// Only temporary SQLite and local HTTP fixtures; never a running user's application.
let application: Awaited<ReturnType<typeof startIsolatedServer>>;
const externalRequests: string[] = [];

test.beforeAll(async () => {
  application = await startIsolatedServer();
});

test.afterAll(async () => {
  try {
    expect(application?.blockedRequests(), "Server external requests").toEqual([]);
    expect(externalRequests, "Browser external requests").toEqual([]);
    expect(application?.fixture.unexpected, "Unexpected upstream requests").toEqual([]);
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

async function login(page: Page, mobile: boolean) {
  await page.goto(`${application.baseURL}/login/library`);
  await page.getByLabel("管理员账号").fill("admin");
  await page.getByLabel("管理员口令").fill("admin123");
  await page.getByRole("button", { name: "进入任务中心" }).click();
  await expect(page.locator(".app-shell")).toBeVisible();
  if (mobile) {
    await page.getByRole("navigation", { name: "移动导航" }).getByRole("button", { name: "更多菜单" }).click();
    await page
      .getByRole("dialog", { name: "更多功能", exact: true })
      .getByRole("button", { name: "卡密", exact: true })
      .click();
  } else {
    await page.getByRole("navigation", { name: "主导航" }).getByRole("button", { name: "卡密", exact: true }).click();
  }
  await expect(page).toHaveURL(`${application.baseURL}/login/cardKeys`);
  await expect(page.getByRole("heading", { name: "卡密", exact: true })).toBeVisible();
}

async function noOverflow(page: Page, selector: string) {
  await expect(page.locator(selector)).toBeVisible();
  await expect
    .poll(
      async () =>
        page.locator(selector).evaluate((element) => {
          const bounds = element.getBoundingClientRect();
          return Math.max(
            document.documentElement.scrollWidth - document.documentElement.clientWidth,
            element.scrollWidth - element.clientWidth,
            -bounds.left,
            bounds.right - window.innerWidth,
          );
        }),
      { message: `${selector}: page, content and edges fit viewport` },
    )
    .toBeLessThanOrEqual(1);
}

async function tapTarget(locator: Locator) {
  await expect
    .poll(async () => {
      const bounds = await locator.boundingBox();
      return bounds ? Math.min(bounds.width, bounds.height) : 0;
    })
    .toBeGreaterThanOrEqual(43.9);
}

type SeededCard = { id: number; code: string; name: string; days: number; expiresAt: string | null };

async function seedCards(context: BrowserContext, width: number) {
  const name = `手机${width}春节限定追剧福利卡密长名称用于验证完整展示`;
  const future = new Date(Date.now() + 90 * 86_400_000).toISOString().slice(0, 10);
  const month = await context.request.post(`${application.baseURL}/api/cards`, {
    data: { kind: "month", count: 1, name: `手机${width}月卡` },
  });
  expect(month.status()).toBe(201);
  const response = await context.request.post(`${application.baseURL}/api/cards`, {
    data: {
      kind: "custom",
      count: 1,
      expiresAt: future,
      name,
      expiryLabel: "春节假期结束后统一到期，祝每一位影迷新年快乐好片不断",
      blessing: "愿每一段好故事都给你带来新的感动。春节快乐，追剧愉快！".repeat(3),
    },
  });
  expect(response.status()).toBe(201);
  const result = await context.request.get(`${application.baseURL}/api/cards`);
  return ((await result.json()).cards as SeededCard[]).find((card) => card.name === name)!;
}

for (const width of [320, 390, 768, 1440]) {
  test(`${width}px: card creation, calendar, long names and inline editing remain usable`, async ({ browser }) => {
    const mobile = width < 1000;
    const context = await browser.newContext({
      viewport: { width, height: mobile ? 844 : 1000 },
      isMobile: mobile,
      hasTouch: mobile,
    });
    await isolateNetwork(context);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      await login(page, mobile);
      const seeded = await seedCards(context, width);
      await page.getByRole("button", { name: "刷新", exact: true }).click();
      const list = page.locator(".table-card");
      await expect(list.getByText(seeded.name, { exact: true })).toBeVisible();
      const form = page.getByRole("group", { name: "创建卡密", exact: true });
      const kind = form.getByRole("combobox", { name: "类型", exact: true });
      await expect(kind).toHaveValue("month");
      await expect(form.getByRole("combobox", { name: "自定义方式", exact: true })).toHaveCount(0);
      await noOverflow(page, ".card-keys");
      await noOverflow(page, ".create-card");
      await noOverflow(page, ".table-card");
      if (mobile) await tapTarget(form.getByRole("button", { name: "生成卡密", exact: true }));
      if (width === 390) {
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.screenshot({ path: resolve(".local/card-keys-ui-mobile.png") });
        await list.evaluate((element) => window.scrollTo(0, element.getBoundingClientRect().top + window.scrollY - 12));
        await page.screenshot({ path: resolve(".local/card-keys-ui-mobile-list.png") });
      }
      if (width === 1440) await page.screenshot({ path: resolve(".local/card-keys-ui-desktop.png"), fullPage: true });

      await kind.selectOption("custom");
      const mode = form.getByRole("combobox", { name: "自定义方式", exact: true });
      await expect(mode).toHaveValue("date");
      await form.locator(".picker-trigger").click();
      const calendar = page.getByRole("dialog", { name: "选择到期日期", exact: true });
      await expect(calendar).toBeVisible();
      await noOverflow(page, ".picker-pop");
      await calendar.getByRole("button", { name: "下一个月", exact: true }).click();
      await calendar.getByRole("button", { name: "1 年", exact: true }).click();
      await expect(calendar).toHaveCount(0);
      await expect(form.locator(".picker-trigger")).toContainText(/\d{4}-\d{2}-\d{2}/);
      await mode.selectOption("days");
      await form.getByRole("spinbutton", { name: "天数", exact: true }).fill("15");
      await form.getByRole("spinbutton", { name: "数量", exact: true }).fill("1");
      await form.getByRole("textbox", { name: "卡密名称", exact: true }).fill(`手机${width}十五天卡`);
      await expect(form.locator(".picker-trigger")).toHaveCount(0);
      await noOverflow(page, ".create-card");
      await form.getByRole("button", { name: "生成卡密", exact: true }).click();
      await expect(page.locator(".generated")).toContainText("已生成 1 张");
      await expect(list.getByText(`手机${width}十五天卡`, { exact: true })).toBeVisible();

      const row = list.locator("tbody > tr").filter({ hasText: seeded.code });
      await row.scrollIntoViewIfNeeded();
      await expect(row.getByText(seeded.code, { exact: true })).toBeVisible();
      await expect(row.locator(".expiry-cell")).toContainText("春节假期结束后统一到期");
      const edit = row.getByRole("button", { name: "编辑名称 / 到期时间名称 / 祝福文案", exact: true });
      if (mobile) {
        await noOverflow(page, ".table-wrap");
        await tapTarget(edit);
        await tapTarget(row.getByRole("button", { name: "删除卡密", exact: true }));
      }
      await edit.click();
      const editor = page.locator(".edit-row");
      await expect(editor).toBeVisible();
      await noOverflow(page, ".edit-row");
      const editName = editor.getByRole("textbox", { name: "卡密名称", exact: true });
      await expect(editName).toHaveValue(seeded.name);
      await editName.fill("取消时不会保存");
      await editor.getByRole("button", { name: "取消", exact: true }).click();
      await expect(editor).toHaveCount(0);
      await edit.click();
      await expect(editName).toHaveValue(seeded.name);
      await editName.fill(`手机${width}已更新福利卡`);
      if (mobile) await tapTarget(editor.getByRole("button", { name: "保存", exact: true }));
      await editor.getByRole("button", { name: "保存", exact: true }).click();
      await expect(editor).toHaveCount(0);
      await expect(row.getByText(`手机${width}已更新福利卡`, { exact: true })).toBeVisible();
      const saved = await context.request.get(`${application.baseURL}/api/cards`);
      expect(((await saved.json()).cards as SeededCard[]).find((card) => card.id === seeded.id)).toMatchObject({
        name: `手机${width}已更新福利卡`,
        expiresAt: seeded.expiresAt,
        days: seeded.days,
      });
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  });
}
