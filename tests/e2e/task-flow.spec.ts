import { expect, test, type Page } from "@playwright/test";

import type { CreateTaskInput, Task, TmdbMedia } from "../../apps/web/src/types";

const candidate: TmdbMedia = {
  id: 70523,
  mediaType: "tv",
  title: "暗黑",
  originalTitle: "Dark",
  releaseYear: 2017,
  overview: "一名孩子失踪后，四个家庭开始寻找答案。",
  posterUrl: "/demo-posters/suspense-ensemble.png",
  backdropUrl: null,
};

const initialTasks: Task[] = [
  {
    id: 1,
    tmdbId: 900003,
    mediaType: "movie",
    title: "流浪地球 2",
    taskType: "ingest",
    status: "running",
    statusMessage: "正在转存",
    airProgress: 1,
    storedProgress: 0,
    version: 2,
    createdAt: "2026-08-10T08:00:00.000Z",
    updatedAt: "2026-08-10T11:45:00.000Z",
    posterUrl: "/demo-posters/sci-fi-planet.png",
  },
  {
    id: 2,
    tmdbId: 900006,
    mediaType: "movie",
    title: "沉默的真相",
    taskType: "ingest",
    status: "completed",
    statusMessage: "已入库",
    airProgress: 1,
    storedProgress: 1,
    version: 4,
    createdAt: "2026-08-08T08:00:00.000Z",
    updatedAt: "2026-08-09T08:55:00.000Z",
    posterUrl: "/demo-posters/suspense-ensemble.png",
  },
];

interface RouteFixtureState {
  createPayloads: CreateTaskInput[];
  /** 改绑 TMDB 的请求体（PUT /api/tasks/:id/tmdb）。 */
  rebindPayloads: Array<{ tmdbId: number; mediaType?: "tv" | "movie"; title?: string }>;
  detailPaths: string[];
  searchQueries: string[];
}

