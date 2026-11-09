import { expect, test, type BrowserContext } from "@playwright/test";
import BetterSqlite3 from "better-sqlite3";
import { startIsolatedServer } from "./real-server";
import { startEmbyFixture } from "./real-upstream";

const memberEmail = "share-member@example.test";
const otherEmail = "other-share-member@example.test";
const verificationCode = "314159";
const fixtureToken = "local-share-fixture-token";
const memberPath = "/api/public/115-shares";
const adminPath = "/api/115-shares";

function seedShareSettings(databasePath: string, baseUrl: string) {
  const database = new BetterSqlite3(databasePath, { fileMustExist: true });
  try {
    const now = new Date().toISOString();
    const setting = database.prepare(
      "INSERT INTO app_settings (key, value, is_secret, updated_at) VALUES (?, ?, ?, ?)",
    );
    setting.run("tgto.baseUrl", JSON.stringify(baseUrl), 0, now);
    setting.run("tgto.openApiToken", JSON.stringify(fixtureToken), 1, now);
    setting.run("tgto.share115Enabled", "true", 0, now);
    const expires = new Date(Date.now() + 10 * 60_000).toISOString();
    for (const email of [memberEmail, otherEmail]) {
      database
        .prepare("INSERT INTO submission_users (email, created_at, updated_at) VALUES (?, ?, ?)")
        .run(email, now, now);
      database
        .prepare("INSERT INTO verification_codes (email, code, expires_at, created_at) VALUES (?, ?, ?, ?)")
        .run(email, verificationCode, expires, now);
    }
  } finally {
    database.close();
  }
}

async function memberLogin(context: BrowserContext, baseURL: string, email: string) {
  const result = await context.request.post(baseURL + "/api/public/subscriptions/login", {
    data: { email, code: verificationCode },
  });
  expect(result.status()).toBe(200);
}

