import { expect, test, type APIRequestContext, type BrowserContext, type Page } from "@playwright/test";
import { startMemberRegistrationFixture } from "./member-registration-fixture";

const qq = "123456789";
const newQq = "123456788";
const email = `${qq}@qq.com`;
const invite = "fixture_group_123";
const groupNumber = "765432109";
const profilePath = "/api/public/subscriptions/member/profile";
const membersPath = "/api/submission-users";
const adminPagePath = "/login/submissions";
const subscriptions = "/api/public/subscriptions";

type Fixture = Awaited<ReturnType<typeof startMemberRegistrationFixture>>;
type Profile = { qqNumber: string | null; joinSource: string | null; avatarSyncStatus: string | null };
type Member = { id: number; email: string; embyUserId: string | null; subscriptionExpiresAt: string; profile: Profile };
type Card = { code: string; status: string; usedByEmail: string | null };

let fixture: Fixture;
let admin: BrowserContext;
const browserExternal: string[] = [];
test.use({ serviceWorkers: "block" });

async function guardBrowser(context: BrowserContext) {
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: fixture.baseURL });
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === "https://q1.qlogo.cn" && url.pathname === "/g") {
      const response = await route.fetch({ url: `${fixture.qqBaseURL}${url.pathname}${url.search}` });
      return route.fulfill({ response });
    }
    if (["http:", "https:"].includes(url.protocol) && url.origin !== fixture.baseURL) {
      browserExternal.push(url.origin + url.pathname);
      return route.abort();
    }
    await route.continue();
  });
}

async function loginAdmin() {
  const response = await admin.request.post(`${fixture.baseURL}/api/auth/login`, {
    data: { username: "admin", password: "admin123" },
  });
  await expect(response).toBeOK();
}

async function groupSettings(code: string) {
  const response = await admin.request.patch(`${fixture.baseURL}/api/settings`, {
    data: {
      values: { "member.groupInviteEnabled": true, "member.groupNumber": groupNumber, "member.groupInviteCode": code },
    },
  });
  await expect(response).toBeOK();
  const body = await response.json();
  expect(body.rejected).toEqual([]);
  expect(JSON.stringify(body)).not.toContain(code);
}

async function newCard() {
  const response = await admin.request.post(`${fixture.baseURL}/api/cards`, { data: { kind: "month", count: 1 } });
  expect(response.status()).toBe(201);
  const { codes } = (await response.json()) as { codes: [string] };
  return codes[0];
}

async function cardState(code: string) {
  const response = await admin.request.get(`${fixture.baseURL}/api/cards`);
  await expect(response).toBeOK();
  const { cards } = (await response.json()) as { cards: Card[] };
  return cards.find((card) => card.code === code);
}

async function memberFor(address: string) {
  const response = await admin.request.get(`${fixture.baseURL}${membersPath}`);
  await expect(response).toBeOK();
  const { users } = (await response.json()) as { users: Member[] };
  return users.find((user) => user.email === address);
}

async function otpFor(address: string) {
  await expect.poll(() => fixture.codeFor(address)).toMatch(/^\d{6}$/);
  return fixture.codeFor(address)!;
}

async function publicPost(request: APIRequestContext, path: string, data: Record<string, unknown>) {
  return request.post(`${fixture.baseURL}${subscriptions}/${path}`, { data });
}

async function verifiedRegistration(request: APIRequestContext, cardCode: string, inviteCode: string) {
  await expect(await publicPost(request, "code", { email, cardCode, inviteCode })).toBeOK();
  const response = await publicPost(request, "register/verify", {
    email,
    cardCode,
    inviteCode,
    code: await otpFor(email),
  });
  await expect(response).toBeOK();
  const body = (await response.json()) as { registrationToken: string; qqNumber: string };
  expect(body.qqNumber).toBe(qq);
  return body.registrationToken;
}

async function currentProfile(request: APIRequestContext) {
  const response = await request.get(`${fixture.baseURL}${profilePath}`);
  await expect(response).toBeOK();
  return ((await response.json()) as { profile: Profile }).profile;
}