async function installRouteFixtures(page: Page, options: { extraTasks?: Task[] } = {}): Promise<RouteFixtureState> {
  let authenticated = false;
  const tasks = [...initialTasks, ...(options.extraTasks ?? [])].map((task) => ({ ...task }));
  const state: RouteFixtureState = {
    createPayloads: [],
    rebindPayloads: [],
    detailPaths: [],
    searchQueries: [],
  };

  await page.route("**/api/auth/login", async (route) => {
    const payload = route.request().postDataJSON() as { password?: string };
    if (payload.password !== "fixture-password") {
      await route.fulfill({ status: 401, json: { error: "invalid_credentials" } });
      return;
    }
    authenticated = true;
    await route.fulfill({ status: 204 });
  });

  await page.route("**/api/auth/lock-status", async (route) => {
    await route.fulfill({ json: { locked: false, retryAfterSeconds: 0 } });
  });

  await page.route("**/api/library/roots", async (route) => {
    if (!authenticated) {
      await route.fulfill({ status: 401, json: { error: "unauthorized" } });
      return;
    }
    await route.fulfill({ json: { roots: [] } });
  });

  await page.route("**/api/notify-queue", async (route) => {
    if (!authenticated) {
      await route.fulfill({ status: 401, json: { error: "unauthorized" } });
      return;
    }
    await route.fulfill({ json: { entries: [], delayHours: 4 } });
  });

  // 登录后默认视图是「数据总览」，它请求 /api/dashboard；不 stub 会 401 并把会话打回登录页。
  await page.route("**/api/dashboard**", async (route) => {
    if (!authenticated) {
      await route.fulfill({ status: 401, json: { error: "unauthorized" } });
      return;
    }
    await route.fulfill({
      json: {
        summary: {
          tasks: { total: 0, pending: 0, processing: 0, completed: 0, failed: 0 },
          library: { roots: 0, items: 0, matched: 0, unmatched: 0 },
          members: { total: 0, active: 0, expiring: 0, expired: 0, concurrencyActive: 0 },
          submissions: { total: 0, pending: 0, converted: 0, rejected: 0, duplicate: 0 },
          recentTasks: [],
        },
      },
    });
  });

  await page.route("**/api/logs", async (route) => {
    await route.fulfill({ status: 204 });
  });

  await page.route("**/api/tasks/publish-scan", async (route) => {
    if (!authenticated) {
      await route.fulfill({ status: 401, json: { error: "unauthorized" } });
      return;
    }
    await route.fulfill({ json: { scanned: true, lastScannedAt: null } });
  });

  await page.route("**/api/tasks", async (route) => {
    if (!authenticated) {
      await route.fulfill({ status: 401, json: { error: "unauthorized" } });
      return;
    }
    if (route.request().method() === "GET") {
      await route.fulfill({ json: { tasks } });
      return;
    }

    const payload = route.request().postDataJSON() as CreateTaskInput;
    state.createPayloads.push(payload);
    const created: Task = {
      id: 3,
      ...payload,
      // 新看板的 createTask 只发 { tmdbId, title, mediaType }，而 Task.taskType 是必填：
      // 夹具补一个默认值。必须放在 spread **之后**——放前面会被 payload 覆盖（TS2783）。
      taskType: "ingest",
      status: "pending",
      statusMessage: "等待更新",
      airProgress: 10,
      storedProgress: 7,
      // 看板的状态胶囊与「缺集中 / 已齐」筛选都按**任务级** missingEpisodes 判定，
      // 所以夹具要把它给全，否则每条任务都会被算成「已齐」，筛选就测不出东西。
      missingEpisodes: [8, 9, 10],
      lastCheckedAt: "2026-08-10T12:00:00.000Z",
      seasons: [
        {
          seasonNumber: 1,
          status: "tracking",
          airProgress: 10,
          storedProgress: 7,
          lastCheckedAt: "2026-08-10T12:00:00.000Z",
          missingEpisodes: [8, 9, 10],
        },
      ],
      libraries: [],
      version: 1,
      createdAt: "2026-08-10T12:00:00.000Z",
      updatedAt: "2026-08-10T12:00:00.000Z",
      posterUrl: candidate.posterUrl,
    };
    tasks.unshift(created);
    await route.fulfill({ status: 201, json: created });
  });

  await page.route("**/api/webhooks", async (route) => {
    await route.fulfill({
      json: {
        webhooks: [
          {
            id: 3,
            name: "OpenClaw",
            kind: "agent",
            url: "https://agent.test/hooks/agent",
            event: "media_task_event",
            message: "自行判断并处理",
            source: null,
            enabled: true,
          },
        ],
      },
    });
  });
  await page.route("**/api/integrations/status", async (route) => {
    await route.fulfill({
      json: {
        litepanCredentialConfigured: true,
        agentCredentialConfigured: true,
        embyConfigured: true,
        emailConfigured: true,
      },
    });
  });
  await page.route("**/api/automation/runs", async (route) => {
    await route.fulfill({ json: { runs: [] } });
  });
  await page.route("**/api/tasks/*/settings", async (route) => {
    const taskId = Number(new URL(route.request().url()).pathname.split("/")[3]);
    await route.fulfill({
      json: {
        automation: {
          taskId,
          agentWebhookId: 3,
          litepanWebhookId: null,
          autoNotifyAgent: true,
          lastAgentNotificationKey: null,
          lastAgentNotifiedAt: null,
        },
      },
    });
  });

  await page.route("**/api/tmdb/*/*", async (route) => {
    const path = new URL(route.request().url()).pathname;
    state.detailPaths.push(path);
    const tmdbId = Number(path.split("/").at(-1));
    await route.fulfill({ json: { result: tmdbId === candidate.id ? candidate : { posterUrl: null } } });
  });

  await page.route("**/api/tmdb/search**", async (route) => {
    const query = new URL(route.request().url()).searchParams.get("q") ?? "";
    state.searchQueries.push(query);
    await route.fulfill({ json: { results: query === "暗黑" ? [candidate] : [] } });
  });

  /* 改绑 TMDB（PUT /api/tasks/:id/tmdb）：记下请求体，并把夹具里那条任务改成新条目，
     这样确认后刷新出来的看板就是"改绑成功之后"的样子。 */
  await page.route("**/api/tasks/*/tmdb", async (route) => {
    if (!authenticated) {
      await route.fulfill({ status: 401, json: { error: "unauthorized" } });
      return;
    }
    const taskId = Number(new URL(route.request().url()).pathname.split("/")[3]);
    const payload = route.request().postDataJSON() as { tmdbId: number; mediaType?: "tv" | "movie"; title?: string };
    state.rebindPayloads.push(payload);
    const target = tasks.find((task) => task.id === taskId);
    if (target) {
      target.tmdbId = payload.tmdbId;
      if (payload.mediaType) target.mediaType = payload.mediaType;
      if (payload.title) target.title = payload.title;
    }
    await route.fulfill({
      json: {
        task: target ?? null,
        seasons: target?.seasons ?? [],
        mediaItemId: 77,
        merged: false,
        metadataSynced: true,
      },
    });
  });

  return state;
}

