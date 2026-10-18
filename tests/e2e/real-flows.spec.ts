import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { startIsolatedServer } from "./real-server";

/** Real built app + migrated temporary SQLite; Emby and TMDB use local HTTP fixtures.
 * Run: pnpm build && pnpm exec playwright test -c playwright.real.config.ts
 * No production .env, external TMDB/Emby/SMTP, or old STRM/Webhook flows.
 */
let application: Awaited<ReturnType<typeof startIsolatedServer>>;
let context: BrowserContext;
let page: Page;
const browserExternalRequests: string[] = [];

async function login() {
  await page.goto(`${application.baseURL}/login/tasks`);
  const password = page.getByLabel("管理员口令");
  if (await password.isVisible()) {
    await page.getByLabel("管理员账号").fill("admin");
    await password.fill("admin123");
    await page.getByRole("button", { name: "进入任务中心" }).click();
  }
  await expect(page.locator(".app-shell")).toBeVisible();
}

test.describe.configure({ mode: "serial" });
test.beforeAll(async ({ browser }) => {
  application = await startIsolatedServer();
  context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== application.baseURL && ["http:", "https:"].includes(url.protocol)) {
      browserExternalRequests.push(url.origin + url.pathname);
      await route.abort();
    } else await route.continue();
  });
  page = await context.newPage();
});
test.afterAll(async () => {
  try {
    await context?.close();
    if (application) {
      expect(application.blockedRequests(), "Server must not attempt external network requests").toEqual([]);
      expect(browserExternalRequests, "Browser must not attempt external network requests").toEqual([]);
      expect(application.fixture.unexpected, "Unexpected Emby requests").toEqual([]);
    }
  } finally {
    await application?.close();
  }
});

test("health and PWA resources come from the compiled app", async () => {
  const health = await context.request.get(`${application.baseURL}/health`);
  expect(health.status()).toBe(200);
  for (const path of [
    "/manifest.json",
    "/sw.js",
    "/icons/icon-192.png",
    "/icons/icon-512.png",
    "/icons/icon-maskable-512.png",
  ]) {
    const response = await context.request.get(application.baseURL + path);
    expect(response.status(), path).toBe(200);
    expect(response.headers()["content-type"], path).not.toContain("text/html");
  }
});

test("admin auth rejects wrong credentials and opens the current task board", async () => {
  expect((await context.request.get(`${application.baseURL}/api/tasks`)).status()).toBe(401);
  await page.goto(`${application.baseURL}/login/tasks`);
  await page.getByLabel("管理员账号").fill("admin");
  await page.getByLabel("管理员口令").fill("wrong-password");
  await page.getByRole("button", { name: "进入任务中心" }).click();
  await expect(page.getByText("管理员口令不正确。")).toBeVisible();
  await page.getByLabel("管理员口令").fill("admin123");
  await page.getByRole("button", { name: "进入任务中心" }).click();
  await expect(page.locator(".app-shell")).toBeVisible();
  await expect(page.getByRole("button", { name: "发布任务", exact: true })).toHaveCount(0);
});

test("task creation API persists a fixture which the actual board reads", async () => {
  await login();
  const input = { tmdbId: 900001, mediaType: "movie", title: "API 隔离测试任务" };
  const create = await context.request.post(`${application.baseURL}/api/tasks`, { data: input });
  expect(create.status()).toBe(201);
  const created = await create.json();
  expect(created.created).toBe(true);
  const duplicate = await context.request.post(`${application.baseURL}/api/tasks`, { data: input });
  expect(duplicate.status()).toBe(200);
  expect((await duplicate.json()).task.id).toBe(created.task.id);
  await page.reload();
  await expect(page.getByText(input.title, { exact: true }).first()).toBeVisible();
  const tasks = await context.request.get(`${application.baseURL}/api/tasks`);
  expect((await tasks.json()).tasks.some((task: { id: number }) => task.id === created.task.id)).toBe(true);
});

test("Emby fixture is scanned and paged media appear through real API and UI", async () => {
  await login();
  await expect
    .poll(async () => {
      const response = await context.request.get(`${application.baseURL}/api/library/roots`);
      return (await response.json()).roots?.[0]?.lastScanStatus;
    })
    .toBe("completed");
  await page.getByRole("navigation", { name: "主导航" }).getByRole("button", { name: "媒体库", exact: true }).click();
  await expect(page.getByRole("heading", { name: "隔离测试电影库" })).toBeVisible();
  await expect(page.getByRole("button", { name: "查看 隔离测试电影", exact: true })).toBeVisible();
  const scan = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/library/roots/fixture-movies/scan") && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "立即扫描", exact: true }).click();
  const scanResponse = await scan;
  expect(scanResponse.status()).toBe(200);
  expect((await scanResponse.json()).discoveredCount).toBe(1);
  await expect(page.getByText("1 个条目 · 1 个作品", { exact: true })).toBeVisible();
  expect(application.fixture.hits.some((hit) => hit.path === "/Library/VirtualFolders")).toBe(true);
  expect(application.fixture.hits.some((hit) => hit.path === "/Items")).toBe(true);
});

test("current settings navigation reads persisted configuration without secrets", async () => {
  await page.getByRole("navigation", { name: "主导航" }).getByRole("button", { name: "系统设置", exact: true }).click();
  await expect(page.getByRole("heading", { name: "系统设置", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "并发超限升级", exact: true })).toBeVisible();
  const response = await context.request.get(`${application.baseURL}/api/settings`);
  expect(response.status()).toBe(200);
  const settings = await response.json();
  const entries = settings.groups.flatMap(
    (group: { settings: Array<{ key: string; value: unknown; hasValue: boolean }> }) => group.settings,
  );
  expect(entries.find((entry: { key: string }) => entry.key === "emby.apiKey")).toMatchObject({
    value: "****",
    hasValue: true,
  });
  expect(JSON.stringify(settings)).not.toContain("local-fixture-only");
});

test("admin logout revokes access and does not authenticate the member portal", async () => {
  for (const path of ["/api/public/library/list", "/api/public/trending"]) {
    expect((await context.request.get(application.baseURL + path)).status(), path).toBe(401);
  }
  await page.getByRole("button", { name: "退出登录", exact: true }).first().click();
  await expect(page.getByLabel("管理员口令")).toBeVisible();
  expect((await context.request.get(`${application.baseURL}/api/tasks`)).status()).toBe(401);
  await page.goto(application.baseURL + "/");
  await expect(page.getByRole("heading", { name: "登录 / 开通会员" })).toBeVisible();
  await expect(page.getByRole("button", { name: "查看 隔离测试电影 详情" })).toHaveCount(0);
});
