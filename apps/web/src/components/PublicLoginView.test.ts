import { fireEvent, render, screen, waitFor } from "@testing-library/vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import PublicLoginView from "./PublicLoginView.vue";
import { resetPortalSession } from "../composables/usePortalSession";

/**
 * 登录 / 开通页的分流。
 *
 * 页面第一步**只有邮箱**：点「下一步」由服务端（`/entry`）判断注册过没有——
 * 注册过（含已过期）→ 验证码登录；没注册过 → 注册页，先验证卡密才**解锁**发送按钮，
 * 而且点一下才真发信。这组用例守的就是这三条，以及"换卡密即作废上次验证"。
 */

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const member = {
  status: "active",
  subscriptionExpiresAt: "2027-01-01T00:00:00.000Z",
  embyUsername: "new@example.com",
  embyUserId: "u1",
  embyMaxStreams: 1,
};

/** 月卡（相对天数卡）：没有固定到期日，到期口径是"兑换后 30 天"，也没配彩蛋文案。 */
const cardOk = {
  ok: true,
  registered: false,
  needsCard: true,
  expired: false,
  card: {
    kind: "month",
    label: "月卡",
    days: 30,
    idempotent: false,
    name: "月卡",
    expiresAt: null,
    expiryLabel: null,
    expiryText: "兑换后 30 天",
    expiryDetail: null,
    expiryDays: null,
    blessing: null,
  },
};

/** 自定义卡密：有管理员起的名字、DIY 的到期时间名称与彩蛋祝福。 */
const customCardOk = {
  ok: true,
  registered: false,
  needsCard: true,
  expired: false,
  card: {
    kind: "custom",
    label: "自定义",
    days: 120,
    idempotent: false,
    name: "国庆节卡密",
    expiresAt: "2027-02-20T15:59:59.999Z",
    expiryLabel: "2027 年春节结束到期",
    expiryText: "2027 年春节结束到期",
    expiryDetail: "2027-02-20",
    expiryDays: 120,
    blessing: "祝你春节快乐，好片看不停！",
  },
};

interface Api {
  entry?: () => Response;
  check?: () => Response;
  code?: () => Response;
  activate?: () => Response;
  login?: () => Response;
}

let calls: Array<{ url: string; body: Record<string, unknown> | null }> = [];

function stubApi(handlers: Api = {}) {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url instanceof Request ? url.url : url);
      const raw = init?.body ? String(init.body) : null;
      calls.push({ url: target, body: raw ? (JSON.parse(raw) as Record<string, unknown>) : null });
      if (target.includes("/subscriptions/entry"))
        return handlers.entry?.() ?? json(200, { registered: false, needsCard: true, expired: false });
      if (target.includes("/subscriptions/card/check"))
        return handlers.check?.() ?? json(400, { error: "invalid_card" });
      if (target.includes("/subscriptions/code"))
        return handlers.code?.() ?? json(200, { sent: true, registered: false, needsCard: true, expired: false });
      if (target.includes("/subscriptions/activate"))
        return (
          handlers.activate?.() ?? json(200, { status: "activated", email: "new@example.com", member, emby: null })
        );
      if (target.includes("/subscriptions/login"))
        return handlers.login?.() ?? json(200, { status: "member", email: "member@example.com", member });
      return json(404, { error: "not_found" });
    }),
  );
}

const callsTo = (fragment: string) => calls.filter((call) => call.url.includes(fragment));
const button = (name: string | RegExp) => screen.getByRole("button", { name }) as HTMLButtonElement;

/** 走完"第一步 → 下一步"，停在分流后的页面。 */
async function gotoAfterEmail(email = "new@example.com") {
  await fireEvent.update(screen.getByPlaceholderText("you@example.com"), email);
  await fireEvent.click(button("下一步"));
}

