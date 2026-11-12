import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { startMemberRegistrationFixture } from "./member-registration-fixture";

const day = 86_400_000;
const email = "reduction@example.invalid";
type Member = {
  id: number;
  email: string;
  subscriptionExpiresAt: string;
  deferredMembershipMs: number;
  status: string;
  embyUserId: string;
};

async function readMember(api: APIRequestContext) {
  const response = await api.get("/api/submission-users");
  expect(response.status()).toBe(200);
  return (await response.json()).users.find((user: Member) => user.email === email) as Member;
}

async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const dialog = page.getByRole("dialog", { name: "减少会员天数" });
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  const background = await dialog.evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(background).toMatch(/^rgb\([\d\s,]+\)$/);
  await expect(dialog).toHaveCSS("opacity", "1");
}

test("admin reduces deferred time first, expires the account and sends durable adjustment receipts", async ({
  browser,
}, info) => {
  const fixture = await startMemberRegistrationFixture();
  const context = await browser.newContext({ baseURL: fixture.baseURL, viewport: { width: 1440, height: 900 } });
  const external: string[] = [];
  await context.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.origin === fixture.baseURL || !["http:", "https:"].includes(url.protocol)) return route.continue();
    external.push(url.origin + url.pathname);
    return route.abort();
  });
  try {
    const page = await context.newPage();
    await page.goto("/login/submissions");
    await page.getByLabel("管理员账号").fill("admin");
    await page.getByLabel("管理员口令").fill("admin123");
    await page.getByRole("button", { name: "进入任务中心" }).click();
    await expect(page.getByRole("button", { name: "刷新", exact: true })).toBeVisible();

    const api = context.request;
    const capDate = new Date(Date.now() + 30 * day).toISOString().slice(0, 10);
    const capResponse = await api.put("/api/membership-drive-expiry", { data: { date: capDate, expectedDate: null } });
    expect(capResponse.status()).toBe(200);
    const cap = (await capResponse.json()).limit;
    const created = await api.post("/api/submission-users", {
      data: { email, subscriptionExpiresAt: new Date(Date.parse(cap.expiresAt) + 10 * day).toISOString() },
    });
    expect(created.status()).toBe(201);
    const original = await readMember(api);
    expect(original.deferredMembershipMs).toBe(10 * day);
    expect(original.subscriptionExpiresAt).toBe(cap.expiresAt);
    expect(original.embyUserId).toBeTruthy();

    await page.reload();
    const row = page.getByRole("row", { name: new RegExp(email) });
    await row.getByRole("button", { name: "减少天数", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "减少会员天数" });
    await dialog.getByLabel("减少天数", { exact: true }).fill("3");
    await dialog.getByLabel("扣减原因（可选）").fill("后台核对扣减");
    await expect(dialog.getByText("扣减后待激活时长：7 天", { exact: true })).toBeVisible();
    await noOverflow(page);
    await page.screenshot({ path: info.outputPath("reduction-desktop.png"), animations: "disabled" });
    const firstWrite = page.waitForResponse(
      (response) => response.url().endsWith("/reduce-days") && response.request().method() === "POST",
    );
    await dialog.getByRole("button", { name: "确认减少天数" }).click();
    expect((await firstWrite).status()).toBe(200);
    await expect(dialog).toHaveCount(0);
    const afterDeferred = await readMember(api);
    expect(afterDeferred.subscriptionExpiresAt).toBe(original.subscriptionExpiresAt);
    expect(afterDeferred.deferredMembershipMs).toBe(7 * day);
    const firstMail = fixture.messages.filter(
      (message) => message.recipient === email && message.text.includes("本次扣减"),
    );
    expect(firstMail).toHaveLength(1);
    expect(firstMail[0]!.text).toContain("本次扣减：3 天");
    expect(firstMail[0]!.text).toContain("扣减后待激活时长：7 天");
    expect(firstMail[0]!.html).toContain("会员时长扣减");
    expect(firstMail[0]!.text).not.toContain("会员续期已完成");

    await page.setViewportSize({ width: 390, height: 844 });
    await row.getByRole("button", { name: "详情与操作" }).click();
    await row.getByRole("button", { name: "减少天数", exact: true }).click();
    await dialog.getByLabel("减少天数", { exact: true }).fill("50");
    await expect(dialog.getByRole("alert")).toContainText("扣减后已过期");
    await expect(dialog.getByText("扣减后待激活时长：0 天", { exact: true })).toBeVisible();
    await noOverflow(page);
    await page.screenshot({ path: info.outputPath("reduction-mobile.png"), animations: "disabled" });
    const expiredWrite = page.waitForResponse(
      (response) => response.url().endsWith("/reduce-days") && response.request().method() === "POST",
    );
    await dialog.getByRole("button", { name: "确认减少天数" }).click();
    expect((await expiredWrite).status()).toBe(200);
    await expect(dialog).toHaveCount(0);
    const expired = await readMember(api);
    expect(expired.deferredMembershipMs).toBe(0);
    expect(expired.subscriptionExpiresAt).toBe(new Date(Date.parse(cap.expiresAt) - 43 * day).toISOString());
    expect(expired.status).toBe("expired");
    const accounts = (await (await api.get("/api/emby/users")).json()).users;
    expect(accounts.find((user: { id: string }) => user.id === expired.embyUserId).isDisabled).toBe(true);
    const mail = fixture.messages.filter((message) => message.recipient === email && message.text.includes("本次扣减"));
    expect(mail).toHaveLength(2);
    expect(mail[1]!.text).toContain("本次扣减：50 天");
    expect(mail[1]!.text).toContain("过期账号清理规则");

    await fixture.restart();
    expect(await readMember(api)).toMatchObject({
      subscriptionExpiresAt: expired.subscriptionExpiresAt,
      deferredMembershipMs: 0,
      status: "expired",
    });
    await page.reload();
    await expect(page.getByRole("row", { name: new RegExp(email) })).toContainText("已过期");
    expect(
      fixture.messages.filter((message) => message.recipient === email && message.text.includes("本次扣减")),
    ).toHaveLength(2);
    expect(fixture.unexpected).toEqual([]);
    expect(fixture.unexpectedEmbyRequests).toEqual([]);
    expect(fixture.blockedRequests()).toEqual([]);
    expect(external).toEqual([]);
  } finally {
    await context.close();
    await fixture.close();
  }
});
