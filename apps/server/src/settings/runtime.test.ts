import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createServer } from "node:http";

import { createDatabase, type DatabaseHandle } from "@emby-task-center/database/client";
import { createApp } from "../app";
import { staticCredentialVerifier } from "../auth/test-session";
import { createLibraryService } from "../library/service";
import { createEmbyClient } from "../integrations/emby-client";
import { createEmailNotifier } from "../notifications/email-service";
import { getRuntimeSettings, initRuntimeSettings, refreshRuntimeSettings } from "./runtime";
import { writeSettings } from "./store";
import type { TmdbClient } from "../tmdb/client";

const sharedPassword = "family-password";
const sessionSecret = "session-signing-secret";

/** 假 Emby：只回 /emby/System/Info 与 /emby/Users，并按当前密钥判断 401。 */
function fakeEmby(): { server: Server; url: () => string; setKey: (key: string) => void } {
  const state = { key: "key-1" };
  const server = createServer((request, response) => {
    if (request.headers["x-emby-token"] !== state.key) {
      response.writeHead(401).end("unauthorized");
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    const url = request.url ?? "";
    if (url.startsWith("/emby/Users")) {
      response.end(JSON.stringify([{ Id: "u1", Name: "alice" }]));
      return;
    }
    if (url.startsWith("/emby/Sessions")) {
      response.end(JSON.stringify([]));
      return;
    }
    response.end(JSON.stringify({ ServerName: "Fake", Version: "1" }));
  });
  return {
    server,
    url: () => `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    setKey: (key) => {
      state.key = key;
    },
  };
}

/**
 * 保存即生效（不再需要重启）：Emby 地址/密钥走运行时快照。
 */
describe("settings apply at runtime", () => {
  let directory: string;
  let database: DatabaseHandle;
  let emby: ReturnType<typeof fakeEmby>;
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "runtime-settings-"));
    database = createDatabase(join(directory, "app.sqlite"));
    emby = fakeEmby();
    await new Promise<void>((resolve) => emby.server.listen(0, "127.0.0.1", () => resolve()));
    writeSettings(database.db, { "emby.baseUrl": emby.url(), "emby.apiKey": "key-1" });
    initRuntimeSettings(database.db);

    const client = createEmbyClient({
      resolve: () => {
        const live = getRuntimeSettings();
        return { baseUrl: live.embyBaseUrl || undefined, apiKey: live.embyApiKey || undefined };
      },
    });
    const tmdb: TmdbClient = {
      search: async () => [],
      details: async () => {
        throw new Error("unused");
      },
      seasonProgress: async () => ({
        seasonNumber: 1,
        airedEpisodes: 1,
        totalEpisodes: 1,
        lastAirDate: null,
        nextAirDate: null,
      }),
      airedEpisodeCount: async () => 1,
      seasonEpisodes: async () => [],
    };
    // 与 index.ts 同款接线：凭据与连接状态都从运行时快照现取（保存设置后不必重启）。
    const email = createEmailNotifier({ resolve: () => getRuntimeSettings().email });
    const app = createApp({
      database: database.db,
      auth: { sessionSecret, verifyCredentials: staticCredentialVerifier(sharedPassword) },
      tmdb,
      library: createLibraryService([]),
      integrationServices: { emby: client, email },
      integrationStatus: {
        emby: () => getRuntimeSettings().embyEnabled && client.configured,
        email: () => email.configured,
      },
    });
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => emby.server.close(() => resolve()));
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });

  async function login(): Promise<string> {
    const response = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: sharedPassword }),
    });
    return (response.headers.get("set-cookie") ?? "").split(";")[0];
  }

  async function patch(cookie: string, values: Record<string, unknown>) {
    const response = await fetch(`${baseUrl}/api/settings`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ values }),
    });
    return { status: response.status, body: (await response.json()) as { restartRequired?: string[] } };
  }

  it("applies a new Emby api key without a restart", async () => {
    const cookie = await login();
    // 先确认用的是旧密钥
    const first = await fetch(`${baseUrl}/api/emby/users`, { headers: { cookie } });
    expect(first.status, await first.text()).toBe(200);

    // Emby 侧换钥匙：应用还没保存新密钥 → 立刻 502
    emby.setKey("key-2");
    expect((await fetch(`${baseUrl}/api/emby/users`, { headers: { cookie } })).status).toBe(502);

    // 保存新密钥 → 当场生效，不需要重启
    const saved = await patch(cookie, { "emby.apiKey": "key-2" });
    expect(saved.status).toBe(200);
    expect(saved.body.restartRequired ?? []).not.toContain("emby.apiKey");
    expect((await fetch(`${baseUrl}/api/emby/users`, { headers: { cookie } })).status).toBe(200);
  });

  /**
   * 回归：曾经 SMTP 参数只在启动时读一次，后台填好 SMTP 后状态卡片仍显示"未配置"
   * （测试邮件按钮也一直是灰的），只有重启进程才"突然好了"。现在保存即生效。
   */
  it("reports the email card as 已配置 right after saving SMTP settings, without a restart", async () => {
    const cookie = await login();
    const status = async () => {
      const response = await fetch(`${baseUrl}/api/integrations/status`, { headers: { cookie } });
      return (await response.json()) as { emailConfigured: boolean; emailMissing: string[] };
    };

    // 启动时 SMTP 是空的：界面显示"未配置"，并说清还缺哪几项
    const before = await status();
    expect(before.emailConfigured).toBe(false);
    expect(before.emailMissing).toEqual(["SMTP 服务器", "发件人地址"]);

    // 「系统设置 → 配置项」里把 SMTP 填好（端口有默认值 587，这里显式给 465）
    const saved = await patch(cookie, {
      "email.host": "smtp.example.com",
      "email.port": 465,
      "email.secure": true,
      "email.fromAddress": "ops@example.com",
    });
    expect(saved.status).toBe(200);
    expect(saved.body.restartRequired ?? []).not.toContain("email.host");

    // 同一个进程、没有重启：状态卡片当场变"已配置"
    const after = await status();
    expect(after.emailConfigured).toBe(true);
    expect(after.emailMissing).toEqual([]);
  });

  it("still flags the settings that genuinely need a restart", async () => {
    const cookie = await login();
    const saved = await patch(cookie, { "session.secret": "another-secret" });
    expect(saved.status).toBe(200);
    expect(saved.body.restartRequired).toContain("session.secret");
  });

  it("refreshRuntimeSettings reflects what was written", () => {
    writeSettings(database.db, { "emby.baseUrl": "http://example.test:8096" });
    refreshRuntimeSettings(database.db);
    expect(getRuntimeSettings().embyBaseUrl).toBe("http://example.test:8096");
  });
});
