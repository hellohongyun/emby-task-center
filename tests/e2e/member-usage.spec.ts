import { expect, test, type Page } from "@playwright/test";

/**
 * 会员使用记录 + 播放会话详情（真实构建产物上的端到端验证，接口用夹具替换）。
 *
 * 覆盖两件事：
 *   ① 在线播放会话详情 —— 对齐 Emby 客户端的播放状态（剧名 S4E4·集名 / 4:39 / 21:07 /
 *      设备与客户端 / 来源 IP / 直接播放 / MKV 6 mbps / 4K HEVC / Chinese EAC3 stereo）；
 *   ② 使用记录页 —— 登录与播放事件、按小时的使用分布、每会员时段条、单会员时间线与热力图。
 *
 * 截图保存在被忽略的 .local/（desktop + mobile + 详情态），不写入源码文档目录。
 */

const member = {
  id: 1,
  email: "1501174757@qq.com",
  enabled: true,
  subscriptionExpiresAt: null,
  embyUsername: "1501174757@qq.com",
  embyUserId: "emby-1",
  embyMaxStreams: 1,
  note: null,
  processPerDay: 2,
  processFirstBatch: 10,
  status: "active",
  concurrency: { overshooting: false, notified: false, disabled: false, disabledUntil: null, remainingMs: null },
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
};

const session = {
  id: "session-1",
  userId: "emby-1",
  userName: "1501174757@qq.com",
  deviceName: "OPPO-PLG110",
  deviceId: "device-1",
  client: "Yamby",
  applicationVersion: "2.0.5.5",
  remoteAddress: "220.197.183.67:52344",
  lastActivityDate: "2026-08-12T12:00:00.000Z",
  item: {
    id: "item-1",
    title: "诛仙",
    episodeTitle: "镇魔古洞",
    type: "Episode",
    seasonNumber: 4,
    episodeNumber: 4,
    displayTitle: "诛仙 S4E4 · 镇魔古洞",
    episodeLabel: "第 4 季 第 4 集",
  },
  nowPlaying: "诛仙 S4E4 · 镇魔古洞",
  nowPlayingType: "Episode",
  runTimeTicks: 12_670_000_000,
  positionTicks: 2_790_000_000,
  positionText: "4:39",
  runTimeText: "21:07",
  isPaused: false,
  playMethod: "DirectPlay",
  playMethodLabel: "直接播放",
  progressPercent: 22.02,
  container: "MKV",
  bitrate: 6_000_000,
  bitrateText: "6 mbps",
  mediaSourceName: "流媒体",
  videoLabel: "4K HEVC",
  videoDirect: true,
  audioLabel: "Chinese EAC3 stereo (默认)",
  audioDirect: true,
  audioStreams: ["Chinese EAC3 stereo (默认)"],
  subtitleLabel: null,
  transcoding: null,
  isPlaying: true,
};

const hourlyA = Array.from({ length: 24 }, (_, hour) => (hour >= 20 && hour <= 22 ? (hour - 19) * 30 : 0));
const hourlyB = Array.from({ length: 24 }, (_, hour) => (hour >= 12 && hour <= 13 ? 45 : 0));

const memberUsageA = {
  key: "email:1501174757@qq.com",
  email: "1501174757@qq.com",
  embyUserId: "emby-1",
  userName: "1501174757@qq.com",
  lastLoginAt: "2026-08-12T12:00:00.000Z",
  lastPlayAt: "2026-08-12T11:00:00.000Z",
  loginCount: 5,
  plays: 6,
  playMinutes: 210,
  idleMinutes: 15,
  activeDays: 3,
  hourly: hourlyA,
  daily: [{ date: "2026-08-12", playMinutes: 210, idleMinutes: 15, logins: 5, plays: 6 }],
  topItems: [
    { title: "诛仙", episodeTitle: "镇魔古洞", plays: 4, minutes: 180, lastAt: "2026-08-12T11:00:00.000Z" },
    { title: "斗破苍穹", episodeTitle: null, plays: 2, minutes: 30, lastAt: "2026-08-11T21:00:00.000Z" },
  ],
};

