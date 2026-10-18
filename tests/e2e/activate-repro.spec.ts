import { expect, test, type Page } from "@playwright/test";

/**
 * 登录 / 开通 / 续费流程回归（联动测试）。
 *
 * 现在的顺序是：第一步**只有邮箱** → 点「下一步」由服务端判断注册过没有 →
 *   注册过（含已过期）→ 验证码登录（不需要卡密）→ 「我的」页续费时再验证卡密
 *   没注册过       → 注册页：验证卡密 → **解锁**「发送验证码」→ 点一下才发信 → 输入验证码开通
 *
 * 历史：这个用例原先是「点门户『投稿』导航 → 在投稿页里开通」。投稿功能整体删除后，
 * 门户未登录时只显示登录/开通页，开通成功直接进首页，因此断言随之改为首页可见。
 *
 * 2026-09 自定义卡密改造后新增覆盖：
 *  - 卡密预检响应包含**名称 / 到期口径 / 彩蛋文案**，供注册与续费页面统一展示；
 *  - 验证通过后页面显示的是「卡密名称 + 到期时间」，而不是"类型 · N 天"；
 *  - 配了彩蛋文案的卡在**注册页与续费页**都要弹祝福弹窗，没配就不弹。
 * 这一层专门用来钉住"前后端字段对得上"——单测各自绿、联动起来对不上是历史上真出过的问题。
 */

/** `/card/check` 返回的卡信息（与 usePortalSession 的 CardCheckInfo 同形）。 */
interface CardPayload {
  kind: string;
  label: string;
  days: number;
  idempotent: boolean;
  name: string;
  expiresAt: string | null;
  expiryLabel: string | null;
  expiryText: string;
  expiryDetail: string | null;
  expiryDays: number | null;
  blessing: string | null;
}

/** 月卡：相对天数卡，没有固定到期日，也没配彩蛋文案。 */
const monthCard: CardPayload = {
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
};

/** 自定义卡：管理员起了名字、写了 DIY 到期时间名称，并配了彩蛋祝福。 */
const customCard: CardPayload = {
  kind: "custom",
  label: "自定义",
  days: 158,
  idempotent: false,
  name: "国庆节卡密",
  expiresAt: "2027-02-20T15:59:59.999Z",
  expiryLabel: "2027 年春节结束到期",
  expiryText: "2027 年春节结束到期",
  expiryDetail: "2027-02-20",
  expiryDays: 158,
  blessing: "祝你春节快乐，好片看不停！",
};

const expiryLabel = "2027 年春节结束到期";

interface StubOptions {
  registered: boolean;
  /** 卡密预检返回哪张卡（默认月卡）。 */
  card?: CardPayload;
  /** 会员摘要里的「到期时间名称」；给 null 表示这个人没有名称口径。 */
  membershipExpiryLabel?: string | null;
}

/** 门户相关的挡板：注册状态决定走哪条支路；`authenticated` 决定门户摘要是否放行。 */
async function stubPortalApis(page: Page, options: StubOptions) {
  let authenticated = false;
  let cardChecked = false;
  const registered = options.registered;
  const card = options.card ?? monthCard;
  const member = {
    status: "active",
    subscriptionExpiresAt: "2027-02-20T15:59:59.999Z",
    membershipExpiryLabel: options.membershipExpiryLabel ?? null,
    embyUsername: "member@example.com",
    embyUserId: "u1",
    embyMaxStreams: 1,
  };

  await page.route("**/api/public/subscriptions/entry", async (route) => {
    await route.fulfill({ json: { registered, needsCard: !registered, expired: false } });
  });
  await page.route("**/api/public/subscriptions/card/check", async (route) => {
    cardChecked = true;
    await route.fulfill({
      json: { ok: true, registered, needsCard: !registered, expired: false, card },
    });
  });
  await page.route("**/api/public/subscriptions/code", async (route) => {
    await route.fulfill({ json: { sent: true, registered, needsCard: !registered, expired: false } });
  });
  await page.route("**/api/public/subscriptions/activate", async (route) => {
    authenticated = true;
    await route.fulfill({
      status: 200,
      headers: { "content-type": "application/json", "set-cookie": "emby_public_session=mock; Path=/" },
      json: { status: "activated", email: "new@example.com", member, emby: null },
    });
  });
  await page.route("**/api/public/subscriptions/login", async (route) => {
    authenticated = true;
    await route.fulfill({
      status: 200,
      headers: { "content-type": "application/json", "set-cookie": "emby_public_session=mock; Path=/" },
      json: { status: "member", email: "member@example.com", member },
    });
  });
  await page.route("**/api/public/subscriptions/member/emby", async (route) => {
    await route.fulfill({ json: { embyUserId: "u1", embyUsername: "member@example.com" } });
  });
  // 门户会员摘要：登录前 401（未登录），登录后放行
  await page.route("**/api/public/subscriptions/member", async (route) => {
    if (!authenticated) {
      await route.fulfill({ status: 401, json: { error: "unauthorized" } });
      return;
    }
    await route.fulfill({ json: { email: "member@example.com", member } });
  });
  await page.route("**/api/public/follows", async (route) => {
    await route.fulfill({ json: { follows: [] } });
  });
  // 避免种子公告弹窗（平台公告）遮挡导航。
  await page.route("**/api/public/articles", async (route) => {
    await route.fulfill({ json: { articles: [] } });
  });
  await page.route("**/api/public/notifications", async (route) => {
    await route.fulfill({ json: { notifications: [], unread: 0 } });
  });
  await page.route("**/api/public/quota/ledger", async (route) => {
    await route.fulfill({ json: { entries: [] } });
  });

  return { cardChecked: () => cardChecked, authenticated: () => authenticated };
}

