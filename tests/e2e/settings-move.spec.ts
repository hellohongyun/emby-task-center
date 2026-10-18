import { expect, test, type Page } from "@playwright/test";

/**
 * 「运营设置」拆分的端到端验证（真实构建产物，接口用夹具替换）。
 *
 * 2026-09 的调整：
 *   - 追更整体下线 →「会员与运营」只剩 会员 / 使用记录 两段；任务中心看板不再有创建入口；
 *   - 邮件默认、用户邮件代设、公告管理、平台说明与规范 四块搬进「系统设置」。
 */

const articles = [
  {
    code: "announcement",
    title: "平台公告",
    content: "本周五 02:00-04:00 例行维护。",
    enabled: true,
    sort: 1,
    forceSeconds: 5,
  },
  { code: "quickstart", title: "新手必读", content: "欢迎使用影视中心！", enabled: true, sort: 2 },
  { code: "emby-setup", title: "Emby 客户端配置教程", content: "一、下载客户端", enabled: true, sort: 3 },
  { code: "rules", title: "平台使用规范", content: "一、账号使用", enabled: true, sort: 4 },
  { code: "disclaimer", title: "免责声明", content: "本平台仅提供索引与展示。", enabled: true, sort: 5 },
];

async function installFixtures(page: Page): Promise<void> {
  await page.route("**/api/**", async (route) => {
    await route.fulfill({ json: {} });
  });
  await page.route("**/api/auth/lock-status", (route) =>
    route.fulfill({ json: { locked: false, retryAfterSeconds: 0 } }),
  );
  await page.route("**/api/auth/login", (route) => route.fulfill({ status: 204 }));
  await page.route("**/api/integrations/status", (route) =>
    route.fulfill({ json: { emby: { configured: true, ok: true }, email: { configured: true, ok: true } } }),
  );
  // 「全局通知收件人」接口随任务更新通知整条链下线（2026-09），这里不再需要夹具。
  await page.route("**/api/library/roots", (route) => route.fulfill({ json: { roots: [] } }));
  await page.route("**/api/tasks", (route) => route.fulfill({ json: { tasks: [], retentionHours: 24 } }));
  await page.route("**/api/submission-users", (route) => route.fulfill({ json: { users: [] } }));
  await page.route("**/api/emby/users", (route) => route.fulfill({ json: { users: [] } }));
  await page.route("**/api/emby/sessions", (route) => route.fulfill({ json: { sessions: [] } }));
  await page.route("**/api/articles", (route) => route.fulfill({ json: { articles } }));
  await page.route("**/api/settings/mail-defaults", (route) =>
    route.fulfill({ json: { defaults: { membership_reminder: true } } }),
  );
  await page.route("**/api/admin/mail-preferences/user**", (route) =>
    route.fulfill({
      json: {
        mailTypes: [{ key: "membership_reminder", label: "会员临期/到期提醒" }],
        effective: { membership_reminder: true },
        userPrefs: {},
      },
    }),
  );
}

async function login(page: Page): Promise<void> {
  await page.goto("/login/submissions");
  const password = page.getByLabel("管理员口令");
  const heading = page.getByRole("heading", { name: "会员与运营" }).first();
  await Promise.race([
    password.waitFor({ state: "visible", timeout: 25_000 }).catch(() => undefined),
    heading.waitFor({ state: "visible", timeout: 25_000 }).catch(() => undefined),
  ]);
  if (await password.count()) {
    await password.fill("fixture-password");
    await page.getByRole("button", { name: "进入任务中心" }).click();
  }
  await expect(heading).toBeVisible({ timeout: 25_000 });
}

test("会员与运营只剩会员与使用记录两段，运营设置整段消失", async ({ page }) => {
  await installFixtures(page);
  await login(page);

  const tabs = page.getByRole("navigation", { name: "会员与运营分区" });
  await expect(tabs.getByRole("button", { name: "会员" })).toBeVisible();
  await expect(tabs.getByRole("button", { name: "使用记录" })).toBeVisible();
  await expect(tabs.getByRole("button", { name: "运营设置" })).toHaveCount(0);
  // 旧链接（?tab=operations）不会再落到任何一段
  await expect(page.getByRole("heading", { name: "在线播放会话" })).toBeVisible();
  await page.screenshot({ path: ".local/members-two-sections.png", fullPage: true });
});