async function openMyProfile(page: Page) {
  await page.getByRole("button", { name: "我的", exact: true }).click();
  await expect(page.getByRole("heading", { name: "会员资料", exact: true })).toBeVisible();
  return page.getByRole("region", { name: "会员资料", exact: true });
}

async function editAdminProfile(page: Page, search: string) {
  await page.goto(`${fixture.baseURL}${adminPagePath}`);
  await page.getByRole("searchbox", { name: "搜索会员" }).fill(search);
  const row = page.getByRole("row").filter({ hasText: email });
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "会员资料" }).click();
  return page.getByRole("dialog", { name: "会员资料" });
}

test.beforeEach(async ({ browser, context, page }) => {
  fixture = await startMemberRegistrationFixture();
  browserExternal.length = 0;
  admin = await browser.newContext({ serviceWorkers: "block" });
  await guardBrowser(admin);
  await guardBrowser(context);
  await loginAdmin();
  await groupSettings(invite);
  const notice = page.getByRole("dialog", { name: "平台公告" });
  await page.addLocatorHandler(notice, async () => {
    await notice.getByRole("button", { name: "我知道了", exact: true }).click();
  });
});

test.afterEach(async () => {
  try {
    await admin?.close();
    if (fixture) {
      expect(fixture.blockedRequests()).toEqual([]);
      expect(fixture.unexpected).toEqual([]);
      expect(fixture.unexpectedEmbyRequests).toEqual([]);
      expect(browserExternal).toEqual([]);
    }
  } finally {
    await fixture?.close();
  }
});

test("管理员在手机宽度预览网站风格的邮件并通过本地 SMTP 发送同一场景", async () => {
  const page = await admin.newPage();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(fixture.baseURL + "/login/config");
  await expect(page).toHaveTitle("开心果影院");
  await page.getByLabel("邮件类型").selectOption("login");
  await page.getByRole("button", { name: "预览邮件", exact: true }).click();
  const preview = page.frameLocator('iframe[title="邮件 HTML 预览"]');
  await expect(preview.getByRole("heading", { name: "登录验证码" })).toBeVisible();
  await expect(preview.locator("body")).toHaveCSS("background-color", "rgb(3, 11, 17)");
  await expect(preview.getByText("123456", { exact: true })).toHaveCSS("color", "rgb(127, 208, 138)");
  await page.getByText("查看纯文本", { exact: true }).click();
  await expect(page.getByText(/邮箱验证码：123456/)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);

  const address = "mail-preview@example.invalid";
  await page.getByLabel("测试收件邮箱").fill(address);
  await page.getByRole("button", { name: "发送测试", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: address })).toBeVisible();
  expect(fixture.messages.find(({ recipient }) => recipient === address)).toMatchObject({
    text: expect.stringContaining("邮箱验证码：123456"),
    html: expect.stringContaining("开心果影院"),
  });
  expect(fixture.messages).toHaveLength(1);
  await page.close();
});