/** 走完"第一步 → 下一步"，停在注册页。 */
async function gotoRegisterPage(page: Page, email = "new@example.com") {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "登录 / 开通会员" })).toBeVisible();
  await page.getByPlaceholder("you@example.com").fill(email);
  await page.getByRole("button", { name: "下一步" }).click();
  await expect(page.getByRole("heading", { name: "用卡密开通会员" })).toBeVisible();
}

test("新用户：邮箱 → 下一步 → 卡密 → 验证卡密 → 发送验证码 → 开通", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(String(err)));
  const api = await stubPortalApis(page, { registered: false });

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "登录 / 开通会员" })).toBeVisible();

  // 第一步只有邮箱：卡密与验证码都还没出现
  await expect(page.getByPlaceholder("月卡 / 年卡 / 试用卡")).toHaveCount(0);
  await expect(page.getByPlaceholder("6 位验证码")).toHaveCount(0);
  await page.getByPlaceholder("you@example.com").fill("new@example.com");
  await page.getByRole("button", { name: "下一步" }).click();

  // 没注册过 → 注册页；「发送验证码」此刻是锁着的
  await expect(page.getByRole("heading", { name: "用卡密开通会员" })).toBeVisible();
  const sendButton = page.getByRole("button", { name: /发送验证码|重新发送|\d+s/ });
  await expect(sendButton).toBeDisabled();

  await page.getByPlaceholder("月卡 / 年卡 / 试用卡").fill("CARD123");
  await page.getByRole("button", { name: "验证卡密" }).click();
  // 相对天数卡没有绝对到期日，到期口径就说"兑换后 30 天"，不编日期
  await expect(page.locator("form .notice.ok")).toContainText("卡密有效：月卡 · 兑换后 30 天");
  await expect(page.locator(".card-summary")).toContainText("月卡");
  await expect(page.locator(".card-summary")).toContainText("兑换后 30 天");
  expect(api.cardChecked()).toBe(true);

  // 验证通过只是解锁；点一下才真的发信
  await expect(sendButton).toBeEnabled();
  await sendButton.click();
  await expect(page.getByRole("button", { name: "开通并登录" })).toBeVisible();

  await page.getByPlaceholder("6 位验证码").fill("123456");
  await page.getByRole("button", { name: "开通并登录" }).click();

  // 开通后进入已登录门户（首页可见 + 顶栏显示账号），且不黑屏、无未捕获错误
  await expect(page.getByRole("heading", { name: "影迷影视中心" })).toBeVisible();
  // 顶栏账号：用 .session-chip 限定，首页「欢迎回来，xxx」也含同一段文字，裸 getByText 会撞 strict mode
  await expect(page.locator(".session-chip")).toContainText("member@example.com");
  expect(errors, "uncaught page errors: " + errors.join("\n")).toEqual([]);
});