const memberUsageB = {
  key: "email:quiet@example.com",
  email: "quiet@example.com",
  embyUserId: "emby-2",
  userName: "quiet@example.com",
  lastLoginAt: "2026-08-10T12:00:00.000Z",
  lastPlayAt: "2026-08-10T12:30:00.000Z",
  loginCount: 1,
  plays: 1,
  playMinutes: 45,
  idleMinutes: 0,
  activeDays: 1,
  hourly: hourlyB,
  daily: [{ date: "2026-08-10", playMinutes: 45, idleMinutes: 0, logins: 1, plays: 1 }],
  topItems: [{ title: "凡人修仙传", episodeTitle: null, plays: 1, minutes: 45, lastAt: "2026-08-10T12:30:00.000Z" }],
};

/**
 * 没绑定会员的 Emby 账号（线上实例：Emby 管理员 2512920656）。
 * 使用记录里要显示**用户名**，不能把 `emby:<guid>` 这种 key 直接摆在界面上
 * —— 早期版本连用户名都没有，于是列表里出现过根本不存在的 `emby:1`。
 */
const memberUsageOrphan = {
  key: "emby:e0c8d46c979c436195b7581070fe2c32",
  email: null,
  embyUserId: "e0c8d46c979c436195b7581070fe2c32",
  userName: "2512920656",
  lastLoginAt: "2026-08-12T20:00:00.000Z",
  lastPlayAt: "2026-08-12T20:30:00.000Z",
  loginCount: 3,
  plays: 1,
  playMinutes: 30,
  idleMinutes: 120,
  activeDays: 1,
  hourly: hourlyA,
  daily: [{ date: "2026-08-12", playMinutes: 30, idleMinutes: 120, logins: 3, plays: 1 }],
  topItems: [{ title: "御兽王者", episodeTitle: null, plays: 1, minutes: 30, lastAt: "2026-08-12T20:30:00.000Z" }],
};

const usageDetail = {
  member: memberUsageA,
  events: [
    {
      id: 3,
      kind: "play_start",
      source: "sampler",
      occurredAt: "2026-08-12T11:00:00.000Z",
      itemTitle: "诛仙",
      episodeTitle: "镇魔古洞",
      seasonNumber: 4,
      episodeNumber: 4,
      deviceName: "OPPO-PLG110",
      client: "Yamby",
      appVersion: "2.0.5.5",
      remoteAddress: "220.197.183.67",
      positionTicks: 0,
      runTimeTicks: 12_670_000_000,
      detail: null,
    },
    {
      id: 2,
      kind: "login",
      source: "sampler",
      occurredAt: "2026-08-12T10:58:00.000Z",
      itemTitle: null,
      episodeTitle: null,
      seasonNumber: null,
      episodeNumber: null,
      deviceName: "OPPO-PLG110",
      client: "Yamby",
      appVersion: "2.0.5.5",
      remoteAddress: "220.197.183.67",
      positionTicks: null,
      runTimeTicks: null,
      detail: "客户端接入",
    },
  ],
  heatmap: [
    { date: "2026-08-12", hours: hourlyA },
    { date: "2026-08-11", hours: hourlyB },
  ],
  recentItems: memberUsageA.topItems,
};