test("115 shares from both portals reach the isolated upstream with correct codes and persist after restart", async ({
  browser,
}) => {
  test.setTimeout(75_000);
  const calls: Array<{ authorization: string | undefined; body: Record<string, unknown> }> = [];
  const upstream = await startEmbyFixture({
    handle(request, response, _url, path) {
      if (request.method !== "POST" || path !== "/api/media/resources/transfer") return false;
      request.setEncoding("utf8");
      let raw = "";
      request.on("data", (chunk: string) => (raw += chunk));
      request.once("end", () => {
        const body = JSON.parse(raw) as Record<string, unknown>;
        calls.push({ authorization: request.headers.authorization, body });
        const share = new URL(String(body.share_url));
        const key = share.pathname.split("/").at(-1);
        if (key === "uncertain115") {
          response.writeHead(503, { "content-type": "application/json" }).end(JSON.stringify({ success: false }));
          return;
        }
        response.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            success: true,
            data: {
              success: true,
              already_owned: key === "existing115",
              provider: "115",
              mode: "share",
              target: { folder_id: "123456" },
              transfer: { selected_count: 1 },
              share_title: "夹具 " + key,
            },
          }),
        );
      });
      return true;
    },
  });
  let application: Awaited<ReturnType<typeof startIsolatedServer>> | undefined;
  const contexts: BrowserContext[] = [];
  try {
    application = await startIsolatedServer({
      additionalUpstreams: [upstream.baseURL],
      seedDatabase: (path) => seedShareSettings(path, upstream.baseURL),
    });
    const { baseURL } = application;
    const member = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const admin = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const other = await browser.newContext();
    contexts.push(member, admin, other);
    for (const context of contexts) {
      context.setDefaultTimeout(15_000);
      await context.route("**/*", (route) =>
        new URL(route.request().url()).origin === baseURL ? route.continue() : route.abort(),
      );
    }
    await memberLogin(member, baseURL, memberEmail);
    await memberLogin(other, baseURL, otherEmail);
    const adminLogin = await admin.request.post(baseURL + "/api/auth/login", {
      data: { username: "admin", password: "admin123" },
    });
    expect(adminLogin.status()).toBe(200);
    expect((await member.request.post(baseURL + adminPath, { data: {} })).status()).toBe(401);
    expect((await admin.request.post(baseURL + memberPath, { data: {} })).status()).toBe(401);

    const page = await member.newPage();
    await page.goto(baseURL);
    await page.getByRole("dialog", { name: "平台公告" }).getByRole("button", { name: "我知道了" }).click();
    await page.getByRole("navigation", { name: "移动端导航" }).getByRole("button", { name: "115 转存" }).click();
    const input = page.getByLabel("115 分享链接或文案");
    await input.fill(
      [
        "复制分享：[https://115.com/s/saved115](https://115.com/s/saved115?password=A013)",
        "其他网站 https://example.test/other",
        "https://115cdn.com/s/existing115",
        "- 访问码：B024",
        "https://115.com/s/uncertain115?password=bad",
      ].join("\n"),
    );
    await page.getByRole("button", { name: "提交转存" }).click();
    await expect(page.getByRole("alert")).toContainText("第 3 条链接");
    await expect(input).toHaveValue("https://115.com/s/uncertain115?password=bad");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await expect(page.getByRole("article").filter({ hasText: "夹具 saved115" })).toContainText("已保存");
    await expect(page.getByRole("article").filter({ hasText: "夹具 existing115" })).toContainText("已存在");
    expect((await (await other.request.get(baseURL + memberPath)).json()).items).toEqual([]);

    await input.fill("https://115.com/s/uncertain115?password=C035");
    await page.getByRole("button", { name: "提交转存" }).click();
    await expect(page.getByRole("article").filter({ hasText: "uncertain115" })).toContainText("结果待确认");

    const dashboard = await admin.newPage();
    await dashboard.goto(baseURL + "/login/115-shares");
    await dashboard.getByLabel("115 分享链接或文案").fill("后台分享 https://115.com/s/admin115?password=D046");
    await dashboard.getByRole("button", { name: "提交转存" }).click();
    const administrator = dashboard.getByRole("article").filter({ hasText: "管理员 · admin" });
    await expect(administrator).toContainText("已保存");
    await administrator.getByText("查看详情").click();
    await expect(administrator.getByText("D046", { exact: true })).toBeVisible();

    const unconfirmed = dashboard.getByRole("article").filter({ hasText: "uncertain115" });
    await unconfirmed.getByRole("button", { name: "核对结果" }).click();
    await unconfirmed.getByRole("button", { name: "标记失败" }).click();
    await expect(unconfirmed).toContainText("管理员已核实转存失败");
    await page.getByRole("button", { name: "刷新" }).click();
    await expect(page.getByRole("article").filter({ hasText: "uncertain115" })).toContainText("管理员已核实转存失败");
    expect((await (await member.request.get(baseURL + memberPath)).json()).total).toBe(3);

    await application.restart();
    await dashboard.reload();
    await expect(dashboard.getByRole("article")).toHaveCount(4);
    expect(calls.map(({ body }) => body.share_url)).toEqual([
      "https://115.com/s/saved115?password=A013",
      "https://115.com/s/existing115?password=B024",
      "https://115.com/s/uncertain115?password=C035",
      "https://115.com/s/admin115?password=D046",
    ]);
    for (const call of calls) {
      expect(call.authorization).toBe("Bearer " + fixtureToken);
      expect(call.body).toMatchObject({
        provider: "115",
        source: "guanying",
        enforce_points_limit: true,
        max_points: 0,
      });
    }
    expect(application.blockedRequests()).toEqual([]);
    expect(application.logs()).not.toContain(fixtureToken);
  } finally {
    await Promise.allSettled(contexts.map((context) => context.close()));
    try {
      await application?.close();
    } finally {
      await upstream.close();
    }
  }
});
