import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { startIsolatedServer } from "./real-server";

test("development mode toggles and persists without submitting other settings drafts", async ({ browser }) => {
  const application = await startIsolatedServer();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  try {
    const login = await context.request.post(application.baseURL + "/api/auth/login", {
      data: { username: "admin", password: "admin123" },
    });
    expect(login.status()).toBe(200);
    const page = await context.newPage();
    await page.goto(application.baseURL + "/login/config");
    const panel = page.getByRole("region", { name: "开发调试模式", exact: true });
    const toggle = panel.getByRole("switch");
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    const smtp = page.getByRole("textbox", { name: /SMTP 服务器/ });
    await smtp.fill("unsaved-draft.example.invalid");
    const patch = page.waitForRequest(
      (request) => request.method() === "PATCH" && new URL(request.url()).pathname === "/api/settings",
    );
    await toggle.click();
    expect((await patch).postDataJSON()).toEqual({ values: { "development.enabled": true } });
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await expect(smtp).toHaveValue("unsaved-draft.example.invalid");
    await expect(page.getByText("当前环境已禁用邮件发送。", { exact: true })).toBeVisible();
    const state = await context.request.get(application.baseURL + "/api/integrations/status");
    expect(await state.json()).toMatchObject({ emailConfigured: false, emailDeliveryDisabled: true });
    const mail = await context.request.post(application.baseURL + "/api/integrations/email/test", {
      data: { email: "nobody@example.invalid" },
    });
    expect(mail.status()).toBe(503);
    expect(await mail.json()).toMatchObject({ error: "email_delivery_disabled" });
    await application.restart();
    await page.reload();
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await expect(smtp).not.toHaveValue("unsaved-draft.example.invalid");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    for (const width of [320, 390, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await toggle.scrollIntoViewIfNeeded();
      const bounds = await toggle.boundingBox();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: resolve(".local/development-mode-mobile.png"), fullPage: true });
  } finally {
    await context.close();
    await application.close();
  }
});