test("logs in, creates a TMDB task from the board, filters it, and expands its detail", async ({ page }) => {
  const fixtures = await installRouteFixtures(page);
  /** 看板每行的标题按钮（点它展开分季明细）。用 class 限定，避免和「删除任务 xxx」撞严格模式。 */
  const taskRow = (title: string) => page.locator(".row-toggle").filter({ hasText: title });

  await page.goto("/login");
  await page.getByLabel("管理员口令").fill("fixture-password");
  await page.getByRole("button", { name: "进入任务中心" }).click();

  // 默认视图是数据总览；切到任务中心视图后才有「任务看板」标题。
  await page.getByRole("button", { name: "任务中心", exact: true }).click();
  await expect(page.getByRole("heading", { name: "任务看板" })).toBeVisible();
  await expect(taskRow("流浪地球 2")).toBeVisible();

  /* 新建任务：看板改成「抽屉里搜 TMDB → 点结果直接建」，
     不再有旧的「发布任务 → 选择 → 确认该作品 → 创建任务」四步。 */
  await page.getByRole("button", { name: "新建任务" }).click();
  const drawer = page.getByRole("dialog", { name: "新建任务" });
  await expect(drawer).toBeVisible();

  await drawer.getByRole("searchbox").fill("暗黑");
  await drawer.getByRole("button", { name: "搜索", exact: true }).click();
  // 命中项本身就是创建按钮（文案「新建任务 →」），点它就建
  await drawer.getByRole("button", { name: /暗黑/ }).click();

  // 建完抽屉自动关闭并刷新列表
  await expect(drawer).toBeHidden();
  expect(fixtures.searchQueries).toEqual(["暗黑"]);
  // 新看板的 createTask 只发这三个字段（taskType 由服务端决定）
  expect(fixtures.createPayloads).toEqual([{ tmdbId: 70523, title: "暗黑", mediaType: "tv" }]);

  /* 状态筛选：看板只有「缺集中 / 已齐」两维（追更下线后不再有「追更中」）。
     新建的这条带 missingEpisodes，所以它落在「缺集中」。 */
  const tabs = page.getByRole("tablist", { name: "按状态筛选" });
  await tabs.getByRole("tab", { name: /缺集中/ }).click();
  await expect(taskRow("暗黑")).toBeVisible();
  await expect(taskRow("流浪地球 2")).toBeHidden();

  await tabs.getByRole("tab", { name: /已齐/ }).click();
  await expect(taskRow("流浪地球 2")).toBeVisible();
  await expect(taskRow("暗黑")).toBeHidden();

  /* 行内展开分季明细（旧版本这里是弹「暗黑 任务详情」对话框）。 */
  await tabs.getByRole("tab", { name: /缺集中/ }).click();
  const row = taskRow("暗黑");
  await expect(row).toHaveAttribute("aria-expanded", "false");
  await row.click();
  await expect(row).toHaveAttribute("aria-expanded", "true");

  const seasonTable = page.locator(".season-table");
  await expect(seasonTable).toBeVisible();
  await expect(seasonTable).toContainText("第 1 季");
  await expect(seasonTable).toContainText("E08、E09、E10");
  // 任务级合计也标出缺集数
  await expect(page.locator(".tracking-table tbody tr").first()).toContainText("缺 3 集");
});