test("系统设置里能看到搬过来的公告、平台说明与两块邮件偏好", async ({ page }) => {
  await installFixtures(page);
  await login(page);
  await page.goto("/login/config");

  await expect(page.getByRole("heading", { name: "系统设置" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "公告管理（弹窗）" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "平台说明与规范" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "邮件默认发送设置" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "用户邮件代设" })).toBeVisible();
  // 公告正文与"平台说明"列表都来自 /api/articles
  // 用占位符定位公告正文，别用 "第一个 textarea"：系统设置页还在被其它功能（自助解冻等）加新区块。
  await expect(page.getByPlaceholder("输入公告内容（支持换行）")).toHaveValue(/本周五 02:00-04:00 例行维护。/);
  await expect(page.getByText("平台使用规范")).toBeVisible();
  // 邮件类型清单只剩会员提醒：「任务更新通知」整条链（没有发送方）已下线（2026-09），
  // 「追更」字样也早已不存在。
  await expect(page.getByText("会员临期/到期提醒").first()).toBeVisible();
  await expect(page.getByText("任务更新通知")).toHaveCount(0);
  await expect(page.getByText(/追更/)).toHaveCount(0);
  await page.screenshot({ path: ".local/system-settings-content-mail.png", fullPage: true });
});

test("任务中心：搜 TMDB 新建入库任务（追更入口不复存在）", async ({ page }) => {
  await installFixtures(page);
  const created: string[] = [];
  // 看板走的是管理端检索接口 /api/tmdb/search（不是门户的 /api/public/tmdb/search）
  await page.route("**/api/tmdb/search**", (route) =>
    route.fulfill({
      json: {
        results: [
          { id: 70523, mediaType: "tv", title: "暗黑", originalTitle: "Dark", releaseYear: 2017, posterUrl: null },
          {
            id: 603,
            mediaType: "movie",
            title: "黑客帝国",
            originalTitle: "The Matrix",
            releaseYear: 1999,
            posterUrl: null,
          },
        ],
      },
    }),
  );
  await page.route("**/api/tasks", async (route) => {
    if (route.request().method() === "POST") {
      created.push(route.request().postData() ?? "");
      return await route.fulfill({ status: 201, json: { created: true, task: { id: 1 }, seasons: [] } });
    }
    return await route.fulfill({ json: { tasks: [], retentionHours: 24 } });
  });
  await login(page);
  await page.goto("/login/tasks");

  await expect(page.getByRole("heading", { name: "任务看板" })).toBeVisible();
  await expect(page.getByRole("button", { name: "刷新" })).toBeVisible();
  // 追更时代的「追踪剧集」入口不再存在，取而代之的是「新建任务」（完结入库）
  await expect(page.getByRole("button", { name: /追踪剧集/ })).toHaveCount(0);

  await page
    .getByRole("button", { name: /新建任务/ })
    .first()
    .click();
  await expect(page.getByRole("dialog", { name: "新建任务" })).toBeVisible();
  await page.getByPlaceholder("输入剧名或片名搜索 TMDB").fill("暗黑");
  await page.getByRole("button", { name: "搜索" }).click();
  await expect(page.getByRole("button", { name: /新建任务 →/ })).toHaveCount(2);
  // 抽屉自己截图：整页截屏会按窗口高度把抽屉底部的说明裁掉，作为证据看不全。
  await page.getByRole("dialog", { name: "新建任务" }).screenshot({ path: ".local/task-board-create-drawer.png" });

  await page
    .getByRole("button", { name: /新建任务 →/ })
    .first()
    .click();
  await expect.poll(() => created.length).toBe(1);
  expect(JSON.parse(created[0]!)).toMatchObject({ tmdbId: 70523, title: "暗黑", mediaType: "tv" });
});