async function installFixtures(page: Page): Promise<void> {
  let authenticated = false;

  // 兜底：任何没显式 stub 的 /api 请求都回空对象（避免 401 把会话打回登录页）。
  await page.route("**/api/**", async (route) => {
    await route.fulfill({ json: {} });
  });

  await page.route("**/api/auth/lock-status", (route) =>
    route.fulfill({ json: { locked: false, retryAfterSeconds: 0 } }),
  );
  await page.route("**/api/auth/login", async (route) => {
    authenticated = true;
    await route.fulfill({ status: 204 });
  });
  await page.route("**/api/tasks", (route) => route.fulfill({ json: { tasks: [], retentionHours: 24 } }));
  await page.route("**/api/integrations/status", (route) =>
    route.fulfill({ json: { emby: { configured: true, ok: true }, email: { configured: false, ok: false } } }),
  );
  await page.route("**/api/library/roots", (route) => route.fulfill({ json: { roots: [] } }));
  await page.route("**/api/dashboard**", (route) =>
    route.fulfill({
      json: {
        summary: {
          tasks: { total: 0, pending: 0, processing: 0, completed: 0, failed: 0 },
          library: { roots: 0, items: 0, matched: 0, unmatched: 0 },
          members: { total: 2, active: 2, expiring: 0, expired: 0, concurrencyActive: 0 },
          submissions: { total: 0, pending: 0, converted: 0, rejected: 0, duplicate: 0 },
          recentTasks: [],
        },
      },
    }),
  );
  await page.route("**/api/submission-users", async (route) => {
    if (!authenticated) return await route.fulfill({ status: 401, json: { error: "unauthorized" } });
    await route.fulfill({ json: { users: [member] } });
  });
  await page.route("**/api/emby/users", async (route) => {
    if (!authenticated) return await route.fulfill({ status: 401, json: { error: "unauthorized" } });
    await route.fulfill({
      json: {
        users: [
          {
            id: "emby-1",
            name: "1501174757@qq.com",
            isAdmin: false,
            isHidden: false,
            isDisabled: false,
            playbackEnabled: true,
            enabledDevices: null,
            maxStreamingBitrate: null,
            lastLoginDate: "2026-08-12T10:58:00.000Z",
            lastActivityDate: "2026-08-12T12:00:00.000Z",
            activeSessions: 1,
          },
        ],
      },
    });
  });
  await page.route("**/api/emby/sessions", async (route) => {
    if (!authenticated) return await route.fulfill({ status: 401, json: { error: "unauthorized" } });
    await route.fulfill({ json: { sessions: [session] } });
  });
  await page.route("**/api/member-usage/overview**", async (route) => {
    if (!authenticated) return await route.fulfill({ status: 401, json: { error: "unauthorized" } });
    await route.fulfill({
      json: {
        range: { days: 7, from: "2026-08-06T00:00:00.000Z", to: "2026-08-12T12:00:00.000Z" },
        generatedAt: "2026-08-12T12:00:00.000Z",
        totals: { activeMembers: 2, knownMembers: 2, logins: 6, plays: 7, playHours: 4.3, devices: 3 },
        hourly: hourlyA.map((minutes, hour) => minutes + hourlyB[hour]),
        members: [memberUsageA, memberUsageB, memberUsageOrphan],
      },
    });
  });
  await page.route("**/api/member-usage/member**", async (route) => {
    await route.fulfill({ json: usageDetail });
  });
}

