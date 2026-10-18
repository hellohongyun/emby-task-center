import { render, screen } from "@testing-library/vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import App from "./App.vue";
import { createAppRouter } from "./router";

/**
 * P4：App 现在通过路由决定渲染哪个外壳（公开门户 / 管理外壳），
 * 测试必须装同一套路由，并等路由解析完初始位置再断言——否则首帧还是公开门户。
 */
async function renderApp(path = "/login") {
  const router = createAppRouter();
  await router.push(path);
  await router.isReady();
  return render(App, { global: { plugins: [router] } });
}

beforeEach(() => {
  // 管理后台位于 /login；视图由 URL 决定（/login 本体 = 默认视图 home）。
  window.history.pushState({}, "", "/login");
});

afterEach(() => vi.unstubAllGlobals());

describe("App service state", () => {
  it("shows a retryable error when the task service responds but fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 503 })));
    // 旧版把视图存在 localStorage：进入 /login 时会把它迁移到 URL（兼容路径保持不变）。
    window.localStorage.setItem("emby-task-center.ui", JSON.stringify({ view: "tasks", filter: "all" }));

    await renderApp();

    expect((await screen.findByText("服务异常")).closest("[role='status']")).toHaveTextContent(
      "任务服务暂时不可用，请稍后重试。",
    );
    expect(screen.getByRole("button", { name: "重新连接" })).toBeInTheDocument();
  });

  it("routes an explicit view URL directly to that view", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 503 })));
    window.localStorage.setItem("emby-task-center.ui", JSON.stringify({ view: "home", filter: "all" }));

    // URL 带视图时以 URL 为准，localStorage 不再覆盖它。
    await renderApp("/login/tasks");

    expect((await screen.findByText("服务异常")).closest("[role='status']")).toHaveTextContent(
      "任务服务暂时不可用，请稍后重试。",
    );
  });
});

describe("App auth gate", () => {
  it("shows a session-checking screen instead of flashing the app shell", async () => {
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));

    await renderApp();

    expect(screen.getByText("正在验证会话…")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "发布任务" })).not.toBeInTheDocument();
  });

  it("shows the login gate instead of the app shell when the session is invalid", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 })),
    );

    await renderApp();

    expect(await screen.findByLabelText("管理员口令")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "发布任务" })).not.toBeInTheDocument();
  });

  it("shows the lock screen with countdown when the server reports a lockout", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }))
        .mockResolvedValueOnce(Response.json({ locked: true, retryAfterSeconds: 60 })),
    );

    await renderApp();

    expect(await screen.findByText("尝试次数过多")).toBeInTheDocument();
    expect(screen.queryByLabelText("管理员口令")).not.toBeInTheDocument();
  });

  it("renders the public portal for non-admin paths", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({}), { status: 200 })));

    await renderApp("/");

    expect(await screen.findByText("会员邮箱")).toBeInTheDocument();
    expect(screen.queryByLabelText("管理员口令")).not.toBeInTheDocument();
  });
});
