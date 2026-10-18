import { fireEvent, render, screen } from "@testing-library/vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import PublicProfileView from "./PublicProfileView.vue";
import { resetPortalSession, usePortalSession } from "../composables/usePortalSession";

/**
 * 会员门户的并发状态提示。
 *
 * 为什么值得测：被冻结的会员打开门户时，如果只看到「有效」，他唯一的动作就是来找管理员问
 * "为什么播不了"。所以解冻时刻与剩余时长必须自己看得见。
 */

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** 自助解冻状态（默认：没冻结、没有解冻入口）。 */
const noUnfreeze = {
  enabled: false,
  frozen: false,
  reason: "not_frozen",
  disabledUntil: null,
  waitSeconds: 60,
  monthlyLimit: 2,
  usedThisMonth: 0,
  // 本月还剩几次（不扣本次）与"本次解冻后还剩几次"是两个口径：横幅只认前者。
  remainingChances: 2,
  remainingAfterThis: 1,
  requestedAt: null,
  readyAt: null,
  title: "申请提前解冻",
  notice: "你的账号因同时在多台设备播放，已被临时冻结。",
};

function stubMember(
  concurrency: Record<string, unknown>,
  embyMaxStreams: number | null = 1,
  unfreeze: Record<string, unknown> = noUnfreeze,
  status = "active",
) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL | Request) => {
      const target = String(url instanceof Request ? url.url : url);
      if (target.includes("/public/subscriptions/member/emby")) {
        return json(200, { embyUserId: "u1", embyUsername: "member@example.com" });
      }
      if (target.includes("/public/subscriptions/member")) {
        return json(200, {
          email: "member@example.com",
          member: {
            email: "member@example.com",
            status,
            contentAccess: status !== "expired" && !concurrency.disabled,
            subscriptionExpiresAt: null,
            embyUsername: "member@example.com",
            embyUserId: "u1",
            embyMaxStreams,
            concurrency,
            unfreeze,
          },
        });
      }
      return json(404, { error: "not_found" });
    }),
  );
}

