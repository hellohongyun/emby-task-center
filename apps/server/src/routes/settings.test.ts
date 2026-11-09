import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDatabase, type DatabaseHandle } from "@emby-task-center/database/client";
import { createApp } from "../app";
import { ensureDefaultAdminAccount, verifyAdminCredentials } from "../settings/admin-account";
import { readSetting } from "../settings/store";
import { createLibraryService } from "../library/service";
import { createTmdbClient } from "../tmdb/client";

const sharedPassword = "family-password";

interface SettingEntry {
  key: string;
  group: string;
  label: string;
  secret: boolean;
  hasValue: boolean;
  source: string;
  value: unknown;
}
interface SettingsPayload {
  groups: Array<{ group: string; label: string; settings: SettingEntry[] }>;
  admin: { username: string; hasPassword: boolean; mustChangePassword: boolean };
  warnings: string[];
  updated?: string[];
  rejected?: Array<{ key: string; error: string }>;
}

describe("settings API", () => {
  let directory: string;
  let database: DatabaseHandle;
  let server: Server;
  let baseUrl: string;
  let cookie: string;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "emby-settings-api-"));
    database = createDatabase(join(directory, "settings.sqlite"));
    ensureDefaultAdminAccount(database.db, { password: sharedPassword });
    const app = createApp({
      database: database.db,
      auth: {
        sessionSecret: "session-signing-secret",
        verifyCredentials: (username, password) => {
          const result = verifyAdminCredentials(database.db, username, password);
          return result.status === "ok" ? result : null;
        },
      },
      tmdb: createTmdbClient({ token: "tmdb-server-token" }),
      library: createLibraryService([], undefined),
    });
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const login = await loginWith(sharedPassword);
    expect(login.status).toBe(200);
    cookie = login.headers.get("set-cookie")!.split(";", 1)[0];
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });

  async function readSettingsPayload(): Promise<SettingsPayload> {
    const response = await fetch(`${baseUrl}/api/settings`, { headers: { cookie } });
    expect(response.status).toBe(200);
    return (await response.json()) as SettingsPayload;
  }

  function loginWith(password: string) {
    return fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "admin", password }),
    });
  }

  it("requires an admin session", async () => {
    const read = await fetch(`${baseUrl}/api/settings`);
    expect(read.status).toBe(401);
    const patch = await fetch(`${baseUrl}/api/settings`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ values: { "email.host": "smtp.example.com" } }),
    });
    expect(patch.status).toBe(401);
  });

  it("returns grouped settings with registry metadata", async () => {
    const payload = await readSettingsPayload();
    const groups = payload.groups.map((section) => section.group);
    expect(groups).toContain("email");
    expect(groups).toContain("library");
    expect(groups).toContain("admin");

    const host = payload.groups.flatMap((section) => section.settings).find((entry) => entry.key === "email.host");
    expect(host).toMatchObject({ group: "email", secret: false, source: "default" });
    expect(typeof host?.label).toBe("string");
    expect(payload.warnings).toEqual([]);
    expect(payload.admin.username).toBe("admin");
  });

  it("never returns secret plaintext", async () => {
    const patch = await fetch(`${baseUrl}/api/settings`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ values: { "tmdb.token": "top-secret-tmdb", "email.password": "top-secret-smtp" } }),
    });
    expect(patch.status).toBe(200);

    const response = await fetch(`${baseUrl}/api/settings`, { headers: { cookie } });
    const raw = await response.text();
    expect(raw).not.toContain("top-secret-tmdb");
    expect(raw).not.toContain("top-secret-smtp");

    const token = (JSON.parse(raw) as SettingsPayload).groups
      .flatMap((section) => section.settings)
      .find((entry) => entry.key === "tmdb.token");
    expect(token).toMatchObject({ secret: true, hasValue: true, value: "****" });
  });

  it("keeps the admin password settings out of the generic form and rejects direct writes", async () => {
    const originalHash = readSetting(database.db, "admin.passwordHash");
    const payload = await readSettingsPayload();
    const keys = payload.groups.flatMap((section) => section.settings.map(({ key }) => key));
    expect(keys).toContain("admin.username");
    expect(keys).not.toContain("admin.passwordHash");
    expect(keys).not.toContain("admin.mustChangePassword");
    expect(payload.admin).toMatchObject({ hasPassword: true, mustChangePassword: true });

    const response = await fetch(`${baseUrl}/api/settings`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ values: { "admin.passwordHash": "plain-input", "admin.mustChangePassword": false } }),
    });
    expect(response.status).toBe(400);
    const result = (await response.json()) as SettingsPayload;
    expect(result.rejected?.map(({ key }) => key).sort()).toEqual(["admin.mustChangePassword", "admin.passwordHash"]);
    expect(readSetting(database.db, "admin.passwordHash")).toBe(originalHash);
    expect(readSetting(database.db, "admin.mustChangePassword")).toBe(true);
    expect((await loginWith(sharedPassword)).status).toBe(200);
  });

  it("writes valid values and reports the new snapshot", async () => {
    const response = await fetch(`${baseUrl}/api/settings`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        values: { "email.host": "smtp.example.com", "library.scanIntervalMinutes": 45, "emby.enabled": false },
      }),
    });
    expect(response.status).toBe(200);
    const payload = (await response.json()) as SettingsPayload;
    expect(payload.updated?.sort()).toEqual(["email.host", "emby.enabled", "library.scanIntervalMinutes"]);
    expect(payload.rejected).toEqual([]);

    const entry = payload.groups
      .flatMap((section) => section.settings)
      .find((item) => item.key === "library.scanIntervalMinutes");
    expect(entry).toMatchObject({ value: 45, source: "db" });
  });

  it("rejects unknown keys and invalid values", async () => {
    const response = await fetch(`${baseUrl}/api/settings`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ values: { "nope.key": true, "library.scanMode": "sideways" } }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string; rejected: Array<{ key: string }> };
    expect(body.error).toBe("invalid_settings");
    expect(body.rejected.map((item) => item.key).sort()).toEqual(["library.scanMode", "nope.key"]);
  });

  it("applies valid settings while reporting rejected keys", async () => {
    const response = await fetch(`${baseUrl}/api/settings`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        values: { "email.host": "smtp.example.com", "email.port": -1, "admin.passwordHash": "plain-input" },
      }),
    });
    expect(response.status).toBe(200);
    const payload = (await response.json()) as SettingsPayload;
    expect(payload.updated).toEqual(["email.host"]);
    expect(payload.rejected?.map((item) => item.key).sort()).toEqual(["admin.passwordHash", "email.port"]);
    expect((await loginWith(sharedPassword)).status).toBe(200);
  });

  it("changes the admin password behind the current one", async () => {
    const wrong = await fetch(`${baseUrl}/api/settings/admin-password`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ currentPassword: "not-the-password", newPassword: "a-long-enough-password" }),
    });
    expect(wrong.status).toBe(403);

    const short = await fetch(`${baseUrl}/api/settings/admin-password`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ currentPassword: sharedPassword, newPassword: "short" }),
    });
    expect(short.status).toBe(400);

    const ok = await fetch(`${baseUrl}/api/settings/admin-password`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ currentPassword: sharedPassword, newPassword: "a-long-enough-password" }),
    });
    expect(ok.status).toBe(200);
    await expect(ok.json()).resolves.toMatchObject({ status: "ok", admin: { mustChangePassword: false } });
    expect((await loginWith("a-long-enough-password")).status).toBe(200);
  });
});