test("手机注册通过真实邮件验证码和资料确认，随后创建 Emby 用户并上传 QQ 头像", async ({ page }) => {
  const cardCode = await newCard();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(fixture.baseURL);
  await page.getByLabel("会员邮箱").fill("new@example.test");
  await page.getByRole("button", { name: "下一步" }).click();
  await expect(page.getByRole("alert")).toHaveText(/首次开通请使用数字 QQ 邮箱/);
  await page.getByLabel("会员邮箱").fill(email);
  await page.getByRole("button", { name: "下一步" }).click();

  const send = page.getByRole("button", { name: "发送验证码", exact: true });
  await expect(page.getByText(/打开「群公告」查看「会员注册邀请码」/)).toContainText(groupNumber);
  await page.getByRole("button", { name: "复制群号" }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(groupNumber);
  await page.getByLabel("卡密", { exact: true }).fill(cardCode);
  await page.getByRole("button", { name: "验证卡密", exact: true }).click();
  await expect(page.getByRole("button", { name: "卡密已验证" })).toBeVisible();
  await expect(send).toBeDisabled();
  await page.getByLabel("群邀请码").fill("incorrect_invite");
  await send.click();
  await expect(page.getByRole("alert")).toHaveText(/群邀请码无效/);
  expect(fixture.messages).toHaveLength(0);

  await page.getByLabel("群邀请码").fill(invite);
  await send.click();
  await page.getByLabel("验证码", { exact: true }).fill(await otpFor(email));
  await page.getByRole("button", { name: "验证邮箱并继续" }).click();
  await expect(page.getByRole("heading", { name: "确认会员资料" })).toBeVisible();
  await expect(page.getByLabel("联系 QQ")).toHaveValue(qq);
  await expect(page.getByLabel("联系 QQ")).not.toBeEditable();
  const avatar = page.locator(".member-avatar img");
  await expect(avatar).toBeVisible();
  await expect.poll(() => avatar.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
  const overflows = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(overflows).toBe(false);
  expect(await cardState(cardCode)).toMatchObject({ status: "unused", usedByEmail: null });
  expect(await memberFor(email)).toBeUndefined();
  expect(fixture.embyUser(email)).toBeUndefined();
  expect(fixture.avatarUploads).toHaveLength(0);
  expect((await page.request.get(`${fixture.baseURL}${profilePath}`)).status()).toBe(401);

  await page.getByLabel("入会来源（选填）").fill("群公告推荐");
  await page.getByRole("button", { name: "开通并登录" }).click();
  await expect(page.locator(".session-chip")).toContainText(email);
  const profile = await openMyProfile(page);
  await expect(profile.getByLabel("入会来源（选填）")).toHaveValue("群公告推荐");
  await expect.poll(async () => (await currentProfile(page.request)).avatarSyncStatus).toBe("synced");
  expect(await cardState(cardCode)).toMatchObject({ status: "used", usedByEmail: email });
  const embyUser = fixture.embyUser(email)!;
  expect(await memberFor(email)).toMatchObject({
    embyUserId: embyUser.id,
    profile: { qqNumber: qq, joinSource: "群公告推荐" },
  });
  expect(fixture.avatarUploads).toEqual([{ userId: embyUser.id, accepted: true, bytes: fixture.avatarFor(qq) }]);
  expect(fixture.messages.some((message) => message.recipient === email && message.text.includes(email))).toBe(true);
  expect((await page.request.get(`${fixture.baseURL}${membersPath}`)).status()).toBe(401);
});

test("会员编辑、后台搜索和头像保护联动，失败可重试且重启后资料仍在", async ({ page }) => {
  const cardCode = await newCard();
  const registrationToken = await verifiedRegistration(page.request, cardCode, invite);
  await expect(await publicPost(page.request, "activate", { email, cardCode, registrationToken })).toBeOK();
  await expect.poll(async () => (await currentProfile(page.request)).avatarSyncStatus).toBe("synced");
  const user = fixture.embyUser(email)!;
  fixture.setCustomAvatar(user.id);
  const customTag = fixture.embyUser(email)?.tag;

  await page.goto(fixture.baseURL);
  const profile = await openMyProfile(page);
  await profile.getByLabel("联系 QQ").fill(newQq);
  await profile.getByLabel("入会来源（选填）").fill("桌面编辑来源");
  await profile.getByRole("button", { name: "保存资料" }).click();
  await expect(profile.getByText("已保留现有的 Emby 自定义头像。")).toBeVisible();
  expect(fixture.embyUser(email)?.tag).toBe(customTag);
  expect(fixture.avatarUploads).toHaveLength(1);

  const adminPage = await admin.newPage();
  let dialog = await editAdminProfile(adminPage, "桌面编辑来源");
  await expect(dialog.getByLabel("联系 QQ")).toHaveValue(newQq);
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await adminPage.getByRole("searchbox", { name: "搜索会员" }).fill(newQq);
  const row = adminPage.getByRole("row").filter({ hasText: email });
  await row.getByRole("button", { name: "复制 QQ 号" }).click();
  await expect.poll(() => adminPage.evaluate(() => navigator.clipboard.readText())).toBe(newQq);
  await row.getByRole("button", { name: "会员资料" }).click();
  await dialog.getByRole("button", { name: "用 QQ 头像替换" }).click();
  await expect(dialog.getByText("头像已同步到 Emby。")).toBeVisible();
  expect(fixture.avatarUploads.at(-1)).toMatchObject({
    userId: user.id,
    accepted: true,
    bytes: fixture.avatarFor(newQq),
  });
  const updatedTag = fixture.embyUser(email)?.tag;

  fixture.setAvatarUploadFailure(true);
  await profile.getByLabel("联系 QQ").fill(qq);
  await profile.getByRole("button", { name: "保存资料" }).click();
  await expect(profile.getByText("头像同步到 Emby 失败。")).toBeVisible();
  expect(await currentProfile(page.request)).toMatchObject({
    qqNumber: qq,
    joinSource: "桌面编辑来源",
    avatarSyncStatus: "failed",
  });
  expect(fixture.avatarUploads.at(-1)).toMatchObject({ userId: user.id, accepted: false });
  expect(fixture.embyUser(email)?.tag).toBe(updatedTag);

  fixture.setAvatarUploadFailure(false);
  dialog = await editAdminProfile(adminPage, qq);
  await dialog.getByRole("button", { name: "重新同步头像" }).click();
  await expect(dialog.getByText("头像已同步到 Emby。")).toBeVisible();
  expect(fixture.avatarUploads.at(-1)).toMatchObject({ userId: user.id, accepted: true, bytes: fixture.avatarFor(qq) });
  await fixture.restart();
  await expect.poll(async () => (await currentProfile(page.request)).avatarSyncStatus).toBe("synced");
  expect(await memberFor(email)).toMatchObject({
    embyUserId: user.id,
    profile: { qqNumber: qq, joinSource: "桌面编辑来源" },
  });
});

test("启用群邀请码后，已有会员仍可在浏览器用原邮箱登录和续费", async ({ page }) => {
  const cardCode = await newCard();
  const legacyEmail = "legacy@example.test";
  const oldExpiry = new Date(Date.now() - 86_400_000).toISOString();
  const created = await admin.request.post(`${fixture.baseURL}${membersPath}`, {
    data: { email: legacyEmail, subscriptionExpiresAt: oldExpiry },
  });
  expect(created.status()).toBe(201);
  await page.goto(fixture.baseURL);
  await page.getByLabel("会员邮箱").fill(legacyEmail);
  await page.getByRole("button", { name: "下一步" }).click();
  await expect(page.getByRole("heading", { name: "验证邮箱" })).toBeVisible();
  await expect(page.getByLabel("群邀请码")).toHaveCount(0);
  await page.getByRole("button", { name: "发送验证码", exact: true }).click();
  await page.getByLabel("验证码", { exact: true }).fill(await otpFor(legacyEmail));
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.locator(".session-chip")).toContainText(legacyEmail);
  const renewal = page.locator("section.card").filter({ has: page.getByRole("heading", { name: "续费 / 兑换卡密" }) });
  await renewal.getByPlaceholder("卡密（月 / 年 / 试用卡）").fill(cardCode);
  await renewal.getByRole("button", { name: "验证卡密" }).click();
  const before = fixture.messages.length;
  await renewal.getByRole("button", { name: "发送验证码", exact: true }).click();
  await expect.poll(() => fixture.messages.length).toBeGreaterThan(before);
  await renewal.getByPlaceholder("6 位验证码").fill(await otpFor(legacyEmail));
  await renewal.getByRole("button", { name: "确认续费" }).click();
  await expect.poll(async () => (await cardState(cardCode))?.usedByEmail).toBe(legacyEmail);
  expect(Date.parse((await memberFor(legacyEmail))!.subscriptionExpiresAt)).toBeGreaterThan(Date.now());
  expect(await currentProfile(page.request)).toMatchObject({ qqNumber: null, joinSource: null });
});