describe("PublicProfileView 并发状态", () => {
  beforeEach(() => resetPortalSession());
  afterEach(() => vi.unstubAllGlobals());

  it("过期且冻结时先续费，不展示解冻或修改密码入口", async () => {
    stubMember(
      { disabled: true, disabledUntil: null, remainingMs: 0 },
      1,
      { ...noUnfreeze, frozen: true, enabled: true },
      "expired",
    );
    render(PublicProfileView);
    await screen.findByText("member@example.com");
    expect(screen.getByText(/请先在本页续费/)).toBeInTheDocument();
    expect(screen.getByText(/会员已到期，请使用本页卡密续费/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "申请解冻" })).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText("新 Emby 密码（至少 6 位）")).not.toBeInTheDocument();
    expect(screen.getByText("续费 / 兑换卡密")).toBeInTheDocument();
  });

  it("被冻结时显示解冻时间与剩余时长", async () => {
    const until = new Date(Date.now() + 3 * 3_600_000).toISOString();
    stubMember({
      overshooting: false,
      notified: true,
      disabled: true,
      disabledUntil: until,
      remainingMs: 3 * 3_600_000,
    });

    render(PublicProfileView);
    // 先等会员摘要加载完成（否则拿到的是"未登录"空状态）
    await screen.findByText("member@example.com");
    const banner = document.querySelector(".freeze-note");
    expect(banner).toBeTruthy();

    expect(banner!.textContent).toContain("账号已因多设备同时播放被暂时冻结");
    expect(banner!.textContent).toContain("还剩 3 小时");
    // 解冻时刻按本地时间渲染（月-日 时:分）
    const expected = new Date(until).toLocaleString("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
    expect(banner!.textContent).toContain(expected);
  });

  it("超限中（还没冻结）时提示关掉多余设备，并写明上限路数", async () => {
    stubMember({ overshooting: true, notified: false, disabled: false, disabledUntil: null, remainingMs: null }, 2);

    render(PublicProfileView);
    await screen.findByText("member@example.com");
    const banner = document.querySelector(".overshoot-note");
    expect(banner).toBeTruthy();

    expect(banner!.textContent).toContain("检测到同时在线的播放设备超过上限");
    expect(banner!.textContent).toContain("同一账号同时只允许 2 路");
  });

  it("一切正常时不显示任何并发提示", async () => {
    stubMember({ overshooting: false, notified: false, disabled: false, disabledUntil: null, remainingMs: null });

    render(PublicProfileView);
    await screen.findByText("member@example.com");
    expect(document.querySelector(".freeze-note")).toBeNull();
    expect(document.querySelector(".overshoot-note")).toBeNull();
  });

  it("被冻结且还能自助解冻时显示「申请解冻」按钮与本月剩余次数", async () => {
    const until = new Date(Date.now() + 3 * 3_600_000).toISOString();
    stubMember(
      { overshooting: false, notified: true, disabled: true, disabledUntil: until, remainingMs: 3 * 3_600_000 },
      1,
      {
        ...noUnfreeze,
        enabled: true,
        frozen: true,
        reason: null,
        disabledUntil: until,
        usedThisMonth: 0,
        remainingChances: 2,
        remainingAfterThis: 1,
      },
    );

    render(PublicProfileView);
    await screen.findByText("member@example.com");
    const banner = document.querySelector(".freeze-note");
    expect(banner).toBeTruthy();
    // 会员不用等到期，也不用先来问管理员：按钮就在冻结提示里
    expect(screen.getByText("申请解冻")).toBeTruthy();
    expect(banner!.textContent).toContain("本月还可自助解冻");
    expect(banner!.textContent).toContain("等待 60 秒后可解冻");
    // 一次都还没用过 → 必须显示满额的 2 次，而不是"扣掉本次"的 1 次（曾经的 bug）
    expect(banner!.textContent).toContain("本月还可自助解冻 2 次");
  });

  it("本月次数用完：不显示按钮，并说明只能等到期或找管理员", async () => {
    const until = new Date(Date.now() + 3_600_000).toISOString();
    stubMember(
      { overshooting: false, notified: true, disabled: true, disabledUntil: until, remainingMs: 3_600_000 },
      1,
      {
        ...noUnfreeze,
        frozen: true,
        reason: "limit_reached",
        disabledUntil: until,
        usedThisMonth: 2,
        remainingChances: 0,
        remainingAfterThis: 0,
      },
    );

    render(PublicProfileView);
    await screen.findByText("member@example.com");
    expect(screen.queryByText("申请解冻")).toBeNull();
    expect(document.querySelector(".freeze-note")!.textContent).toContain("本月自助解冻次数已用完");
  });

  it("后台关掉自助解冻：冻结提示不再提解冻按钮", async () => {
    const until = new Date(Date.now() + 3_600_000).toISOString();
    stubMember(
      { overshooting: false, notified: true, disabled: true, disabledUntil: until, remainingMs: 3_600_000 },
      1,
      { ...noUnfreeze, frozen: true, reason: "unfreeze_disabled", disabledUntil: until },
    );

    render(PublicProfileView);
    await screen.findByText("member@example.com");
    expect(screen.queryByText("申请解冻")).toBeNull();
    expect(document.querySelector(".freeze-note")!.textContent).toContain("想提前恢复请联系管理员");
  });

  it("注册成功后「我的」页显示后端下发的开通提示（整块文案来自后台，前端不写死）", async () => {
    // 提示的标题与正文由服务端按后台模板渲染（系统设置 →「会员」），前端只展示。
    // 以前这里写死了「端口 443，HTTPS 默认」这类口径，管理员改不了 —— 这个用例守住"不再写死"。
    const concurrency = {
      overshooting: false,
      notified: false,
      disabled: false,
      disabledUntil: null,
      remainingMs: null,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request) => {
        const target = String(url instanceof Request ? url.url : url);
        if (target.includes("/activate")) {
          return json(200, {
            status: "activated",
            email: "new@example.com",
            member: {
              email: "new@example.com",
              status: "active",
              subscriptionExpiresAt: null,
              embyUsername: "new@example.com",
              embyUserId: "u1",
              embyMaxStreams: 1,
              concurrency,
              unfreeze: noUnfreeze,
            },
            emby: {
              embyUsername: "new@example.com",
              password: "p1",
              serverAddress: "https://emby.example.test",
              onboardTitle: "🎉 开通成功，照着做就行",
              onboardNotice: "服务器地址：https://emby.example.test\n用户名：new@example.com\n密码：p1",
            },
          });
        }
        if (target.includes("/member/emby")) {
          return json(200, { embyUserId: "u1", embyUsername: "new@example.com" });
        }
        if (target.includes("/public/subscriptions/member")) {
          return json(200, {
            email: "new@example.com",
            member: {
              email: "new@example.com",
              status: "active",
              subscriptionExpiresAt: null,
              embyUsername: "new@example.com",
              embyUserId: "u1",
              embyMaxStreams: 1,
              concurrency,
              unfreeze: noUnfreeze,
            },
          });
        }
        return json(404, { error: "not_found" });
      }),
    );

    const session = usePortalSession();
    expect(await session.activate("new@example.com", "123456", "CARD-0001")).toBe(true);

    render(PublicProfileView);
    await screen.findByText("new@example.com");
    const onboard = document.querySelector(".onboard");
    expect(onboard).toBeTruthy();
    expect(onboard!.textContent).toContain("🎉 开通成功，照着做就行");
    expect(onboard!.textContent).toContain("服务器地址：https://emby.example.test");
    expect(onboard!.textContent).toContain("用户名：new@example.com");
  });
});

