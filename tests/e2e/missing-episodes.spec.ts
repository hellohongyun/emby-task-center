import { resolve } from "node:path";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { missingRoots, missingShows, seriesId } from "./missing-fixture-data";
import { startIsolatedServer } from "./real-server";

let application: Awaited<ReturnType<typeof startIsolatedServer>>;
const externalRequests: string[] = [];

test.beforeAll(async () => {
  application = await startIsolatedServer({ missingEpisodes: true });
  // The actual startup scan must finish, including expansion of the single E1–E2 upstream item.
  await expect.poll(() => application.logs()).toContain("library_scan_completed");
});
test.afterAll(async () => {
  try {
    expect(application?.blockedRequests()).toEqual([]);
    expect(externalRequests).toEqual([]);
    expect(application?.fixture.unexpected).toEqual([]);
  } finally {
    await application?.close();
  }
});

async function login(context: BrowserContext, page: Page) {
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (["http:", "https:"].includes(url.protocol) && url.origin !== application.baseURL) {
      externalRequests.push(url.origin + url.pathname);
      await route.abort();
    } else await route.continue();
  });
  await page.goto(`${application.baseURL}/login/missing-episodes`);
  await page.getByLabel("管理员账号").fill("admin");
  await page.getByLabel("管理员口令").fill("admin123");
  await page.getByRole("button", { name: "进入任务中心" }).click();
  await expect(page.getByRole("heading", { name: "缺集总览", exact: true })).toBeVisible();
  await expect(page.getByText("共 1 部剧缺 1 集", { exact: true })).toBeVisible();
}

async function read(context: BrowserContext, root = missingRoots[0].id) {
  const response = await context.request.get(
    `${application.baseURL}/api/missing-episodes?${new URLSearchParams({ rootId: root })}`,
  );
  expect(response.status()).toBe(200);
  return response.json();
}

async function switchLibrary(page: Page, root: number) {
  const response = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/missing-episodes" &&
      new URL(response.url()).searchParams.get("rootId") === missingRoots[root].id,
  );
  await page.getByRole("tab", { name: missingRoots[root].name, exact: true }).click();
  expect((await response).status()).toBe(200);
  await expect(page.getByRole("tab", { name: missingRoots[root].name, exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
}

async function noOverflow(page: Page) {
  await expect
    .poll(() =>
      page.locator(".missing-view").evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        return Math.max(
          document.documentElement.scrollWidth - document.documentElement.clientWidth,
          element.scrollWidth - element.clientWidth,
          -bounds.left,
          bounds.right - innerWidth,
        );
      }),
    )
    .toBeLessThanOrEqual(1);
}

