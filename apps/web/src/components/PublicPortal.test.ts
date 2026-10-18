import { fireEvent, render, screen, waitFor } from "@testing-library/vue";
import { beforeEach, describe, expect, it, vi } from "vitest";

import PublicPortal from "./PublicPortal.vue";
import { resetPortalSession } from "../composables/usePortalSession";

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const trendingPayload = {
  sections: [
    {
      key: "tmdb_trending",
      label: "影片趋势",
      source: "tmdb",
      updatedAt: Date.now(),
      stale: false,
      items: [
        {
          id: "tmdb:603",
          title: "黑客帝国",
          mediaType: "movie",
          year: 1999,
          posterUrl: null,
          rating: 8,
          rank: 1,
          source: "tmdb",
          tmdbId: 603,
        },
      ],
    },
  ],
  updatedAt: Date.now(),
  degradedSources: [],
};

const libraryItem = {
  id: "mi:603",
  title: "黑客帝国",
  mediaType: "movie" as const,
  year: 1999,
  posterUrl: null,
  tmdbId: 603,
  watchUrl: "http://emby:8096/web/index.html",
};

function portalFetchMock(loggedIn = false) {
  return vi.fn().mockImplementation(async (url: string | URL | Request, _init?: RequestInit) => {
    const u = String(url instanceof Request ? url.url : url);
    if (u.includes("/public/trending")) return json(200, trendingPayload);
    if (u.includes("/library/list")) return json(200, { items: [libraryItem], total: 1, limit: 24, offset: 0 });
    if (u.includes("/library/recent")) return json(200, { items: [libraryItem] });
    if (u.includes("/library/search")) return json(200, { items: [libraryItem] });
    if (u.includes("/library/status")) return json(200, { inLibrary: loggedIn, items: loggedIn ? [libraryItem] : [] });
    if (u.includes("/tmdb/search") || u.includes("/public/tmdb/details"))
      return json(200, {
        result: {
          tmdbId: 603,
          mediaType: "movie",
          title: "黑客帝国",
          originalTitle: "The Matrix",
          releaseYear: 1999,
          releaseDate: "1999-03-31",
          overview: "矩阵世界。",
          posterUrl: null,
          runtime: 136,
          genres: ["科幻"],
          status: "Released",
          voteAverage: 8.7,
          directors: ["莉莉·沃卓斯基"],
          cast: [],
          castAvatars: [],
          trailerKey: "",
          budget: 0,
          revenue: 0,
          totalEpisodes: null,
          airedEpisodes: null,
          seasons: [],
        },
        results: [
          {
            tmdbId: 603,
            mediaType: "movie",
            title: "黑客帝国",
            releaseYear: 1999,
            posterUrl: null,
            originalTitle: "The Matrix",
          },
        ],
      });
    // 门户会员摘要（原 /api/public/submissions/mine 的位置）
    if (u.includes("/public/subscriptions/member"))
      return loggedIn
        ? json(200, {
            email: "member@example.com",
            member: {
              email: "member@example.com",
              status: "active",
              subscriptionExpiresAt: null,
              embyUsername: "member",
              embyUserId: null,
            },
            quota: { limit: 3, used: 0, remaining: 3 },
          })
        : json(401, { error: "unauthorized" });
    if (u.includes("/public/quota/ledger")) return json(200, { entries: [] });
    if (u.includes("/public/notifications")) return json(200, { notifications: [], unread: 0 });
    if (u.includes("/public/mail-preferences")) return json(200, { mailTypes: [], defaults: {}, userPrefs: {} });
    if (u.includes("/public/articles")) return json(200, { articles: [] });
    if (u.includes("/public/subscriptions/member/emby")) return json(200, { embyUserId: null, embyUsername: null });
    return json(404, {});
  });
}

beforeEach(() => {
  resetPortalSession();
  vi.unstubAllGlobals();
});