/**
 * 续费页的卡密验证：名称 / 到期口径 / 彩蛋弹窗。
 *
 * 与注册页（PublicLoginView）是同一套口径，但**代码是两份**——只测注册页挡不住
 * "续费那边又退回显示类型和天数"这种漂移，所以两边各盯一次。
 */
describe("PublicProfileView 续费卡密", () => {
  beforeEach(() => resetPortalSession());
  afterEach(() => vi.unstubAllGlobals());

  const customCard = {
    ok: true,
    registered: true,
    needsCard: false,
    expired: false,
    card: {
      kind: "custom",
      label: "自定义",
      days: 120,
      idempotent: true,
      name: "国庆节卡密",
      expiresAt: "2027-02-20T15:59:59.999Z",
      expiryLabel: "2027 年春节结束到期",
      expiryText: "2027 年春节结束到期",
      expiryDetail: "2027-02-20",
      expiryDays: 158,
      blessing: "祝你春节快乐，好片看不停！",
    },
  };

  function stubRenew(cardResponse: unknown) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request) => {
        const target = String(url instanceof Request ? url.url : url);
        if (target.includes("/public/subscriptions/card/check")) return json(200, cardResponse);
        if (target.includes("/public/subscriptions/member/emby")) {
          return json(200, { embyUserId: "u1", embyUsername: "member@example.com" });
        }
        if (target.includes("/public/subscriptions/member")) {
          return json(200, {
            email: "member@example.com",
            member: {
              email: "member@example.com",
              status: "active",
              subscriptionExpiresAt: "2027-02-20T15:59:59.999Z",
              membershipExpiryLabel: "2027 年春节结束到期",
              embyUsername: "member@example.com",
              embyUserId: "u1",
              embyMaxStreams: 1,
              concurrency: { disabled: false },
              unfreeze: noUnfreeze,
            },
          });
        }
        return json(404, { error: "not_found" });
      }),
    );
  }

  it("会员侧到期口径：有效期显示「到期时间名称」而不是日期，日期退成小字", async () => {
    stubRenew(customCard);
    render(PublicProfileView);
    await screen.findByText("member@example.com");

    const meta = document.querySelector(".hero-meta");
    expect(meta?.textContent).toContain("2027 年春节结束到期");
    // 小字真实日期也在，用户要核对时看得到
    expect(meta?.textContent).toContain("2027-02-20");
  });

  it("续费验证卡密：显示名称与到期时间，并弹出彩蛋祝福", async () => {
    stubRenew(customCard);
    render(PublicProfileView);
    await screen.findByText("member@example.com");

    await fireEvent.update(screen.getByPlaceholderText(/卡密/), "CARDAAAA1111");
    await fireEvent.click(screen.getByRole("button", { name: "验证卡密" }));

    expect(await screen.findByText(/已验证：国庆节卡密 · 到期时间 2027 年春节结束到期/)).toBeTruthy();

    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("祝你春节快乐，好片看不停！");
    expect(dialog.textContent).toContain("国庆节卡密");
    expect(dialog.textContent).toContain("2027-02-20");
  });

  it("没配彩蛋文案的卡：续费验证后不弹窗", async () => {
    stubRenew({
      ...customCard,
      card: { ...customCard.card, blessing: null, name: "月卡", expiryText: "兑换后 30 天", expiryDetail: null },
    });
    render(PublicProfileView);
    await screen.findByText("member@example.com");

    await fireEvent.update(screen.getByPlaceholderText(/卡密/), "CARDBBBB2222");
    await fireEvent.click(screen.getByRole("button", { name: "验证卡密" }));
    await screen.findByText(/已验证：月卡 · 到期时间 兑换后 30 天/);

    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
