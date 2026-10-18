import { render, screen } from "@testing-library/vue";
import { createRouter, createWebHistory, type Router } from "vue-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import MembersPage from "./MembersPage.vue";
import { APP_SERVICES, type AppServices } from "../state/app-services";

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/**
 * 「会员与运营」合并页：会员表 / 使用记录 / 运营设置三段，段切换记在 URL（?tab=）上。
 *
 * 原「用户/会员」与「会员与运营」是两个菜单，两页各有一份会员增删改；合并后会员只在一处维护
 * （额度字段并进了会员表），运营设置与使用记录是另外两段。
 */
function makeRouter(): Router {
  return createRouter({
    history: createWebHistory(),
    routes: [
      { path: "/login/submissions", component: MembersPage },
      { path: "/:pathMatch(.*)*", component: { render: () => null } },
    ],
  });
}

async function renderPage(tab?: string) {
  const router = makeRouter();
  await router.push(tab ? `/login/submissions?tab=${tab}` : "/login/submissions");
  await router.isReady();
  const services = { requireAuth: vi.fn() } as unknown as AppServices;
  return render(MembersPage, {
    global: { plugins: [router], provide: { [APP_SERVICES]: services } },
  });
}

function stubApi() {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation(async (url: string) => {
      const u = String(url);
      if (u.includes("/api/submission-users")) {
        return json(200, {
          users: [
            {
              id: 1,
              email: "member@example.com",
              enabled: true,
              subscriptionExpiresAt: null,
              embyUsername: null,
              processPerDay: 3,
              processFirstBatch: 5,
              status: "active",
              createdAt: "2026-08-01T00:00:00Z",
              updatedAt: "2026-08-01T00:00:00Z",
            },
          ],
        });
      }
      if (u.includes("/api/emby/users")) return json(200, { users: [] });
      if (u.includes("/api/emby/sessions")) return json(200, { sessions: [] });
      if (u.includes("/api/member-usage/overview")) {
        return json(200, {
          range: { days: 7, from: "2026-08-01T00:00:00.000Z", to: "2026-08-08T00:00:00.000Z" },
          generatedAt: "2026-08-08T00:00:00.000Z",
          totals: { activeMembers: 0, knownMembers: 1, logins: 0, plays: 0, playHours: 0, devices: 0 },
          hourly: Array.from({ length: 24 }, () => 0),
          members: [
            {
              key: "email:member@example.com",
              email: "member@example.com",
              embyUserId: null,
              userName: "member@example.com",
              lastLoginAt: null,
              lastPlayAt: null,
              loginCount: 0,
              plays: 0,
              playMinutes: 0,
              idleMinutes: 0,
              activeDays: 0,
              hourly: Array.from({ length: 24 }, () => 0),
              daily: [],
              topItems: [],
            },
          ],
        });
      }
      return json(200, { users: [], tasks: [], articles: [], mailTypes: [], defaults: {}, userPrefs: {} });
    }),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("MembersPage", () => {
  it("keeps only the member section and the usage records section", async () => {
    stubApi();
    await renderPage();

    // 会员段（合并后只剩这一处）
    expect(await screen.findByRole("heading", { name: "会员与运营" })).toBeInTheDocument();
    expect(await screen.findByText("member@example.com")).toBeInTheDocument();
    expect(screen.getByLabelText("每日额度")).toBeInTheDocument();
    // 「运营设置」整段已下线：追更标记删除，邮件偏好与公告/平台说明搬进「系统设置」
    expect(screen.queryByRole("button", { name: "运营设置" })).toBeNull();
    // 投稿审核面板已随投稿功能删除
    expect(screen.queryByText(/投稿请求/)).toBeNull();
    expect(screen.queryByRole("button", { name: /转为任务/ })).toBeNull();
  });

  it("opens the usage records section from the URL (?tab=usage)", async () => {
    stubApi();
    await renderPage("usage");

    expect(await screen.findByRole("heading", { name: "使用记录" })).toBeInTheDocument();
    // 默认（会员）段不再同时渲染，避免两段抢同一块版面
    expect(screen.queryByLabelText("每日额度")).toBeNull();
  });
});