describe("PublicPortal", () => {
  it("locks the portal to a login page + admin link when logged out (privacy)", async () => {
    vi.stubGlobal("fetch", portalFetchMock(false));

    render(PublicPortal);

    // 未登录：看不到任何首页/影视库内容，只有登录卡片与管理端口
    expect(await screen.findByText("登录 / 开通会员")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("you@example.com")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /管理端口/ })).toBeInTheDocument();
    expect(screen.queryByText("影迷影视中心")).not.toBeInTheDocument();
    expect(screen.queryByText("最近入库")).not.toBeInTheDocument();
    expect(screen.queryByText("黑客帝国")).not.toBeInTheDocument();
  });

  it("renders the full portal after login", async () => {
    vi.stubGlobal("fetch", portalFetchMock(true));

    render(PublicPortal);

    // 登录后首页默认展示：英雄区 + 热点横流 + 最近入库
    expect(await screen.findByText("影迷影视中心")).toBeInTheDocument();
    expect((await screen.findAllByText("影片趋势")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("黑客帝国").length).toBeGreaterThan(0);
    expect(await screen.findByText("最近入库")).toBeInTheDocument();

    // 投稿页已整体删除：门户导航只剩首页/影视库/我的
    expect(screen.queryByRole("button", { name: /^投稿$/ })).toBeNull();

    // 切到个人中心（登录后展示会员功能）
    await fireEvent.click(screen.getAllByRole("button", { name: /我的/ })[0]!);
    expect(await screen.findByText("续费 / 兑换卡密")).toBeInTheDocument();
  });

  it("searches from home and jumps to library results", async () => {
    vi.stubGlobal("fetch", portalFetchMock(true));

    render(PublicPortal);
    expect(await screen.findByText("影迷影视中心")).toBeInTheDocument();

    const searchInput = screen.getAllByPlaceholderText("搜影视库 / 影片…")[0]!;
    await fireEvent.update(searchInput, "黑客");
    await fireEvent.keyUp(searchInput, { key: "Enter" });

    expect((await screen.findAllByText("影视库")).length).toBeGreaterThan(0);
    expect((await screen.findAllByText("黑客帝国")).length).toBeGreaterThan(0);
  });

  it("shows detail dialog with watch link when already in library", async () => {
    vi.stubGlobal("fetch", portalFetchMock(true));

    render(PublicPortal);
    await screen.findByText("影迷影视中心");

    const card = (await screen.findAllByText("黑客帝国"))
      .map((element) => element.closest("article"))
      .filter((article): article is HTMLElement => article !== null)[0]!;
    await fireEvent.click(card);

    expect(await screen.findByText(/已在库/)).toBeInTheDocument();
    expect(screen.getAllByText("去观看").length).toBeGreaterThanOrEqual(2);
  });

  it("clears the login state when logging out from the portal", async () => {
    vi.stubGlobal("fetch", portalFetchMock(true));

    render(PublicPortal);
    await screen.findByText("影迷影视中心");

    // 退出后回到锁定页：登录卡片 + 管理端口，内容全部隐藏
    await fireEvent.click(screen.getAllByTitle("退出登录")[0]!);
    await waitFor(() => expect(screen.getByText("登录 / 开通会员")).toBeInTheDocument());
    expect(screen.getByRole("link", { name: /管理端口/ })).toBeInTheDocument();
    expect(screen.queryByText("影迷影视中心")).not.toBeInTheDocument();
  });

  it("opens the trending detail dialog without any submission affordance", async () => {
    vi.stubGlobal("fetch", portalFetchMock(true));

    render(PublicPortal);
    await screen.findByText("影迷影视中心");

    const card = (await screen.findAllByText("黑客帝国"))
      .map((element) => element.closest("article"))
      .filter((article): article is HTMLElement => article !== null)[0]!;
    await fireEvent.click(card);

    // 详情弹层仍在（按片名做 aria-label），且不再提供「去投稿」
    expect(await screen.findByRole("dialog", { name: "黑客帝国" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /去投稿/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /我要看/ })).toBeNull();
  });
});