for (const width of [1440, 390]) {
  test(`missing episodes uses independent enabled libraries and safe selection at ${width}px`, async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width, height: 960 } });
    try {
      const page = await context.newPage();
      await login(context, page);
      const first = await read(context);
      expect(first).toMatchObject({ rootId: missingRoots[0].id, showCount: 1, episodeCount: 1 });
      expect(first.libraries.map((root: { rootId: string }) => root.rootId)).toEqual(
        missingRoots.slice(0, 3).map((root) => root.id),
      );
      expect(
        first.shows.find((show: { tmdbId: number }) => show.tmdbId === missingShows[0].tmdbId).seasons[0].episodes,
      ).toEqual([expect.objectContaining({ episodeNumber: 2 })]);
      expect(first.shows.some((show: { tmdbId: number }) => show.tmdbId === missingShows[1].tmdbId)).toBe(false);
      expect(first.shows.find((show: { tmdbId: number }) => show.tmdbId === missingShows[2].tmdbId)).toMatchObject({
        missingCount: 0,
        suspectSeasons: [{ seasonNumber: 1, aired: 41, stored: 20 }],
      });
      await expect(page.getByRole("tab", { name: /停用历史/ })).toHaveCount(0);
      await expect(page.getByText("S01E02", { exact: true })).toBeVisible();
      await expect(page.getByText(/编号体系疑似与 TMDB 不一致/)).toBeVisible();
      await expect(page.getByRole("checkbox", { name: `选择 ${missingShows[2].title}`, exact: true })).toHaveCount(0);
      await expect(page.getByText(missingShows[1].title, { exact: true })).toHaveCount(0);
      await noOverflow(page);
      await page.getByRole("button", { name: "全选当前", exact: true }).click();
      await page.getByRole("button", { name: "删除选中（1）", exact: true }).click();
      const confirmation = page.getByRole("dialog", { name: /从「隔离剧集 A」删除 1 部剧/ });
      await expect(confirmation).toBeVisible();
      await expect(confirmation).toContainText("其他媒体库中的副本保留");
      await confirmation.getByRole("button", { name: "取消", exact: true }).click();
      await switchLibrary(page, 1);
      await expect(page.getByText("S01E01", { exact: true })).toBeVisible();
      await expect(
        page.getByRole("checkbox", { name: `选择 ${missingShows[0].title}`, exact: true }),
      ).not.toBeChecked();
      await expect(page.getByRole("button", { name: "删除选中", exact: true })).toBeDisabled();
      const second = await read(context, missingRoots[1].id);
      expect(second).toMatchObject({ rootId: missingRoots[1].id, showCount: 1, episodeCount: 1 });
      expect(second.shows[0].seasons[0].episodes).toEqual([expect.objectContaining({ episodeNumber: 1 })]);
      expect(second.shows).toHaveLength(1);
      await noOverflow(page);
      await switchLibrary(page, 2);
      await expect(page.getByText("当前媒体库未发现缺集", { exact: true })).toBeVisible();
      await expect(page.getByText("共 0 部剧缺 0 集", { exact: true })).toBeVisible();
      await expect(page.getByRole("tab")).toHaveCount(3);
      await noOverflow(page);
      await switchLibrary(page, 0);
      await expect(page.getByText("S01E02", { exact: true })).toBeVisible();
      if (width === 390)
        await page.screenshot({ path: resolve(".local/missing-episodes-fixed-mobile.png"), fullPage: true });
      expect(application.fixture.hits.filter((hit) => hit.method === "DELETE")).toEqual([]);
    } finally {
      await context.close();
    }
  });
}

test("the public GUID selected by GET deletes only that fixture library and preserves the other copy", async ({
  browser,
}) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  try {
    const page = await context.newPage();
    await login(context, page);
    const first = await read(context);
    expect(first.rootId).toBe(missingRoots[0].id);
    await page.getByRole("checkbox", { name: `选择 ${missingShows[0].title}`, exact: true }).check();
    await page.getByRole("button", { name: "删除选中（1）", exact: true }).click();
    const request = page.waitForRequest(
      (request) => new URL(request.url()).pathname === "/api/missing-episodes/delete",
    );
    await page.getByRole("dialog").getByRole("button", { name: "确认删除 1 部", exact: true }).click();
    expect((await request).postDataJSON()).toEqual({ mediaItemIds: [missingShows[0].id], rootId: first.rootId });
    await expect(page.getByText("已从 Emby 删除 1 部剧。", { exact: true })).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(application.fixture.hits.filter((hit) => hit.method === "DELETE")).toEqual([
      { method: "DELETE", path: `/Items/${seriesId(0, 0)}` },
    ]);
    expect((await read(context)).shows.some((show: { tmdbId: number }) => show.tmdbId === missingShows[0].tmdbId)).toBe(
      false,
    );
    const other = await read(context, missingRoots[1].id);
    expect(other.shows[0]).toMatchObject({ tmdbId: missingShows[0].tmdbId, missingCount: 1 });
    const upstream = await context.request.get(
      `${application.fixture.baseURL}/Items?ParentId=${missingRoots[1].id}&IncludeItemTypes=Series`,
    );
    expect((await upstream.json()).Items).toEqual([expect.objectContaining({ Id: seriesId(1, 0) })]);
  } finally {
    await context.close();
  }
});