describe("PublicLoginView 登录/开通分流", () => {
  beforeEach(() => resetPortalSession());
  afterEach(() => vi.unstubAllGlobals());

  it("第一步只有一个邮箱：没有卡密、没有验证码、也没有发码按钮", async () => {
    stubApi();
    render(PublicLoginView);

    expect(screen.getByPlaceholderText("you@example.com")).toBeTruthy();
    expect(screen.queryByPlaceholderText("月卡 / 年卡 / 试用卡")).toBeNull();
    expect(screen.queryByPlaceholderText("6 位验证码")).toBeNull();
    expect(screen.queryByRole("button", { name: /验证卡密/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /发送验证码/ })).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("没注册过 → 进注册页：卡密可填，但「发送验证码」锁着", async () => {
    stubApi();
    render(PublicLoginView);
    await gotoAfterEmail();

    expect(await screen.findByText("用卡密开通会员")).toBeTruthy();
    expect(screen.getByPlaceholderText("月卡 / 年卡 / 试用卡")).toBeTruthy();
    expect(button("验证卡密")).toBeTruthy();
    expect(button(/发送验证码/).disabled).toBe(true);
    // 判断阶段不该有任何发信动作
    expect(callsTo("/subscriptions/code")).toHaveLength(0);
  });

  it("注册页：卡密验证通过才解锁发送，点一下才发信，冷却期内不能重发；提交带卡密开通", async () => {
    stubApi({ check: () => json(200, cardOk) });
    render(PublicLoginView);
    await gotoAfterEmail();
    await screen.findByText("用卡密开通会员");

    await fireEvent.update(screen.getByPlaceholderText("月卡 / 年卡 / 试用卡"), "CARDAAAA1111");
    await fireEvent.click(button("验证卡密"));

    expect(await screen.findByText(/卡密有效：月卡 · 兑换后 30 天/)).toBeTruthy();
    const sendButton = button(/发送验证码|重新发送|\d+s/);
    expect(sendButton.disabled).toBe(false);
    // 验证通过本身不发信——必须再点一次
    expect(callsTo("/subscriptions/code")).toHaveLength(0);

    await fireEvent.click(sendButton);
    // 等发信请求回来：按钮变成 60 秒倒计时且不可点（不能用"卡密有效"那行提示来判断，
    // 它验证通过时就已经在了，会立刻命中）
    const cooling = await waitFor(() => {
      const el = button(/\d+s/);
      expect(el.disabled).toBe(true);
      return el;
    });
    expect(cooling).toBeTruthy();
    expect(callsTo("/subscriptions/code")[0]?.body).toMatchObject({
      email: "new@example.com",
      cardCode: "CARDAAAA1111",
    });

    await fireEvent.update(screen.getByPlaceholderText("6 位验证码"), "123456");
    await fireEvent.click(button("开通并登录"));
    expect(callsTo("/subscriptions/activate")[0]?.body).toMatchObject({
      email: "new@example.com",
      code: "123456",
      cardCode: "CARDAAAA1111",
    });
  });

  it("注册过（含已过期）→ 直接进验证码登录页，不需要卡密", async () => {
    stubApi({
      entry: () => json(200, { registered: true, needsCard: false, expired: true }),
      code: () => json(200, { sent: true, registered: true, needsCard: false, expired: true }),
    });
    render(PublicLoginView);
    await gotoAfterEmail("member@example.com");

    expect(await screen.findByText("验证邮箱")).toBeTruthy();
    expect(screen.queryByPlaceholderText("月卡 / 年卡 / 试用卡")).toBeNull();
    expect(screen.getByText(/会员已到期/)).toBeTruthy();
    // 过期不算"需要卡密"：发信请求里不带卡密
    expect(button(/发送验证码/).disabled).toBe(false);

    await fireEvent.click(button(/发送验证码/));
    await screen.findByText(/已发送至/);
    expect(callsTo("/subscriptions/code")[0]?.body).toEqual({ email: "member@example.com" });

    await fireEvent.update(screen.getByPlaceholderText("6 位验证码"), "123456");
    await fireEvent.click(button("登录"));
    expect(callsTo("/subscriptions/login")[0]?.body).toMatchObject({ email: "member@example.com", code: "123456" });
    expect(callsTo("/subscriptions/activate")).toHaveLength(0);
  });

  it("改了卡密就作废上一次的验证结果：回到「验证卡密」且发送按钮重新锁上", async () => {
    stubApi({ check: () => json(200, cardOk) });
    render(PublicLoginView);
    await gotoAfterEmail();
    await screen.findByText("用卡密开通会员");

    await fireEvent.update(screen.getByPlaceholderText("月卡 / 年卡 / 试用卡"), "CARDAAAA1111");
    await fireEvent.click(button("验证卡密"));
    await screen.findByText(/卡密有效：月卡 · 兑换后 30 天/);
    expect(button(/发送验证码|重新发送|\d+s/).disabled).toBe(false);

    await fireEvent.update(screen.getByPlaceholderText("月卡 / 年卡 / 试用卡"), "CARDAAAA1112");

    expect(button("验证卡密")).toBeTruthy();
    expect(button(/发送验证码/).disabled).toBe(true);
    expect(screen.getByText(/卡密已更换/)).toBeTruthy();
    expect(callsTo("/subscriptions/code")).toHaveLength(0);
  });

  it("卡密无效：报错、发送按钮保持锁定、也不请求发信", async () => {
    stubApi({ check: () => json(400, { error: "invalid_card" }) });
    render(PublicLoginView);
    await gotoAfterEmail();
    await screen.findByText("用卡密开通会员");

    await fireEvent.update(screen.getByPlaceholderText("月卡 / 年卡 / 试用卡"), "WRONGCARD99");
    await fireEvent.click(button("验证卡密"));

    expect(await screen.findByText("卡密无效，请检查是否输错。")).toBeTruthy();
    expect(button(/发送验证码/).disabled).toBe(true);
    expect(callsTo("/subscriptions/code")).toHaveLength(0);
  });

  it("自定义卡密验证通过：显示卡密名称与到期时间，并弹出彩蛋祝福", async () => {
    stubApi({ check: () => json(200, customCardOk) });
    render(PublicLoginView);
    await gotoAfterEmail();
    await screen.findByText("用卡密开通会员");

    await fireEvent.update(screen.getByPlaceholderText("月卡 / 年卡 / 试用卡"), "CARDCUSTOM01");
    await fireEvent.click(button("验证卡密"));

    // 提示语与卡片摘要都用**名称 + 到期口径**，不再回落到"自定义 · 120 天"
    expect(await screen.findByText(/卡密有效：国庆节卡密 · 2027 年春节结束到期/)).toBeTruthy();
    expect(screen.getAllByText("国庆节卡密").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/2027 年春节结束到期/).length).toBeGreaterThan(0);
    // 真实日期退成小字，用户要核对时看得到
    expect(screen.getAllByText(/2027-02-20/).length).toBeGreaterThan(0);

    // 彩蛋弹窗：祝福文案 + 卡名 + 到期时间
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("祝你春节快乐，好片看不停！");
    expect(dialog.textContent).toContain("国庆节卡密");
    expect(dialog.textContent).toContain("2027 年春节结束到期");
    expect(dialog.textContent).toContain("2027-02-20");
    expect(dialog.textContent).toContain("还剩 120 天");

    // 关掉之后不影响发码按钮（验证结果还在）
    await fireEvent.click(screen.getByRole("button", { name: "开心收下" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(button(/发送验证码|重新发送|\d+s/).disabled).toBe(false);
  });

  it("没配彩蛋文案的卡（含所有老卡）：不弹窗，不留一个空壳弹层", async () => {
    stubApi({ check: () => json(200, cardOk) });
    render(PublicLoginView);
    await gotoAfterEmail();
    await screen.findByText("用卡密开通会员");

    await fireEvent.update(screen.getByPlaceholderText("月卡 / 年卡 / 试用卡"), "CARDAAAA1111");
    await fireEvent.click(button("验证卡密"));
    await screen.findByText(/卡密有效：月卡 · 兑换后 30 天/);

    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
