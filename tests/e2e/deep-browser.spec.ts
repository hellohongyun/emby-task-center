import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { startIsolatedServer } from "./real-server";

let application: Awaited<ReturnType<typeof startIsolatedServer>>;
let context: BrowserContext;
let page: Page;
const external: string[] = [];
test.describe.configure({ mode: "serial" });

async function login() {
  await page.goto(`${application.baseURL}/login/tasks`);
  const password = page.getByLabel("管理员口令");
  await expect(password.or(page.locator(".app-shell"))).toBeVisible();
  if (await password.isVisible()) {
    await page.getByLabel("管理员账号").fill("admin");
    await password.fill("admin123");
    await page.getByRole("button", { name: "进入任务中心" }).click();
  }
  await expect(page.locator(".app-shell")).toBeVisible();
}
const navigate = (name: string) =>
  page.getByRole("navigation", { name: "主导航" }).getByRole("button", { name, exact: true }).click();

test.beforeAll(async ({ browser }) => {
  application = await startIsolatedServer();
  context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== application.baseURL && ["http:", "https:"].includes(url.protocol)) {
      external.push(url.origin + url.pathname);
      await route.abort();
    } else await route.continue();
  });
  page = await context.newPage();
});
test.afterAll(async () => {
  try {
    await context?.close();
    if (application) {
      expect(application.blockedRequests()).toEqual([]);
      expect(application.fixture.unexpected).toEqual([]);
      expect(external).toEqual([]);
    }
  } finally {
    await application?.close();
  }
});

test("a held scan does not block real task reads or poison another page after leaving the library", async () => {
  await login();
  await expect
    .poll(async () => {
      const response = await context.request.get(`${application.baseURL}/api/library/roots`);
      return (await response.json()).roots[0]?.lastScanStatus;
    })
    .toBe("completed");
  await navigate("媒体库");
  await expect(page.getByRole("button", { name: "查看 隔离测试电影", exact: true })).toBeVisible();
  const gate = application.fixture.pause("/Items");
  try {
    await page.getByRole("button", { name: "立即扫描", exact: true }).click();
    await gate.entered;
    await navigate("任务中心");
    const tasks = await context.request.get(`${application.baseURL}/api/tasks`, { timeout: 5_000 });
    expect(tasks.status()).toBe(200);
    expect((await tasks.json()).tasks).toEqual([]);
    await expect(page.getByRole("heading", { name: "任务看板", exact: true })).toBeVisible();
    await navigate("系统设置");
    await expect(page.getByRole("heading", { name: "并发超限升级", exact: true })).toBeVisible();
  } finally {
    gate.release();
  }
  await expect
    .poll(async () => {
      const response = await context.request.get(`${application.baseURL}/api/library/roots`);
      return (await response.json()).roots[0]?.lastScanStatus;
    })
    .toBe("completed");
  await expect(page.getByRole("heading", { name: "系统设置", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "隔离测试电影库" })).toHaveCount(0);
  await navigate("媒体库");
  await expect(page.getByRole("button", { name: "查看 隔离测试电影", exact: true })).toBeVisible();
});

test("logout wins over an in-flight account read and a new login remains usable", async () => {
  const gate = application.fixture.pause("/Users");
  try {
    await navigate("会员与运营");
    await gate.entered;
    const loggedOut = page.waitForResponse((response) => response.url().endsWith("/api/auth/logout"));
    await page.getByRole("navigation", { name: "主导航" }).getByRole("button", { name: "退出登录" }).click();
    expect((await loggedOut).status()).toBe(204);
    await expect(page.getByLabel("管理员口令")).toBeVisible();
  } finally {
    gate.release();
  }
  expect((await context.request.get(`${application.baseURL}/api/tasks`)).status()).toBe(401);
  await expect(page.locator(".app-shell")).toHaveCount(0);
  await login();
  await navigate("会员与运营");
  await expect(page.getByRole("heading", { name: "会员与运营", exact: true })).toBeVisible();
  expect((await context.request.get(`${application.baseURL}/api/emby/users`)).status()).toBe(200);
});

