import { randomUUID } from "node:crypto";
import { expect, test, type APIRequestContext } from "@playwright/test";
import { inactivityAccounts, inactivityEmail, memberInactivityFixture } from "./member-inactivity-fixture";
import { startRegistrationSmtpSink } from "./member-registration-smtp";
import { startIsolatedServer } from "./real-server";

const cleanup = "/api/member-inactivity-cleanup";
const subscriptions = "/api/public/subscriptions";
const { due, recovered, playing, administrator, unavailable, fresh, unlinked } = inactivityAccounts;

type Member = { id: number; email: string; subscriptionExpiresAt: string; embyUserId: string | null };

async function listMembers(api: APIRequestContext) {
  const response = await api.get("/api/submission-users");
  expect(response.status()).toBe(200);
  return (await response.json()).users as Member[];
}

test("saved inactivity rule links the admin browser, scheduled deletion, audit and member access", async ({
  browser,
  playwright,
}) => {
  const emby = memberInactivityFixture();
  const smtp = await startRegistrationSmtpSink();
  try {
    const app = await startIsolatedServer({
      seedDatabase: emby.seedDatabase,
      startUpstream: emby.startUpstream,
      smtpPort: smtp.port,
    });
    try {
      const admin = await browser.newContext({ baseURL: app.baseURL, viewport: { width: 1440, height: 900 } });
      const portal = await playwright.request.newContext({ baseURL: app.baseURL });
      const external: string[] = [];
      await admin.route("**/*", (route) => {
        const url = new URL(route.request().url());
        if (url.origin === app.baseURL || !["http:", "https:"].includes(url.protocol)) return route.continue();
        external.push(url.origin + url.pathname);
        return route.abort();
      });

      try {
        const page = await admin.newPage();
        const api = admin.request;
        await page.goto("/login/submissions");
        await page.getByLabel("管理员账号").fill("admin");
        await page.getByLabel("管理员口令").fill("admin123");
        await page.getByRole("button", { name: "进入任务中心" }).click();
        const open = page.getByRole("button", { name: "保号设置", exact: true });
        const dialog = page.getByRole("dialog", { name: "保号设置" });
        await expect(open).toBeVisible();
        const dueMember = (await listMembers(api)).find(({ email }) => email === inactivityEmail(due))!;
        expect(Date.parse(dueMember.subscriptionExpiresAt)).toBeGreaterThan(Date.now());

        const sent = await portal.post(`${subscriptions}/code`, { data: { email: dueMember.email } });
        expect(sent.status()).toBe(200);
        const code = smtp.codeFor(dueMember.email);
        expect(code).toMatch(/^\d{6}$/);
        const login = await portal.post(`${subscriptions}/login`, { data: { email: dueMember.email, code } });
        expect(login.status()).toBe(200);
        expect((await portal.get(`${subscriptions}/member/profile`)).status()).toBe(200);
        expect((await portal.get(cleanup)).status()).toBe(401);

        await open.click();
        await expect(dialog.getByText("当前已关闭")).toBeVisible();
        const input = dialog.getByRole("spinbutton", { name: "未播放天数" });
        const preview = dialog.getByRole("button", { name: /预览清理范围|重新预览/ });
        const confirm = dialog.getByRole("checkbox");
        const enable = dialog.getByRole("button", { name: "确认启用自动删除" });
        await expect(input).toHaveValue("15");
        await input.fill("16");
        await expect(input).toHaveValue("16");
        await input.fill("15");
        await preview.click();
        for (const id of [due, recovered, playing]) {
          await expect(dialog.getByText(inactivityEmail(id), { exact: true })).toBeVisible();
        }
        await expect(dialog.getByText(inactivityEmail(fresh), { exact: true })).toHaveCount(0);
        await expect(dialog.getByText(inactivityEmail(unlinked), { exact: true })).toHaveCount(0);
        await dialog.getByText(/当前跳过/).click();
        await expect(dialog.getByText("Emby 管理员受保护", { exact: true })).toBeVisible();
        await expect(dialog.getByText("播放记录待核对", { exact: true })).toBeVisible();
        await expect(enable).toBeDisabled();
        expect(emby.deleteRequests).toEqual([]);

        emby.recoverPlayback();
        await confirm.check();
        await enable.click();
        await expect(dialog.getByRole("alert")).toContainText("预览范围或 Emby 连接已变化");
        expect(await (await api.get(cleanup)).json()).toEqual({ days: null });
        await preview.click();
        await expect(dialog.getByText(inactivityEmail(due), { exact: true })).toBeVisible();
        await expect(dialog.getByText(inactivityEmail(recovered), { exact: true })).toHaveCount(0);
        await confirm.check();
        await enable.click();
        await expect(dialog.getByText("当前规则 · 未播放满 15 天")).toBeVisible();
        expect(await (await api.get("/api/member-expiry-cleanup")).json()).toEqual({ days: null });
        expect(emby.deleteRequests).toEqual([]);
        await dialog.getByRole("button", { name: "关闭", exact: true }).click();

        emby.armPlaybackRace();
        await app.restart();
        await expect.poll(() => emby.deleteRequests).toEqual([due]);
        expect(emby.accounts.has(due)).toBe(true);
        expect(await listMembers(api)).toContainEqual(expect.objectContaining({ id: dueMember.id }));
        expect((await portal.get(`${subscriptions}/member/profile`)).status()).toBe(200);
        const renewal = await api.post(`/api/submission-users/${dueMember.id}/renew`, {
          data: { requestId: randomUUID(), mode: "days", days: 30, expectedExpiresAt: dueMember.subscriptionExpiresAt },
        });
        expect(renewal.status()).toBe(409);
        expect(await renewal.json()).toEqual({ error: "renewal_cleanup_pending" });
        emby.releaseDeletion();

        await expect.poll(emby.playbackRaceReads).toBe(2);
        await expect.poll(app.logs).toContain("member_inactivity_cleanup_completed");
        expect(emby.deleteRequests).toEqual([due]);
        expect(emby.accounts.has(due)).toBe(false);
        expect((await listMembers(api)).map(({ email }) => email).sort()).toEqual(
          [administrator, unavailable, fresh, recovered, playing, unlinked].map(inactivityEmail).sort(),
        );
        const removedProfile = await portal.get(`${subscriptions}/member/profile`);
        expect(removedProfile.status()).toBe(403);
        expect(await removedProfile.json()).toEqual({ error: "not_member" });
        expect((await portal.get(`${subscriptions}/member/profile`)).status()).toBe(401);
        const audit = await api.get("/api/audit-logs?action=member.inactivity_cleanup");
        expect(await audit.json()).toMatchObject({
          logs: [
            { action: "member.inactivity_cleanup_deleted", targetId: dueMember.id },
            { action: "member.inactivity_cleanup_policy_changed" },
          ],
        });

        await page.setViewportSize({ width: 390, height: 844 });
        await page.reload();
        await open.click();
        await expect(dialog.getByText("当前规则 · 未播放满 15 天")).toBeVisible();
        expect((await dialog.boundingBox())!.width).toBeLessThanOrEqual(390);
        await dialog.getByRole("button", { name: "关闭自动删除" }).click();
        await expect(dialog.getByText("当前已关闭")).toBeVisible();
        emby.makeRecoveredInactive();
        await app.restart();
        expect(await (await api.get(cleanup)).json()).toEqual({ days: null });
        expect(await listMembers(api)).toContainEqual(expect.objectContaining({ embyUserId: recovered }));
        expect(emby.deleteRequests).toEqual([due]);
        expect(app.blockedRequests()).toEqual([]);
        expect(app.fixture.unexpected).toEqual([]);
        expect(external).toEqual([]);
      } finally {
        emby.releaseDeletion();
        await portal.dispose();
        await admin.close();
      }
    } finally {
      await app.close();
    }
  } finally {
    await smtp.close();
  }
});
