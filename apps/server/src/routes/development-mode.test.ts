import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import nodemailer from "nodemailer";
import { afterEach, expect, it, vi } from "vitest";
import { createDatabase } from "@emby-task-center/database/client";
import { createApp } from "../app";
import { staticCredentialVerifier } from "../auth/test-session";
import { createLibraryService } from "../library/service";
import { createTmdbClient } from "../tmdb/client";
import { createEmbyClient } from "../integrations/emby-client";
import { createEmailNotifier } from "../notifications/email-service";
import { isDevelopmentMode } from "../settings/development-mode";
import { readSetting, writeSettings } from "../settings/store";

vi.mock("nodemailer", () => ({ default: { createTransport: vi.fn() } }));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

it("admin toggles immediately block delivery without changing SMTP or other policy settings", async () => {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("EMAIL_DELIVERY_DISABLED", "false");
  vi.stubEnv("DEVELOPMENT_MODE", "false");
  const handle = createDatabase(":memory:");
  const sendMail = vi.fn(async () => ({ messageId: "local-test" }));
  vi.mocked(nodemailer.createTransport).mockReturnValue({ sendMail } as never);
  const notifier = createEmailNotifier({
    host: "smtp.example.invalid",
    port: 25,
    fromAddress: "local@example.invalid",
    isDeliveryDisabled: () => isDevelopmentMode(handle.db),
  });
  writeSettings(handle.db, { "email.host": "retained.example.invalid", "tgto.share115Enabled": true });
  const app = createApp({
    database: handle.db,
    auth: { sessionSecret: "debug-mode-local-test", verifyCredentials: staticCredentialVerifier("test-password") },
    library: createLibraryService([]),
    tmdb: createTmdbClient({ token: "" }),
    integrationServices: { email: notifier, emby: createEmbyClient({}) },
  });
  const server: Server = await new Promise((resolve) => {
    const running = app.listen(0, "127.0.0.1", () => resolve(running));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const login = await fetch(base + "/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "test-password" }),
    });
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const patch = (enabled: unknown, authentication = cookie) =>
      fetch(base + "/api/settings", {
        method: "PATCH",
        headers: { cookie: authentication, "content-type": "application/json" },
        body: JSON.stringify({ values: { "development.enabled": enabled } }),
      });
    expect((await patch(true, "")).status).toBe(401);
    expect(isDevelopmentMode(handle.db)).toBe(false);
    const enabled = await patch(true);
    expect(enabled.status).toBe(200);
    expect(await enabled.json()).toMatchObject({
      developmentMode: { enabled: true, emailForcedDisabled: false },
      restartRequired: [],
    });
    const status = await fetch(base + "/api/integrations/status", { headers: { cookie } });
    expect(await status.json()).toMatchObject({ emailConfigured: false, emailDeliveryDisabled: true });
    const send = await fetch(base + "/api/integrations/email/test", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ email: "recipient@example.invalid" }),
    });
    expect(send.status).toBe(503);
    expect(await send.json()).toMatchObject({ error: "email_delivery_disabled" });
    expect(sendMail).not.toHaveBeenCalled();
    expect(nodemailer.createTransport).not.toHaveBeenCalled();
    expect((await patch({ invalid: true })).status).toBe(400);
    expect(isDevelopmentMode(handle.db)).toBe(true);
    expect((await patch(false)).status).toBe(200);
    expect(notifier.configured).toBe(true);
    expect(readSetting(handle.db, "email.host")).toBe("retained.example.invalid");
    expect(readSetting(handle.db, "tgto.share115Enabled")).toBe(true);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    handle.close();
  }
});