/**
 * 「今日更新」与「改绑 TMDB」：
 *  - 当天播出、还在入库宽限期内的集不算缺集，状态胶囊是中性色的「今日更新 N 集」；
 *  - 匹配错了就从行内改绑（这里走"手填 TMDB ID"这条路径）。
 */
test("marks today's episode as pending and rebinds a task to another TMDB id", async ({ page }) => {
  const todayTask: Task = {
    id: 9,
    tmdbId: 79481,
    mediaType: "tv",
    title: "斗破苍穹",
    taskType: "ingest",
    status: "pending",
    statusMessage: null,
    airProgress: 25,
    storedProgress: 24,
    // 当天 18 点更新、20 点才入库：早上看板不该报"缺集"，只标「今日更新」
    missingEpisodes: [],
    pendingEpisodes: [25],
    version: 1,
    createdAt: "2026-09-01T08:00:00.000Z",
    updatedAt: "2026-09-19T00:30:00.000Z",
    lastCheckedAt: "2026-09-19T00:30:00.000Z",
    seasons: [
      {
        seasonNumber: 5,
        status: "tracking",
        airProgress: 25,
        airPendingProgress: 1,
        storedProgress: 24,
        lastCheckedAt: "2026-09-19T00:30:00.000Z",
        missingEpisodes: [],
        pendingEpisodes: [25],
      },
    ],
    libraries: [],
  };
  const fixtures = await installRouteFixtures(page, { extraTasks: [todayTask] });
  const taskRow = (title: string) => page.locator(".row-toggle").filter({ hasText: title });

  await page.goto("/login");
  await page.getByLabel("管理员口令").fill("fixture-password");
  await page.getByRole("button", { name: "进入任务中心" }).click();
  await page.getByRole("button", { name: "任务中心", exact: true }).click();
  await expect(page.getByRole("heading", { name: "任务看板" })).toBeVisible();

  // 「今日更新」自成一档：筛选能点，行上胶囊是它而不是"缺集中"
  const tabs = page.getByRole("tablist", { name: "按状态筛选" });
  await tabs.getByRole("tab", { name: /今日更新/ }).click();
  await expect(taskRow("斗破苍穹")).toBeVisible();
  await expect(taskRow("暗黑")).toBeHidden();
  const row = page.locator(".tracking-table tbody tr").first();
  await expect(row).toContainText("今日更新 1 集");
  await expect(row.locator(".pill")).toHaveClass(/info/);

  // 分季明细给出具体集号
  await taskRow("斗破苍穹").click();
  await expect(page.locator(".season-table")).toContainText("今日更新 E25");
  await page.screenshot({ path: ".local/task-board-today-update.png", fullPage: true });

  // 改绑：行内「改绑」→ 抽屉里手填 TMDB ID → 确认
  await page.getByRole("button", { name: "改绑 TMDB 斗破苍穹" }).click();
  const drawer = page.getByRole("dialog", { name: "改绑 TMDB" });
  await expect(drawer).toBeVisible();
  await expect(drawer).toContainText("当前：");
  await expect(drawer).toContainText("79481");

  await drawer.getByLabel(/TMDB ID/).fill("79482");
  await drawer.getByRole("button", { name: "用这个 ID" }).click();
  await expect(drawer).toContainText("将改绑为");
  await drawer.screenshot({ path: ".local/task-rebind-drawer.png" });

  await drawer.getByRole("button", { name: "确认改绑" }).click();
  await expect(drawer).toBeHidden();
  expect(fixtures.rebindPayloads).toEqual([{ tmdbId: 79482, mediaType: "tv" }]);
});