test("已注册会员：邮箱 → 下一步 → 直接发验证码登录，全程不需要卡密", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(String(err)));
  const api = await stubPortalApis(page, { registered: true });

  await page.goto("/");
  await page.getByPlaceholder("you@example.com").fill("member@example.com");
  await page.getByRole("button", { name: "下一步" }).click();

  await expect(page.getByRole("heading", { name: "验证邮箱" })).toBeVisible();
  await expect(page.getByPlaceholder("月卡 / 年卡 / 试用卡")).toHaveCount(0);

  await page.getByRole("button", { name: "发送验证码" }).click();
  await expect(page.getByText(/验证码已发送至/)).toBeVisible();
  await page.getByPlaceholder("6 位验证码").fill("123456");
  await page.getByRole("button", { name: "登录" }).click();

  expect(api.authenticated()).toBe(true);
  await expect(page.getByRole("heading", { name: "影迷影视中心" })).toBeVisible();
  expect(errors, "uncaught page errors: " + errors.join("\n")).toEqual([]);
});

test("自定义卡密：验证通过显示名称与到期时间，并弹出彩蛋祝福", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(String(err)));
  await stubPortalApis(page, { registered: false, card: customCard });

  await gotoRegisterPage(page);
  await page.getByPlaceholder("月卡 / 年卡 / 试用卡").fill("CARDCUSTOM01");
  await page.getByRole("button", { name: "验证卡密" }).click();

  // ① 提示语与卡密摘要都用「名称 + 到期口径」，不能退回"自定义 · 158 天"
  await expect(page.locator("form .notice.ok")).toContainText("卡密有效：国庆节卡密 · 2027 年春节结束到期");
  const summary = page.locator(".card-summary");
  await expect(summary).toContainText("国庆节卡密");
  await expect(summary).toContainText("2027 年春节结束到期");
  // 真实日期退成小字，用户要核对时看得到
  await expect(summary).toContainText("2027-02-20");

  // ② 彩蛋弹窗：祝福语 + 卡名 + 到期名称 + 真实日期 + 剩余天数
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("祝你春节快乐，好片看不停！");
  await expect(dialog).toContainText("国庆节卡密");
  await expect(dialog).toContainText("2027 年春节结束到期");
  await expect(dialog).toContainText("2027-02-20");
  await expect(dialog).toContainText("还剩 158 天");

  // ③ 关掉弹窗不影响验证结果：发码按钮仍然解锁
  await page.getByRole("button", { name: "开心收下" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /发送验证码|重新发送|\d+s/ })).toBeEnabled();

  expect(errors, "uncaught page errors: " + errors.join("\n")).toEqual([]);
});

test("没配彩蛋文案的卡：验证通过也不弹窗，不留空壳弹层", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(String(err)));
  await stubPortalApis(page, { registered: false, card: monthCard });

  await gotoRegisterPage(page);
  await page.getByPlaceholder("月卡 / 年卡 / 试用卡").fill("CARD123");
  await page.getByRole("button", { name: "验证卡密" }).click();
  await expect(page.locator("form .notice.ok")).toContainText("卡密有效：月卡");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(errors, "uncaught page errors: " + errors.join("\n")).toEqual([]);
});

test("会员侧到期口径：首页与「我的」都显示到期时间名称；续费验证卡密同样弹彩蛋", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(String(err)));
  await stubPortalApis(page, { registered: true, card: customCard, membershipExpiryLabel: expiryLabel });

  // 会员登录
  await page.goto("/");
  await page.getByPlaceholder("you@example.com").fill("member@example.com");
  await page.getByRole("button", { name: "下一步" }).click();
  await page.getByRole("button", { name: "发送验证码" }).click();
  await expect(page.getByText(/验证码已发送至/)).toBeVisible();
  await page.getByPlaceholder("6 位验证码").fill("123456");
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page.getByRole("heading", { name: "影迷影视中心" })).toBeVisible();

  // ① 首页顶栏：到期用名称，不直接甩日期
  const homeMeta = page.locator(".my-meta");
  await expect(homeMeta).toContainText(expiryLabel);
  await expect(homeMeta).toContainText("2027-02-20");

  // ② 「我的」：有效期一行同样是名称口径
  await page.getByRole("button", { name: "我的" }).first().click();
  const heroMeta = page.locator(".hero-meta");
  await expect(heroMeta).toContainText(expiryLabel);
  await expect(heroMeta).toContainText("2027-02-20");

  // ③ 续费：验证卡密后显示名称与到期，并弹出彩蛋
  await page.getByPlaceholder("卡密（月 / 年 / 试用卡）").fill("CARDCUSTOM01");
  await page.getByRole("button", { name: "验证卡密" }).click();
  await expect(page.locator(".card-msg").first()).toContainText("已验证：国庆节卡密 · 到期时间 2027 年春节结束到期");

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("祝你春节快乐，好片看不停！");
  await expect(dialog).toContainText("国庆节卡密");

  expect(errors, "uncaught page errors: " + errors.join("\n")).toEqual([]);
});