test("current task creation UI searches the local upstream and persists through the real API", async () => {
  await navigate("任务中心");
  await page.getByRole("button", { name: "新建任务", exact: true }).click();
  const drawer = page.getByRole("dialog", { name: "新建任务" });
  await drawer.getByPlaceholder("输入剧名或片名搜索 TMDB").fill("联动电影");
  await drawer.getByRole("button", { name: "搜索", exact: true }).click();
  const candidate = drawer.getByRole("button", { name: /API 隔离测试任务/ });
  await expect(candidate).toBeVisible();
  const gate = application.fixture.pause("/tmdb/3/movie/900001");
  const created = page.waitForResponse(
    (response) => response.url().endsWith("/api/tasks") && response.request().method() === "POST",
  );
  try {
    await candidate.click();
    await gate.entered;
    await expect(candidate).toBeDisabled();
  } finally {
    gate.release();
  }
  const response = await created;
  expect(response.status()).toBe(201);
  const taskId = (await response.json()).task.id;
  await expect(drawer).toHaveCount(0);
  await expect(page.getByText("API 隔离测试任务", { exact: true }).first()).toBeVisible();
  await page.reload();
  await expect(page.getByText("API 隔离测试任务", { exact: true }).first()).toBeVisible();
  const tasks = (await (await context.request.get(`${application.baseURL}/api/tasks`)).json()).tasks;
  expect(tasks.filter((task: { id: number }) => task.id === taskId)).toHaveLength(1);
});

test("closing and reopening the task drawer isolates a delayed real search", async () => {
  await navigate("任务中心");
  await page.getByRole("button", { name: "新建任务", exact: true }).click();
  const drawer = page.getByRole("dialog", { name: "新建任务" });
  const initialSearches = application.fixture.hits.filter((hit) => hit.path === "/tmdb/3/search/multi").length;
  const gate = application.fixture.pause("/tmdb/3/search/multi");
  try {
    await drawer.getByPlaceholder("输入剧名或片名搜索 TMDB").fill("联动慢搜索");
    await drawer.getByRole("button", { name: "搜索", exact: true }).click();
    await gate.entered;
    await drawer.getByRole("button", { name: "关闭", exact: true }).click();
    await page.getByRole("button", { name: "新建任务", exact: true }).click();
    await drawer.getByPlaceholder("输入剧名或片名搜索 TMDB").fill("不匹配电影");
    await drawer.getByRole("button", { name: "搜索", exact: true }).click();
    await expect
      .poll(() => application.fixture.hits.filter((hit) => hit.path === "/tmdb/3/search/multi").length)
      .toBe(initialSearches + 2);
    await expect(drawer.getByRole("button", { name: "搜索中…", exact: true })).toBeDisabled();
  } finally {
    gate.release();
  }
  await expect(drawer.getByRole("status")).toHaveText("没有找到片名，换个关键词试试。");
  await expect(drawer.getByRole("button", { name: /API 隔离测试任务/ })).toHaveCount(0);
  await expect(drawer.getByRole("button", { name: "搜索", exact: true })).toBeEnabled();
  await drawer.getByRole("button", { name: "关闭", exact: true }).click();
});

test("mobile navigation reaches the same live settings and member APIs", async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login();
  await page.getByRole("button", { name: "更多菜单" }).click();
  await page.getByRole("dialog", { name: "更多功能" }).getByRole("button", { name: "系统设置", exact: true }).click();
  await expect(page.getByRole("heading", { name: "系统设置", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "更多菜单" }).click();
  await page.getByRole("dialog", { name: "更多功能" }).getByRole("button", { name: "会员与运营", exact: true }).click();
  await expect(page.getByRole("heading", { name: "会员与运营", exact: true })).toBeVisible();
  await page.getByRole("navigation", { name: "会员与运营分区" }).getByRole("button", { name: "使用记录" }).click();
  expect((await context.request.get(`${application.baseURL}/api/member-usage/overview?days=7`)).status()).toBe(200);
});
