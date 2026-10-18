import { fireEvent, render, screen, waitFor } from "@testing-library/vue";
import { describe, expect, it, vi } from "vitest";

import MemberUsageView from "./MemberUsageView.vue";

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const hourly = Array.from({ length: 24 }, (_, hour) => (hour === 20 ? 120 : hour === 21 ? 60 : 0));

const overview = {
  range: { days: 7, from: "2026-01-09T00:00:00.000Z", to: "2026-01-15T12:00:00.000Z" },
  generatedAt: "2026-01-15T12:00:00.000Z",
  totals: { activeMembers: 1, knownMembers: 2, logins: 3, plays: 4, playHours: 3.5, devices: 2 },
  hourly,
  members: [
    {
      key: "email:member@example.com",
      email: "member@example.com",
      embyUserId: "e1",
      userName: "member@example.com",
      lastLoginAt: "2026-01-15T12:00:00.000Z",
      lastPlayAt: "2026-01-15T11:00:00.000Z",
      loginCount: 3,
      plays: 4,
      playMinutes: 180,
      idleMinutes: 0,
      activeDays: 2,
      hourly,
      daily: [],
      topItems: [
        { title: "诛仙", episodeTitle: "镇魔古洞", plays: 2, minutes: 120, lastAt: "2026-01-15T11:00:00.000Z" },
      ],
    },
    {
      key: "email:never@example.com",
      email: "never@example.com",
      embyUserId: "e2",
      userName: "never@example.com",
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
};

const detail = {
  member: overview.members[0],
  events: [
    {
      id: 1,
      kind: "login",
      source: "sampler",
      occurredAt: "2026-01-15T10:00:00.000Z",
      itemTitle: null,
      episodeTitle: null,
      seasonNumber: null,
      episodeNumber: null,
      deviceName: "OPPO-PLG110",
      client: "Yamby",
      appVersion: "2.0.5.5",
      remoteAddress: "192.0.2.10",
      positionTicks: null,
      runTimeTicks: null,
      detail: "客户端接入",
    },
    {
      id: 2,
      kind: "play_start",
      source: "sampler",
      occurredAt: "2026-01-15T10:01:00.000Z",
      itemTitle: "诛仙",
      episodeTitle: "镇魔古洞",
      seasonNumber: 4,
      episodeNumber: 4,
      deviceName: "OPPO-PLG110",
      client: "Yamby",
      appVersion: "2.0.5.5",
      remoteAddress: "192.0.2.10",
      positionTicks: 0,
      runTimeTicks: 12_670_000_000,
      detail: null,
    },
  ],
  heatmap: [{ date: "2026-01-15", hours: hourly }],
  recentItems: overview.members[0]!.topItems,
};

describe("MemberUsageView", () => {
  it("renders usage totals, the hour distribution and per-member rows with time slots", async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn().mockImplementation(async (url: string | URL | Request) => {
      const u = String(url instanceof Request ? url.url : url);
      calls.push(u);
      if (u.includes("/api/member-usage/overview")) return json(200, overview);
      if (u.includes("/api/member-usage/member")) return json(200, detail);
      return json(404, {});
    });
    vi.stubGlobal("fetch", fetchMock);

    const { unmount } = render(MemberUsageView, { props: { requireAuth: vi.fn() } });

    await waitFor(() => expect(screen.getByText("member@example.com")).toBeInTheDocument());
    // 汇总：观看 3.5 小时、登录 3 次
    expect(screen.getByText("3.5")).toBeInTheDocument();
    expect(screen.getByText("活跃会员")).toBeInTheDocument();
    // 没使用的会员也要出现（显示 0，方便判断谁没用）
    expect(screen.getByText("never@example.com")).toBeInTheDocument();
    // 观看时长按人格式化
    expect(screen.getByText("3 小时")).toBeInTheDocument();
    expect(screen.getByText("诛仙")).toBeInTheDocument();

    // 打开详情：时间线里能看到"登录"和本集标题
    const detailButtons = screen.getAllByRole("button", { name: "详情" });
    await fireEvent.click(detailButtons[0]!);
    await waitFor(() => expect(screen.getByText("最近事件")).toBeInTheDocument());
    // 时间线里能看到"接入"与"开播"，以及剧集标题（表头的"登录"不算）
    expect(screen.getByText("客户端接入")).toBeInTheDocument();
    expect(screen.getByText("开始播放")).toBeInTheDocument();
    expect(screen.getByText("诛仙 S4E4 · 镇魔古洞")).toBeInTheDocument();
    expect(calls.some((call) => call.includes("/api/member-usage/member?key="))).toBe(true);

    unmount();
    vi.unstubAllGlobals();
  });

  it("pulls a fresh sample from Emby when the page has no records yet", async () => {
    const empty = {
      ...overview,
      totals: { activeMembers: 0, knownMembers: 1, logins: 0, plays: 0, playHours: 0, devices: 0 },
      hourly: Array.from({ length: 24 }, () => 0),
      members: [
        {
          ...overview.members[1],
          key: "email:member@example.com",
          email: "member@example.com",
        },
      ],
    };
    const posts: string[] = [];
    const fetchMock = vi.fn().mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url instanceof Request ? url.url : url);
      if (init?.method === "POST") {
        posts.push(u);
        return json(200, {
          sampled: { observed: 1, opened: 1, extended: 0, closed: 0, events: 2 },
          activity: { fetched: 0, inserted: 0, unknown: 0, unsupported: false },
        });
      }
      if (u.includes("/api/member-usage/overview")) return json(200, empty);
      return json(404, {});
    });
    vi.stubGlobal("fetch", fetchMock);

    const { unmount } = render(MemberUsageView, { props: { requireAuth: vi.fn() } });
    await waitFor(() => expect(posts.some((call) => call.includes("/api/member-usage/refresh"))).toBe(true));
    unmount();
    vi.unstubAllGlobals();
  });
});
