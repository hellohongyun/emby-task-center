import { fireEvent, render, screen, waitFor } from "@testing-library/vue";
import { describe, expect, it, vi } from "vitest";
import MembersView from "./MembersView.vue";

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("MembersView", () => {
  it("renders a unified row joining the member with its Emby account and online sessions", async () => {
    const member = {
      id: 1,
      email: "member@example.com",
      enabled: true,
      subscriptionExpiresAt: null,
      embyUsername: "member",
      embyUserId: null,
      embyMaxStreams: null,
      note: null,
      status: "active",
      createdAt: "2026-08-01T00:00:00Z",
      updatedAt: "2026-08-01T00:00:00Z",
    };
    const embyUser = {
      id: "e1",
      name: "member",
      isAdmin: false,
      isHidden: false,
      isDisabled: false,
      playbackEnabled: true,
      enabledDevices: null,
      maxStreamingBitrate: null,
      lastLoginDate: null,
      lastActivityDate: "2026-08-01T00:00:00Z",
      activeSessions: 2,
    };

    const fetchMock = vi.fn().mockImplementation(async (url: string | URL | Request, _init?: RequestInit) => {
      const u = String(url instanceof Request ? url.url : url);
      if (u.includes("/api/submission-users")) return json(200, { users: [member] });
      if (u.includes("/api/emby/users")) return json(200, { users: [embyUser] });
      if (u.includes("/api/emby/sessions")) return json(200, { sessions: [] });
      return json(404, {});
    });
    vi.stubGlobal("fetch", fetchMock);

    const { unmount } = render(MembersView, { props: { requireAuth: vi.fn() } });

    await waitFor(() => expect(screen.getByText("member@example.com")).toBeInTheDocument());
    expect(screen.getByText("member")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
    // 投稿审批队列已随投稿功能整体删除
    expect(screen.queryByText(/投稿请求/)).toBeNull();
    // 移除会员 = 会员行 + 它的 Emby 号（一个动作）：行上只有一个移除入口，不再单列一个「删除」
    expect(screen.getByRole("button", { name: "移除会员" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "删除" })).toBeNull();

    unmount();
    vi.unstubAllGlobals();
  });

  it("binds orphan Emby accounts on demand and explains which ones are skipped", async () => {
    const adminOrphan = {
      id: "e1",
      name: "sample-member",
      isAdmin: true,
      isHidden: false,
      isDisabled: false,
      playbackEnabled: true,
      enabledDevices: null,
      maxStreamingBitrate: null,
      lastLoginDate: null,
      lastActivityDate: null,
      activeSessions: 0,
    };
    const namedOrphan = { ...adminOrphan, id: "e2", name: "viewer@example.com", isAdmin: false };
    const fetchMock = vi.fn().mockImplementation(async (url: string | URL | Request) => {
      const u = String(url instanceof Request ? url.url : url);
      // 注意顺序：/api/submission-users/sync-emby 也包含 /api/submission-users
      if (u.includes("/sync-emby")) {
        return json(200, {
          linked: [{ email: "viewer@example.com", embyUserId: "e2", expiresAt: "2026-09-28T00:00:00.000Z" }],
          adopted: [{ email: "friend@example.com", embyUserId: "e3" }],
          skipped: [{ name: "sample-member", reason: "administrator" }],
        });
      }
      if (u.includes("/api/submission-users")) return json(200, { users: [] });
      if (u.includes("/api/emby/users")) return json(200, { users: [adminOrphan, namedOrphan] });
      if (u.includes("/api/emby/sessions")) return json(200, { sessions: [] });
      return json(404, {});
    });
    vi.stubGlobal("fetch", fetchMock);

    const { unmount } = render(MembersView, { props: { requireAuth: vi.fn() } });

    // 未绑定的账号要说明为什么没绑，而不是只丢一行「仅 Emby 账号」
    await waitFor(() => expect(screen.getByText("Emby 管理员账号，不参与自动绑定")).toBeInTheDocument());
    expect(screen.getByText("等待自动同步（每 10 分钟一轮，也可点上方「同步 Emby 账号」）")).toBeInTheDocument();

    await fireEvent.click(screen.getByRole("button", { name: /同步 Emby 账号/ }));

    await waitFor(() => expect(screen.getByText(/新绑定 1 个/)).toBeInTheDocument());
    const syncCall = fetchMock.mock.calls.find((call) => String(call[0]).includes("/sync-emby"));
    expect(syncCall, "应调用 POST /api/submission-users/sync-emby").toBeTruthy();
    expect((syncCall?.[1] as RequestInit | undefined)?.method).toBe("POST");

    unmount();
    vi.unstubAllGlobals();
  });

  it("keeps a standalone delete for Emby accounts that have no member row", async () => {
    // 会员行已经不在了（或手工建的号）时，孤儿 Emby 账号仍要能单独删掉
    const orphan = {
      id: "e9",
      name: "orphan",
      isAdmin: false,
      isHidden: false,
      isDisabled: false,
      playbackEnabled: true,
      enabledDevices: null,
      maxStreamingBitrate: null,
      lastLoginDate: null,
      lastActivityDate: null,
      activeSessions: 0,
    };
    const fetchMock = vi.fn().mockImplementation(async (url: string | URL | Request) => {
      const u = String(url instanceof Request ? url.url : url);
      if (u.includes("/api/submission-users")) return json(200, { users: [] });
      if (u.includes("/api/emby/users")) return json(200, { users: [orphan] });
      if (u.includes("/api/emby/sessions")) return json(200, { sessions: [] });
      return json(404, {});
    });
    vi.stubGlobal("fetch", fetchMock);

    const { unmount } = render(MembersView, { props: { requireAuth: vi.fn() } });

    await waitFor(() => expect(screen.getByText("orphan")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "移除会员" })).toBeNull();
    expect(screen.getByRole("button", { name: "删除" })).toBeInTheDocument();

    unmount();
    vi.unstubAllGlobals();
  });
});
