import { expect, test } from "@playwright/test";
import { freePort, startIsolatedServer } from "./real-server";
import { marketEmails, seedMarketMembers } from "./market-fixture";
import { startUpstreamMarketFixture, upstreamMarketLibraries } from "./upstream-market-fixture";

test("TgtoDrive libraries enter the market while native libraries and upstream ownership remain intact", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const ttd = await startUpstreamMarketFixture(true);
  const app = await startIsolatedServer({
    seedDatabase: seedMarketMembers,
    startUpstream: () => startUpstreamMarketFixture(false),
    additionalUpstreams: [ttd.baseURL],
  });
  const admin = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const owner = await browser.newContext();
  const other = await browser.newContext();
  try {
    expect(
      (
        await admin.request.post(app.baseURL + "/api/auth/login", { data: { username: "admin", password: "admin123" } })
      ).status(),
    ).toBe(200);
    for (const [index, context] of [owner, other].entries())
      expect(
        (
          await context.request.post(app.baseURL + "/api/public/subscriptions/login", {
            data: { email: marketEmails[index], code: "314159" },
          })
        ).status(),
      ).toBe(200);
    const port = await freePort();
    expect(
      (
        await admin.request.put(app.baseURL + "/api/virtual-libraries/proxy", {
          data: { enabled: true, port, upstream: ttd.baseURL },
        })
      ).status(),
    ).toBe(200);
    expect(
      (
        await admin.request.patch(app.baseURL + "/api/virtual-library-market/defaults", {
          data: { adminEmbyUserId: "fixture-user" },
        })
      ).status(),
    ).toBe(200);
    const page = await admin.newPage();
    await page.route("**/*", (route) =>
      new URL(route.request().url()).origin === app.baseURL ? route.continue() : route.abort(),
    );
    await page.goto(app.baseURL + "/login/virtual-libraries");
    await page
      .getByRole("navigation", { name: "虚拟媒体库功能" })
      .getByRole("button", { name: "媒体库市场", exact: true })
      .click();
    await page.getByRole("button", { name: "管理接入", exact: true }).click();
    await page.getByRole("button", { name: "同步来源列表", exact: true }).click();
    await expect(page.getByRole("heading", { name: "待接入 2 个", exact: true })).toBeVisible();
    await expect(page.getByRole("checkbox", { name: "接入 Emby 合集", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "全选待接入", exact: true }).click();
    await page.getByRole("button", { name: "接入选中的 2 个库", exact: true }).click();
    await expect(page.getByRole("heading", { name: "已接入 2 个", exact: true })).toBeVisible();
    const market = await (await owner.request.get(app.baseURL + "/api/public/virtual-library-market")).json();
    const science = market.libraries.find((item: { playbackId: string }) => item.playbackId === "ttd-science");
    const series = market.libraries.find((item: { playbackId: string }) => item.playbackId === "ttd-series");
    expect(science).toMatchObject({ source: "tgtodrive", owned: false, enabled: true });
    expect(series.enabled).toBe(true);
    const others = await (await other.request.get(app.baseURL + "/api/public/virtual-library-market")).json();
    expect(others.libraries.find((item: { id: string }) => item.id === science.id).enabled).toBe(false);
    expect(others.libraries.find((item: { id: string }) => item.id === series.id).enabled).toBe(true);
    const proxy = `http://127.0.0.1:${port}`;
    expect(
      (
        await owner.request.post(proxy + "/Users/AuthenticateByName", {
          data: { Username: marketEmails[0], Pw: "fixture-password" },
        })
      ).status(),
    ).toBe(200);
    const headers = { "X-Emby-Token": "owner-token" };
    const views = async () =>
      (await (await owner.request.get(proxy + "/Users/fixture-user/Views", { headers })).json()).Items as {
        Id: string;
        Ttd?: unknown;
      }[];
    expect((await views()).find((item) => item.Id === "ttd-science")).toMatchObject(upstreamMarketLibraries[0]);
    const folders = await owner.request.get(proxy + "/Users/fixture-user/Items?IncludeItemTypes=CollectionFolder", {
      headers,
    });
    expect((await folders.json()).Items.find((item: { Id: string }) => item.Id === "ttd-science")).toMatchObject(
      upstreamMarketLibraries[0],
    );
    expect((await owner.request.get(`${app.baseURL}/api/public/virtual-libraries`)).status()).toBe(200);
    expect((await (await owner.request.get(`${app.baseURL}/api/public/virtual-libraries`)).json()).libraries).toEqual(
      [],
    );
    const card = page.getByRole("article", { name: "TgtoDrive 科幻精选", exact: true }).last();
    await card.getByRole("button", { name: "关闭媒体库", exact: true }).click();
    await expect(card.getByRole("button", { name: "启用媒体库", exact: true })).toBeVisible();
    expect((await views()).map((item) => item.Id)).toEqual(["fixture-movies", "native-collections", "ttd-series"]);
    for (const path of [
      "/Items/ttd-science",
      "/Items/ttd-science-guid",
      "/Items?ParentId=ttd-science",
      "/Items/ttd-science/Images/Primary?tag=ttd-cover",
    ])
      expect((await owner.request.get(proxy + path, { headers })).status()).toBe(404);
    const catalog = await (await owner.request.get(app.baseURL + "/api/public/virtual-library-order")).json();
    expect(catalog.items.find((item: { id: string }) => item.id === "ttd-series")).toMatchObject({
      kind: "subscribed",
      source: "tgtodrive",
      marketId: series.id,
    });
    expect(catalog.items.some((item: { id: string }) => item.id === "ttd-science")).toBe(false);
    expect(
      (
        await owner.request.put(app.baseURL + "/api/public/virtual-library-order", {
          data: { order: ["ttd-series", "native-collections", "fixture-movies"] },
        })
      ).status(),
    ).toBe(200);
    expect((await views()).map((item) => item.Id)).toEqual(["ttd-series", "native-collections", "fixture-movies"]);
    expect(
      (
        await admin.request.patch(app.baseURL + "/api/virtual-library-market/defaults", {
          data: { libraryIds: [science.id] },
        })
      ).status(),
    ).toBe(200);
    await app.restart();
    expect((await views()).map((item) => item.Id)).toEqual(["ttd-series", "native-collections", "fixture-movies"]);
    expect((await admin.request.post(app.baseURL + "/api/virtual-library-market/upstream/sync")).status()).toBe(200);
    expect((await views()).some((item) => item.Id === "ttd-science")).toBe(false);
    expect(
      (
        await admin.request.put(`${app.baseURL}/api/virtual-library-market/upstream/${series.id}/publication`, {
          data: { published: false },
        })
      ).status(),
    ).toBe(200);
    expect((await views()).some((item) => item.Id === "ttd-series")).toBe(false);
    expect(
      (
        await admin.request.put(`${app.baseURL}/api/virtual-library-market/upstream/${series.id}/publication`, {
          data: { published: true },
        })
      ).status(),
    ).toBe(200);
    expect((await views()).some((item) => item.Id === "ttd-series")).toBe(false);
    // Existing installations may configure the same TTD entry for both sources.
    expect(
      (
        await admin.request.patch(app.baseURL + "/api/settings", {
          data: { values: { "emby.baseUrl": ttd.baseURL } },
        })
      ).status(),
    ).toBe(200);
    const sameEntry = await admin.request.post(app.baseURL + "/api/virtual-library-market/upstream/sync");
    expect(sameEntry.status()).toBe(200);
    expect((await sameEntry.json()).candidates.map((item: { sourceId: string }) => item.sourceId)).toEqual([
      "ttd-science",
      "ttd-series",
    ]);
    expect((await views()).some((item) => item.Id === "ttd-series")).toBe(false);
    await page.reload();
    await page
      .getByRole("navigation", { name: "虚拟媒体库功能" })
      .getByRole("button", { name: "媒体库市场", exact: true })
      .click();
    for (const width of [320, 390, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    expect(app.blockedRequests()).toEqual([]);
    expect(app.fixture.unexpected).toEqual([]);
    expect(ttd.unexpected).toEqual([]);
  } finally {
    await Promise.allSettled([admin.close(), owner.close(), other.close()]);
    await app.close();
    await ttd.close();
  }
});
