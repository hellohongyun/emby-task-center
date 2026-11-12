import { randomUUID } from "node:crypto";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { startMemberRegistrationFixture } from "./member-registration-fixture";

const day = 86_400_000;
const subscriptions = "/api/public/subscriptions";
type Member = { id: number; email: string; subscriptionExpiresAt: string | null; deferredMembershipMs: number };
async function members(api: APIRequestContext): Promise<Member[]> {
  const response = await api.get("/api/submission-users");
  expect(response.status()).toBe(200);
  return (await response.json()).users;
}
async function login(api: APIRequestContext) {
  expect((await api.post("/api/auth/login", { data: { username: "admin", password: "admin123" } })).status()).toBe(200);
}
async function open(page: Page, email: string) {
  const row = page.getByRole("row", { name: new RegExp(email) });
  await expect(row).toBeVisible();
  const more = row.getByRole("button", { name: "详情与操作" });
  if (await more.isVisible()) await more.click();
  await row.getByRole("button", { name: "减少天数", exact: true }).click();
  return page.getByRole("dialog", { name: "减少会员天数" });
}
async function submit(page: Page) {
  const done = page.waitForResponse(
    (response) => response.url().endsWith("/reduce-days") && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "确认减少天数" }).click();
  return done;
}

test("two admin previews cannot double deduct and an existing portal session follows expiry and card recovery", async ({
  browser,
  playwright,
}, info) => {
  const fixture = await startMemberRegistrationFixture();
  const desktop = await browser.newContext({ baseURL: fixture.baseURL, viewport: { width: 1440, height: 900 } });
  const mobile = await browser.newContext({ baseURL: fixture.baseURL, viewport: { width: 320, height: 640 } });
  const portal = await playwright.request.newContext({ baseURL: fixture.baseURL });
  const external: string[] = [];
  for (const context of [desktop, mobile])
    await context.route("**/*", (route) => {
      const url = new URL(route.request().url());
      if (url.origin === fixture.baseURL || !["http:", "https:"].includes(url.protocol)) return route.continue();
      external.push(url.origin);
      return route.abort();
    });
  try {
    await login(desktop.request);
    await login(mobile.request);
    const email = "deep-reduction@example.invalid";
    const expiry = new Date(Date.now() + 5 * day).toISOString();
    expect(
      (
        await desktop.request.post("/api/submission-users", { data: { email, subscriptionExpiresAt: expiry } })
      ).status(),
    ).toBe(201);
    const original = (await members(desktop.request)).find((member) => member.email === email)!;
    expect((await portal.post(`${subscriptions}/code`, { data: { email } })).status()).toBe(200);
    expect(
      (await portal.post(`${subscriptions}/login`, { data: { email, code: fixture.codeFor(email) } })).status(),
    ).toBe(200);
    expect((await portal.get("/api/public/library/list?limit=1")).status()).toBe(200);
    const [first, second] = await Promise.all([desktop.newPage(), mobile.newPage()]);
    await Promise.all([first.goto("/login/submissions"), second.goto("/login/submissions")]);
    const a = await open(first, email);
    const b = await open(second, email);
    await a.getByLabel("减少天数", { exact: true }).fill("1");
    await a.getByLabel("扣减原因（可选）").fill("核对 <script> & 邮件安全");
    await b.getByLabel("减少天数", { exact: true }).fill("10");
    expect((await submit(first)).status()).toBe(200);
    expect((await submit(second)).status()).toBe(409);
    await expect(b.getByText(/会员有效期或待激活时长已变更/)).toBeVisible();
    await expect(b.getByRole("button", { name: "确认减少天数" })).toBeDisabled();
    expect((await members(desktop.request)).find((member) => member.id === original.id)?.subscriptionExpiresAt).toBe(
      new Date(Date.parse(expiry) - day).toISOString(),
    );
    let receipts = fixture.messages.filter(
      (message) => message.recipient === email && message.text.includes("本次扣减"),
    );
    expect(receipts).toHaveLength(1);
    expect(receipts[0]!.text).toContain("核对 <script> & 邮件安全");
    expect(receipts[0]!.html).toContain("&lt;script&gt;");
    expect(receipts[0]!.html).not.toContain("<script>");
    await b.getByRole("button", { name: "取消" }).click();
    await second.reload();
    const current = await open(second, email);
    await current.getByLabel("减少天数", { exact: true }).fill("10");
    await expect(current.getByRole("alert")).toContainText("扣减后已过期");
    await expect(current).toHaveCSS("opacity", "1");
    expect(await second.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await current.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    await second.screenshot({ path: info.outputPath("reduction-320.png"), animations: "disabled" });
    expect((await submit(second)).status()).toBe(200);
    const restricted = await portal.get("/api/public/library/list?limit=1");
    expect(restricted.status()).toBe(403);
    expect(await restricted.json()).toMatchObject({ error: "membership_expired" });
    const self = await portal.get(`${subscriptions}/member`);
    expect(self.status()).toBe(200);
    expect(await self.json()).toMatchObject({ member: { status: "expired", contentAccess: false } });
    expect((await portal.get(`${subscriptions}/member/profile`)).status()).toBe(200);
    expect(
      (await portal.post(`${subscriptions}/member/emby/password`, { data: { password: "blocked-password" } })).status(),
    ).toBe(403);
    const forged = await portal.post(`/api/submission-users/${original.id}/reduce-days`, { data: {} });
    expect(forged.status()).toBe(401);
    const generated = await desktop.request.post("/api/cards", { data: { kind: "month", count: 1 } });
    expect(generated.status()).toBe(201);
    const cardCode = (await generated.json()).codes[0];
    expect((await portal.post(`${subscriptions}/code`, { data: { email, cardCode } })).status()).toBe(200);
    const restored = await portal.post(`${subscriptions}/activate`, {
      data: { email, cardCode, code: fixture.codeFor(email) },
    });
    expect(restored.status()).toBe(200);
    expect(await restored.json()).toMatchObject({ member: { contentAccess: true } });
    expect((await portal.get("/api/public/library/list?limit=1")).status()).toBe(200);
    receipts = fixture.messages.filter((message) => message.recipient === email && message.text.includes("本次扣减"));
    expect(receipts).toHaveLength(2);
    expect(receipts[1]!.text).toContain("本次扣减：10 天");
    expect(receipts[1]!.text).toContain("扣减后待激活时长：0 天");
    expect(external).toEqual([]);
    expect(fixture.unexpected).toEqual([]);
    expect(fixture.unexpectedEmbyRequests).toEqual([]);
    expect(fixture.blockedRequests()).toEqual([]);
  } finally {
    await Promise.allSettled([desktop.close(), mobile.close(), portal.dispose()]);
    await fixture.close();
  }
});

test("unlimited and drive-following members have no reduction action and SMTP failure does not undo a saved reduction", async ({
  browser,
}) => {
  const fixture = await startMemberRegistrationFixture();
  const context = await browser.newContext({ baseURL: fixture.baseURL, viewport: { width: 390, height: 844 } });
  try {
    await context.route("**/*", (route) =>
      new URL(route.request().url()).origin === fixture.baseURL ? route.continue() : route.abort(),
    );
    const api = context.request;
    await login(api);
    const unlimitedEmail = "unlimited@example.invalid";
    const finiteEmail = "smtp-reduction@example.invalid";
    for (const [email, subscriptionExpiresAt] of [
      [unlimitedEmail, null],
      [finiteEmail, new Date(Date.now() + 30 * day).toISOString()],
    ]) {
      expect((await api.post("/api/submission-users", { data: { email, subscriptionExpiresAt } })).status()).toBe(201);
    }
    const page = await context.newPage();
    await page.goto("/login/submissions");
    const row = page.getByRole("row", { name: new RegExp(unlimitedEmail) });
    await row.getByRole("button", { name: "详情与操作" }).click();
    await expect(row.getByRole("button", { name: "减少天数", exact: true })).toHaveCount(0);
    const unlimited = (await members(api)).find((member) => member.email === unlimitedEmail)!;
    const request = {
      requestId: randomUUID(),
      expectedExpiresAt: null,
      expectedDeferredMembershipMs: 0,
      expectedDriveExpiryDate: null,
      days: 1,
    };
    expect((await api.post(`/api/submission-users/${unlimited.id}/reduce-days`, { data: request })).status()).toBe(409);
    const capDate = new Date(Date.now() + 60 * day).toISOString().slice(0, 10);
    expect(
      (await api.put("/api/membership-drive-expiry", { data: { date: capDate, expectedDate: null } })).status(),
    ).toBe(200);
    await page.reload();
    await row.getByRole("button", { name: "详情与操作" }).click();
    await expect(row.getByText("长期跟随网盘")).toBeVisible();
    await expect(row.getByRole("button", { name: "减少天数", exact: true })).toHaveCount(0);
    const following = (await members(api)).find((member) => member.id === unlimited.id)!;
    expect(
      (
        await api.post(`/api/submission-users/${unlimited.id}/reduce-days`, {
          data: {
            ...request,
            requestId: randomUUID(),
            expectedExpiresAt: following.subscriptionExpiresAt,
            expectedDriveExpiryDate: capDate,
          },
        })
      ).status(),
    ).toBe(409);
    const finite = (await members(api)).find((member) => member.email === finiteEmail)!;
    fixture.setSmtpFailure(true);
    const dialog = await open(page, finiteEmail);
    await dialog.getByLabel("减少天数", { exact: true }).fill("2");
    expect((await submit(page)).status()).toBe(200);
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText(/通知邮件待发送，系统将自动补发；无需重复扣减/)).toBeVisible();
    const saved = (await members(api)).find((member) => member.id === finite.id)!;
    expect(saved.subscriptionExpiresAt).toBe(
      new Date(Date.parse(finite.subscriptionExpiresAt!) - 2 * day).toISOString(),
    );
    expect(
      fixture.messages.filter((message) => message.recipient === finiteEmail && message.text.includes("本次扣减")),
    ).toHaveLength(0);
    await fixture.restart();
    expect((await members(api)).find((member) => member.id === finite.id)?.subscriptionExpiresAt).toBe(
      saved.subscriptionExpiresAt,
    );
    expect(fixture.unexpected).toEqual([]);
    expect(fixture.unexpectedEmbyRequests).toEqual([]);
    expect(fixture.blockedRequests()).toEqual([]);
  } finally {
    await context.close();
    await fixture.close();
  }
});
