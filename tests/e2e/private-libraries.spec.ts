import { expect, test } from "@playwright/test";
import BetterSqlite3 from "better-sqlite3";
import { resolve } from "node:path";
import { freePort, startIsolatedServer } from "./real-server";
import { startMarketFixture } from "./market-fixture";

const endpoint = "/api/public/virtual-libraries";
const emails = ["private-owner@example.test", "private-other@example.test"];

function seed(databasePath: string) {
  const db = new BetterSqlite3(databasePath, { fileMustExist: true });
  try {
    const now = new Date().toISOString();
    for (const [i, email] of emails.entries()) {
      db.prepare(
        "INSERT INTO submission_users (email, emby_user_id, emby_username, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      ).run(email, i === 0 ? "fixture-user" : "other-user", email, now, now);
      db.prepare("INSERT INTO verification_codes (email, code, expires_at, created_at) VALUES (?, ?, ?, ?)").run(
        email,
        "314159",
        new Date(Date.now() + 600_000).toISOString(),
        now,
      );
    }
  } finally {
    db.close();
  }
}

test("private libraries persist, stay owner-only, and precede public libraries", async ({ browser }) => {
  test.setTimeout(120_000);
  const application = await startIsolatedServer({
    seedDatabase: seed,
    startUpstream: () => startMarketFixture({ emails }),
  });
  const owner = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const other = await browser.newContext();
  const admin = await browser.newContext();
  owner.setDefaultTimeout(15_000);
  try {
    for (const [i, context] of [owner, other].entries()) {
      const login = await context.request.post(application.baseURL + "/api/public/subscriptions/login", {
        data: { email: emails[i], code: "314159" },
      });
      expect(login.status()).toBe(200);
    }
    const login = await admin.request.post(application.baseURL + "/api/auth/login", {
      data: { username: "admin", password: "admin123" },
    });
    expect(login.status()).toBe(200);
    const shared = await admin.request.post(application.baseURL + "/api/virtual-libraries", {
      data: { name: "公共精选", sortOrder: -999 },
    });
    expect(shared.status()).toBe(201);
    const sharedId = (await shared.json()).library.id;
    expect(
      (
        await admin.request.put(`${application.baseURL}/api/virtual-library-market/owned/${sharedId}/publication`, {
          data: { published: true },
        })
      ).status(),
    ).toBe(200);
    for (const context of [owner, other])
      expect(
        (
          await context.request.put(
            `${application.baseURL}/api/public/virtual-library-market/${sharedId}/subscription`,
            { data: { enabled: true } },
          )
        ).status(),
      ).toBe(200);
    const page = await owner.newPage();
    // Avoid external poster/avatar requests; the application and source are local fixtures.
    await page.route("**/*", (route) =>
      new URL(route.request().url()).origin === application.baseURL ? route.continue() : route.abort(),
    );
    await page.goto(application.baseURL + "/");
    await page.getByRole("checkbox", { name: /14 天免打扰/ }).check();
    await page.getByRole("button", { name: "我知道了", exact: true }).click();
    await page
      .getByRole("navigation", { name: "移动端导航" })
      .getByRole("button", { name: "虚拟库", exact: true })
      .click();
    await page.getByRole("button", { name: /新建虚拟媒体库/ }).click();
    await page.getByLabel("媒体库名称").fill("我的小众精选");
    await page.getByLabel("排序", { exact: true }).fill("5");
    await page.getByRole("button", { name: "保存媒体库", exact: true }).click();
    await expect(page.getByRole("heading", { name: "我的小众精选", exact: true })).toBeVisible();
    await expect(page.getByRole("checkbox", { name: "启用客户端反代" })).toHaveCount(0);
    await page.getByRole("combobox", { name: "源媒体库", exact: true }).selectOption("fixture-movies");
    await page.getByRole("button", { name: "搜索", exact: true }).click();
    await page.getByRole("checkbox", { name: "选择 隔离测试电影", exact: true }).check();
    await page.getByRole("button", { name: "加入已选（1）" }).click();
    await expect(
      page.getByRole("region", { name: "已加入的内容" }).getByText("隔离测试电影", { exact: true }),
    ).toBeVisible();
    const list = await (await owner.request.get(application.baseURL + endpoint)).json();
    const id = list.libraries[0].id;
    expect(list.libraries).toHaveLength(1);
    const original = Buffer.from(
      await page.evaluate(() => {
        const canvas = document.createElement("canvas");
        canvas.width = 2400;
        canvas.height = 1600;
        const context = canvas.getContext("2d")!;
        const gradient = context.createLinearGradient(0, 0, 2400, 1600);
        gradient.addColorStop(0, "#214f72");
        gradient.addColorStop(1, "#dfa469");
        context.fillStyle = gradient;
        context.fillRect(0, 0, 2400, 1600);
        return canvas.toDataURL("image/png").split(",")[1];
      }),
      "base64",
    );
    const posterUrl = `${application.baseURL}${endpoint}/${id}/poster`;
    let uploadedSize = 0;
    await page.route(posterUrl, async (route) => {
      if (route.request().method() !== "PUT") return route.continue();
      uploadedSize = route.request().postDataBuffer()!.length;
      const result = await route.fetch();
      // Slow response must outlive the old 15-second browser deadline.
      await new Promise((done) => setTimeout(done, 16_000));
      await route.fulfill({ response: result });
    });
    await page
      .locator('input[type="file"]')
      .setInputFiles({ name: "poster.png", mimeType: "image/png", buffer: original });
    const savePoster = page.getByRole("button", { name: "保存海报", exact: true });
    await expect(savePoster).toBeEnabled();
    await savePoster.click();
    await expect(page.getByText("媒体库海报已保存，客户端刷新后可见", { exact: true })).toBeVisible({
      timeout: 25_000,
    });
    expect(uploadedSize).toBeGreaterThan(0);
    expect(uploadedSize).toBeLessThan(original.length);
    await expect(
      page.getByRole("region", { name: "媒体库海报" }).getByAltText("我的小众精选媒体库海报"),
    ).toHaveJSProperty("naturalWidth", 1600);
    await expect(page.locator(".vl-library-thumb").first()).toHaveJSProperty("naturalWidth", 1600);
    await page.unroute(posterUrl);
    const second = await owner.request.post(application.baseURL + endpoint, {
      data: { name: "最前面的私人库", sortOrder: -1 },
    });
    const secondId = (await second.json()).library.id;
    expect((await (await other.request.get(application.baseURL + endpoint)).json()).libraries).toEqual([]);
    expect(
      (await (await admin.request.get(application.baseURL + "/api/virtual-libraries")).json()).libraries.map(
        (library: { id: string }) => library.id,
      ),
    ).toEqual([sharedId]);
    for (const suffix of ["/items", "/poster"]) {
      expect((await other.request.get(`${application.baseURL}${endpoint}/${id}${suffix}`)).status()).toBe(404);
    }
    expect(
      (await other.request.patch(`${application.baseURL}${endpoint}/${id}`, { data: { name: "越权" } })).status(),
    ).toBe(404);
    const port = await freePort();
    expect(
      (
        await admin.request.put(application.baseURL + "/api/virtual-libraries/proxy", {
          data: { enabled: true, port, upstream: application.fixture.baseURL },
        })
      ).status(),
    ).toBe(200);
    const proxy = `http://127.0.0.1:${port}`;
    for (const [index, context] of [owner, other].entries()) {
      const login = await context.request.post(proxy + "/Users/AuthenticateByName", {
        data: { Username: emails[index], Pw: "fixture-password" },
      });
      expect(login.status()).toBe(200);
    }
    const views = await owner.request.get(proxy + "/Users/fixture-user/Views", {
      headers: { "X-Emby-Token": "owner-token" },
    });
    expect((await views.json()).Items.map((item: { Id: string }) => item.Id)).toEqual([
      secondId,
      id,
      "fixture-movies",
      sharedId,
    ]);
    for (const path of [`/Items/${id}`, `/Items?ParentId=${id}`, `/Items/${id}/Images/Primary`]) {
      expect((await other.request.get(proxy + path, { headers: { "X-Emby-Token": "other-token" } })).status()).toBe(
        404,
      );
    }
    const updated = await (await owner.request.get(application.baseURL + endpoint)).json();
    const tag = updated.libraries.find((library: { id: string }) => library.id === id).posterImageTag;
    const imageUrl = `${proxy}/Items/${id}/Images/Primary?tag=${tag}`;
    expect((await other.request.get(imageUrl)).status()).toBe(404);
    expect((await owner.request.get(imageUrl, { headers: { "X-Emby-Token": "owner-token" } })).status()).toBe(200);
    const spoofed = await other.request.get(proxy + "/Users/fixture-user/Views", {
      headers: { "X-Emby-Token": "other-token" },
    });
    expect((await spoofed.json()).Items.map((item: { Id: string }) => item.Id)).toEqual(["fixture-movies"]);
    await application.restart();
    await page.reload();
    await page
      .getByRole("navigation", { name: "移动端导航" })
      .getByRole("button", { name: "虚拟库", exact: true })
      .click();
    await page.getByRole("button", { name: /我的小众精选 混合/ }).click();
    await expect(
      page.getByRole("region", { name: "已加入的内容" }).getByText("隔离测试电影", { exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("region", { name: "媒体库海报" }).getByAltText("我的小众精选媒体库海报")).toBeVisible();
    const restored = await owner.request.get(proxy + "/Users/fixture-user/Views", {
      headers: { "X-Emby-Token": "owner-token" },
    });
    expect((await restored.json()).Items.map((item: { Id: string }) => item.Id)).toEqual([
      secondId,
      id,
      "fixture-movies",
      sharedId,
    ]);
    for (const width of [320, 390, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    await page.screenshot({ path: resolve(".local/private-libraries-desktop.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: resolve(".local/private-libraries-mobile.png"), fullPage: true });
  } finally {
    await Promise.allSettled([owner.close(), other.close(), admin.close()]);
    await application.close();
  }
});