async function login(page: Page): Promise<void> {
  await page.goto("/login/submissions");
  const password = page.getByLabel("管理员口令");
  const heading = page.getByRole("heading", { name: "会员与运营" });
  // 进页面时先过一次"会话校验"，登录门是稍后才渲染的：等两者之一出现再决定要不要填口令。
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

/**
 * 线上真实一幕：会员 2512920656 用 Emby Web 播《92霸王花与霸王花》（.strm 网盘直链），
 * Emby 只给 PositionTicks（47:58）不给 RunTimeTicks —— 旧实现把"算不出百分比"当 0，
 * 界面画成 0% 宽的进度条，看起来就是"只有播放时间、没有进度条"。
 */
const unknownRuntimeSession = {
  ...session,
  id: "session-strm",
  userId: "emby-2",
  userName: "2512920656",
  deviceName: "Google Chrome Windows",
  client: "Emby Web",
  applicationVersion: "4.10.0.40",
  remoteAddress: "112.96.36.115:51000",
  item: {
    id: "item-strm",
    title: "92霸王花与霸王花",
    episodeTitle: null,
    type: "Movie",
    seasonNumber: null,
    episodeNumber: null,
    displayTitle: "92霸王花与霸王花",
    episodeLabel: null,
  },
  nowPlaying: "92霸王花与霸王花",
  nowPlayingType: "Movie",
  runTimeTicks: null,
  positionTicks: 28_780_397_291,
  positionText: "47:58",
  runTimeText: null,
  progressPercent: null,
  playMethod: "DirectStream",
  playMethodLabel: "直接串流",
  container: "STRM",
  bitrate: null,
  bitrateText: null,
  mediaSourceName: "92霸王花与霸王花 (1992) - 1080p.BluRay REMUX.H.264.DTS-HD 2.0",
  videoLabel: "1080P H.264",
  audioStreams: ["Chinese DTS-HD 2.0"],
  audioLabel: "Chinese DTS-HD 2.0",
};

/** 本应用自己连上 Emby 的会话：没有绑定任何 Emby 用户，也不在播。 */
const idleSystemSession = {
  ...unknownRuntimeSession,
  id: "session-self",
  userId: null,
  userName: null,
  deviceName: "Google Chrome Windows",
  client: "媒体任务中心",
  applicationVersion: null,
  item: null,
  nowPlaying: null,
  nowPlayingType: null,
  positionTicks: null,
  positionText: null,
  isPlaying: false,
  playMethod: null,
  playMethodLabel: "",
  container: null,
  mediaSourceName: null,
  videoLabel: null,
  videoDirect: null,
  audioLabel: null,
  audioDirect: null,
  audioStreams: [],
};

test("总时长未知的会话画不确定态进度条，未播放的会话折叠起来", async ({ page }) => {
  await installFixtures(page);
  await page.route("**/api/emby/sessions", async (route) => {
    await route.fulfill({ json: { sessions: [session, unknownRuntimeSession, idleSystemSession] } });
  });
  await login(page);

  // 只铺"正在播放"的两路：挂着的系统会话被折叠掉了
  await expect(page.locator(".session")).toHaveCount(2);

  // ① 时长已知那路照旧：4:39 / 21:07 + 百分比进度条
  const known = page.locator(".session", { hasText: "诛仙 S4E4" });
  await expect(known.getByText("4:39")).toBeVisible();
  await expect(known.getByText("/ 21:07")).toBeVisible();
  await expect(known.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "22");

  // ② 时长未知那路：只说"已播 47:58 · 总时长未知"，进度条是不确定态（不报百分比）
  const unknown = page.locator(".session", { hasText: "92霸王花与霸王花" });
  await expect(unknown.getByText("已播")).toBeVisible();
  await expect(unknown.getByText("47:58")).toBeVisible();
  await expect(unknown.getByText("· 总时长未知")).toBeVisible();
  await expect(unknown.getByRole("progressbar")).toHaveAttribute("aria-valuetext", "总时长未知，仅显示已播时间");
  expect(await unknown.getByRole("progressbar").getAttribute("aria-valuenow")).toBeNull();
  await expect(unknown.locator(".bar.sweeping")).toBeVisible();
  await page.screenshot({ path: ".local/member-sessions-unknown-progress.png", fullPage: true });

  // ③ 未播放的会话收在按钮后面；展开后能看到"系统 / 应用会话"标注
  const toggle = page.getByRole("button", { name: /另有 1 个已连接会话/ });
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.click();
  await expect(page.locator(".session")).toHaveCount(3);
  const systemCard = page.locator(".session").nth(2);
  await expect(systemCard.getByText("系统 / 应用会话")).toBeVisible();
  await expect(systemCard.getByText("媒体任务中心")).toBeVisible();
  await page.screenshot({ path: ".local/member-sessions-idle-expanded.png", fullPage: true });
});

test("播放会话详情展示到编码/音轨级，并给出使用记录与时段", async ({ page }) => {
  await installFixtures(page);
  await login(page);

  // ① 会员页的在线会话：Emby 客户端那一屏的信息齐全
  const card = page.locator(".session");
  await expect(card).toBeVisible();
  await expect(card.getByText("诛仙 S4E4 · 镇魔古洞")).toBeVisible();
  await expect(card.getByText("4:39")).toBeVisible();
  await expect(card.getByText("/ 21:07")).toBeVisible();
  await expect(card.getByText("OPPO-PLG110")).toBeVisible();
  await expect(card.getByText("Yamby 2.0.5.5")).toBeVisible();
  await expect(card.getByText("220.197.183.67:52344")).toBeVisible();
  await expect(card.getByText("MKV · 6 mbps")).toBeVisible();
  await expect(card.getByText("4K HEVC")).toBeVisible();
  await expect(card.getByText("Chinese EAC3 stereo (默认)")).toBeVisible();
  await expect(page.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "22");
  await page.screenshot({ path: ".local/member-sessions-desktop.png", fullPage: true });

  // ② 切到「使用记录」：时段分布 + 每会员时段条
  await page.getByRole("button", { name: "使用记录" }).click();
  await expect(page.getByRole("heading", { name: "使用记录" })).toBeVisible();
  await expect(page.getByText("活跃会员")).toBeVisible();
  // 全站 24 格时段图
  await expect(page.locator(".hour-chart .hour-col")).toHaveCount(24);
  // 两个会员各一行，每行 24 格时段条（没使用的也列出来）
  await expect(page.locator(".usage-table tbody tr")).toHaveCount(3);
  await expect(page.locator(".usage-table tbody tr").first().locator(".spark i")).toHaveCount(24);
  await expect(page.getByText("1501174757@qq.com")).toBeVisible();
  await expect(page.getByText("quiet@example.com")).toBeVisible();
  // 未绑定会员的 Emby 账号：显示用户名 + 说明，而不是 emby:<guid> 这种 key
  await expect(page.getByText("2512920656")).toBeVisible();
  await expect(page.getByText("未绑定会员（仅 Emby 账号）")).toBeVisible();
  await expect(page.getByText(/emby:e0c8d46c/)).toHaveCount(0);
  await expect(page.getByText("4.3")).toBeVisible();
  await page.screenshot({ path: ".local/member-usage-desktop.png", fullPage: true });

  // ③ 打开某会员详情：事件时间线（登录 + 开始播放）+ 日期×小时热力图
  await page.getByRole("button", { name: "详情" }).first().click();
  await expect(page.getByText("最近事件")).toBeVisible();
  await expect(page.locator(".timeline li")).toHaveCount(2);
  await expect(page.locator(".timeline").getByText("登录", { exact: true })).toBeVisible();
  await expect(page.locator(".timeline").getByText("开始播放", { exact: true })).toBeVisible();
  await expect(page.locator(".timeline").getByText("诛仙 S4E4 · 镇魔古洞")).toBeVisible();
  await expect(page.locator(".heat-row")).toHaveCount(2);
  await expect(page.locator(".heat-row").first().locator(".heat-cells i")).toHaveCount(24);
  await page.screenshot({ path: ".local/member-usage-detail.png", fullPage: true });
});

test("使用记录页在手机上也能读（时段条与表格不溢出）", async ({ page }) => {
  await installFixtures(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);

  await page.getByRole("button", { name: "使用记录" }).click();
  await expect(page.getByRole("heading", { name: "使用记录" })).toBeVisible();
  await expect(page.locator(".hour-chart .hour-col")).toHaveCount(24);
  await expect(page.locator(".usage-table tbody tr")).toHaveCount(3);

  // 横向不溢出（表格可横向滚动，但不该把整页撑开）
  const widths = await page.evaluate(() => ({
    body: document.body.scrollWidth,
    html: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  expect(widths.html).toBeLessThanOrEqual(widths.client + 2);
  expect(widths.body).toBeLessThanOrEqual(widths.client + 2);
  await page.screenshot({ path: ".local/member-usage-mobile.png", fullPage: true });
});
