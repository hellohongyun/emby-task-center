import { expect, type Page } from "@playwright/test";

/** Exercise draft ordering through the rendered UI and verify persistence through actual HTTP. */
export async function verifyOrderExtremes(page: Page, base: string) {
  await page.goto(base + "/");
  const notice = page.getByRole("checkbox", { name: /14 天免打扰/ });
  await expect(page.getByRole("navigation", { name: "移动端导航" })).toBeVisible();
  if (await notice.isVisible()) {
    await notice.check();
    await page.getByRole("button", { name: "我知道了", exact: true }).click();
  }
  const openOrder = async () => {
    await page
      .getByRole("navigation", { name: "移动端导航" })
      .getByRole("button", { name: "虚拟库", exact: true })
      .click();
    await page.getByRole("button", { name: "我的媒体库顺序", exact: true }).click();
  };
  await openOrder();
  const endpoint = base + "/api/public/virtual-library-order";
  const read = async () => {
    const response = await page.request.get(endpoint);
    expect(response.status()).toBe(200);
    return response.json() as Promise<{ order: string[]; items: { id: string; name: string }[] }>;
  };
  const initial = await read();
  expect(initial.order.length).toBeGreaterThanOrEqual(3);
  const last = initial.order.at(-1)!;
  const name = initial.items.find((item) => item.id === last)!.name;
  const rows = page.getByRole("list", { name: "媒体库显示顺序" }).getByRole("listitem");
  await expect(rows).toHaveCount(initial.order.length);
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 950 });
    for (const row of await rows.all()) {
      await expect(row.getByRole("button")).toHaveCount(4);
      expect(await row.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
      for (const button of await row.getByRole("button").all()) {
        const bounds = await button.boundingBox();
        expect(bounds!.height).toBeGreaterThanOrEqual(40);
        expect(bounds!.width).toBeGreaterThanOrEqual(40);
      }
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  for (const [action, expected] of [
    ["置顶", [last, ...initial.order.filter((id) => id !== last)]],
    ["置底", initial.order],
  ] as const) {
    await page.getByRole("button", { name: `${action} ${name}`, exact: true }).click();
    const moved = action === "置顶" ? rows.first() : rows.last();
    await expect(moved).toContainText(name);
    await expect(moved.getByRole("button", { name: `${action} ${name}`, exact: true })).toBeDisabled();
    await expect(page.getByText("有未保存的更改", { exact: true }).first()).toBeVisible();
    expect((await read()).order).toEqual(
      action === "置顶" ? initial.order : [last, ...initial.order.filter((id) => id !== last)],
    );
    if (action === "置顶")
      await page.screenshot({ path: ".local/library-order-extremes-390.png", fullPage: true, animations: "disabled" });
    await page.getByRole("button", { name: "保存顺序", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("个人顺序已保存");
    expect((await read()).order).toEqual(expected);
    await page.reload();
    await openOrder();
    await expect(action === "置顶" ? rows.first() : rows.last()).toContainText(name);
    await expect(page.getByRole("button", { name: "保存顺序", exact: true })).toBeDisabled();
  }
}
