import { expect, test } from "@playwright/test";
import { startMemberRegistrationFixture } from "./member-registration-fixture";

test("the compiled app appends workflow logs, groups a run and downloads the filtered history", async ({
  browser,
  playwright,
}, testInfo) => {
  const fixture = await startMemberRegistrationFixture();
  const context = await browser.newContext({
    baseURL: fixture.baseURL,
    viewport: { width: 1440, height: 900 },
    serviceWorkers: "block",
  });
  const visitor = await playwright.request.newContext({ baseURL: fixture.baseURL });
  const browserExternal: string[] = [];
  const admin = context.request;
  const email = "100009045@qq.com";
  const inviteCode = "Logs_Fixture_Invite";
  const subscriptions = "/api/public/subscriptions";
  try {
    await context.route("**/*", (route) => {
      const url = new URL(route.request().url());
      if (url.origin === fixture.baseURL || !["http:", "https:"].includes(url.protocol)) return route.continue();
      browserExternal.push(url.origin + url.pathname);
      return route.abort();
    });
    expect((await admin.post("/api/auth/login", { data: { username: "admin", password: "admin123" } })).ok()).toBe(
      true,
    );
    expect(
      (
        await admin.patch("/api/settings", {
          data: {
            values: {
              "member.groupInviteEnabled": true,
              "member.groupNumber": "889900112",
              "member.groupInviteCode": inviteCode,
            },
          },
        })
      ).ok(),
    ).toBe(true);
    const create = await admin.post("/api/cards", { data: { kind: "trial", count: 1 } });
    expect(create.status()).toBe(201);
    const {
      codes: [cardCode],
    } = (await create.json()) as { codes: string[] };

    const page = await context.newPage();
    await page.goto("/login/logs");
    await expect(page.getByRole("heading", { name: "系统日志" })).toBeVisible();
    await page.getByLabel("模块").selectOption("member-registration");
    await expect(page.getByText("暂无日志")).toBeVisible();

    const wrongInvite = await visitor.post(`${subscriptions}/code`, {
      data: { email, cardCode, inviteCode: "invalid" },
    });
    expect(wrongInvite.status()).toBe(400);
    await expect(page.getByRole("listitem").filter({ hasText: "群邀请码校验失败" })).toHaveClass(/warn/);
    const sent = await visitor.post(`${subscriptions}/code`, { data: { email, cardCode, inviteCode } });
    expect(sent.status()).toBe(200);
    const code = fixture.codeFor(email);
    expect(code).toMatch(/^\d{6}$/);
    const verified = await visitor.post(`${subscriptions}/register/verify`, {
      data: { email, cardCode, inviteCode, code },
    });
    expect(verified.status()).toBe(200);
    const { registrationToken } = (await verified.json()) as { registrationToken: string };
    await expect(page.getByText("邮箱验证通过，等待会员确认资料", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "暂停自动刷新" }).click();
    const activate = await visitor.post(`${subscriptions}/activate`, { data: { email, cardCode, registrationToken } });
    expect(activate.status()).toBe(200);
    await expect(page.getByText("会员注册完成", { exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "恢复自动刷新" }).click();
    const finished = page.getByRole("listitem").filter({ hasText: "会员注册完成" });
    await expect(finished).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("system-logs-desktop.png") });
    await finished.getByRole("button", { name: "查看详情" }).click();
    await finished.getByRole("button", { name: "查看本次执行" }).click();
    await expect(page.getByText("群邀请码校验失败", { exact: true })).toHaveCount(0);
    await expect(page.getByText("注册邮箱验证码已提交给 SMTP", { exact: true })).toBeVisible();

    const downloaded = page.waitForEvent("download");
    await page.getByRole("link", { name: "下载日志" }).click();
    const logFile = await downloaded;
    expect(logFile.suggestedFilename()).toMatch(/\.log$/);
    const stream = await logFile.createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    const text = Buffer.concat(chunks).toString("utf8");
    expect(text).toContain("会员注册完成");
    for (const secret of [inviteCode, email, cardCode, code, registrationToken]) expect(text).not.toContain(secret!);

    await page.getByLabel("执行编号").fill("");
    await page.getByLabel("模块").selectOption("qq-avatar");
    await expect(page.getByText(/Emby 头像已更新/)).toBeVisible();
    await page.getByLabel("模块").selectOption("library-scan");
    await expect(page.getByText("正在从 Emby 分页读取媒体条目", { exact: true }).first()).toBeVisible();
    await expect(page.getByText(/已读取第 1 页/).first()).toBeVisible();
    await expect(page.getByText(/正在保存库存/).first()).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    const panel = page.getByRole("region", { name: "日志记录" });
    expect(await panel.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: testInfo.outputPath("system-logs-mobile.png") });

    const history = Array.from({ length: 80 }, (_, index) => ({
      level: "info",
      source: "web",
      message: `历史夹具 ${index}`,
    }));
    expect((await admin.post("/api/logs", { data: { logs: history } })).status()).toBe(201);
    await page.getByLabel("模块").selectOption("web");
    await expect(page.getByText("历史夹具 79", { exact: true })).toHaveCount(1);
    await expect
      .poll(() => panel.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight))
      .toBeLessThanOrEqual(1);
    await panel.evaluate((element) => {
      element.scrollTop = 32;
    });
    const latest = page.getByRole("button", { name: "跳到最新" });
    await expect(latest).toBeVisible();
    const originalTop = await panel.evaluate((element) => element.scrollTop);
    expect(
      (
        await admin.post("/api/logs", { data: { logs: [{ level: "info", source: "web", message: "新到达的夹具" }] } })
      ).status(),
    ).toBe(201);
    await expect(page.getByText("新到达的夹具", { exact: true })).toHaveCount(1);
    expect(await panel.evaluate((element) => element.scrollTop)).toBe(originalTop);
    await latest.click();
    await expect
      .poll(() => panel.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight))
      .toBeLessThanOrEqual(1);

    await page.getByRole("button", { name: /操作审计/ }).click();
    await expect(page.getByRole("heading", { name: "审计日志" })).toBeVisible();

    expect(fixture.blockedRequests()).toEqual([]);
    expect(fixture.unexpected).toEqual([]);
    expect(fixture.unexpectedEmbyRequests).toEqual([]);
    expect(browserExternal).toEqual([]);
  } finally {
    await visitor.dispose();
    await context.close();
    await fixture.close();
  }
});
