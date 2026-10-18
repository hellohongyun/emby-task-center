import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDatabase, type DatabaseHandle } from "@emby-task-center/database/client";
import { createApp } from "../app";
import { staticCredentialVerifier } from "../auth/test-session";
import { createLibraryService } from "../library/service";
import type { TmdbClient } from "../tmdb/client";
import type { EmailNotifier } from "../notifications/email-service";
import type { TgtoDriveClient, TgtoDriveResourceHit } from "../integrations/tgtodrive-client";
import { createResourceTokenStore } from "../pansou/resource-tokens";
import { savePansouPlatformEnabled } from "../pansou/pansou-settings";
import { loginAsMemberAfterAdminCreate } from "../test-support/member-login";

const sharedPassword = "family-password";
const sessionSecret = "session-signing-secret";

/** 覆盖 4 类 provider，用于验证「管理后台开关」是否真正生效。 */
const hits: TgtoDriveResourceHit[] = [
  {
    title: "肖申克的救赎.1994.BluRay.2160p",
    size: "8.63 GB",
    linkType: "magnet",
    provider: "offline",
    shareUrl: "magnet:?xt=urn:btih:AAA",
    supportedTargets: ["115", "123", "guangya"],
  },
  {
    title: "肖申克的救赎 115 分享",
    size: "",
    linkType: "share",
    provider: "115",
    shareUrl: "https://115.com/s/1",
    supportedTargets: ["115"],
  },
  {
    title: "肖申克的救赎 123 分享",
    size: "",
    linkType: "share",
    provider: "123",
    shareUrl: "https://www.123pan.com/s/2",
    supportedTargets: ["123"],
  },
  {
    title: "肖申克的救赎 光鸭分享",
    size: "",
    linkType: "share",
    provider: "guangya",
    shareUrl: "https://www.guangyapan.com/s/3",
    supportedTargets: ["guangya"],
  },
];

function fakeTgto(): TgtoDriveClient {
  return {
    configured: true,
    searchTmdb: async () => [],
    trigger: async () => ({ ok: true }),
    searchResources: async () => hits,
  };
}

async function startApp(database: DatabaseHandle): Promise<{ server: Server; baseUrl: string }> {
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
  const email: EmailNotifier = {
    configured: true,
    sendTest: async () => undefined,
    retryPending: async () => undefined,
    sendNotification: async () => undefined,
  };
  const app = createApp({
    database: database.db,
    auth: { sessionSecret, verifyCredentials: staticCredentialVerifier(sharedPassword) },
    tmdb,
    library: createLibraryService([]),
    integrationServices: {
      emby: {
        configured: false,
        systemInfo: async () => {
          throw new Error("unused");
        },
        verify: async () => true,
      },
      email,
    },
    pansouTokens: createResourceTokenStore(),
    tgtoDrive: fakeTgto(),
  });
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  return { server, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

describe("public tgto resources API", () => {
  let directory: string;
  let database: DatabaseHandle;
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "emby-tgto-"));
    database = createDatabase(join(directory, "app.sqlite"));
    ({ server, baseUrl } = await startApp(database));
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });

  async function memberCookie(): Promise<string> {
    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: sharedPassword }),
    });
    const adminCookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
    return loginAsMemberAfterAdminCreate(baseUrl, database.db, adminCookie, "member@example.com");
  }

  async function search(cookie?: string): Promise<Response> {
    return fetch(`${baseUrl}/api/public/tgto/resources/search`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
      body: JSON.stringify({ title: "肖申克的救赎", mediaType: "movie", year: 1994 }),
    });
  }

  it("requires a member session", async () => {
    expect((await search()).status).toBe(401);
  });

  it("returns only admin-enabled platforms and never leaks links", async () => {
    const cookie = await memberCookie();
    const response = await search(cookie);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      enabledTypes: string[];
      items: Array<Record<string, unknown>>;
    };

    // 默认开关：115 + 磁力；123 / 光鸭 关闭。
    expect(body.enabledTypes).toEqual(["115", "magnet"]);
    expect(body.items).toHaveLength(2);
    expect(new Set(body.items.map((item) => item.displayType))).toEqual(new Set(["网盘", "磁力"]));

    for (const item of body.items) {
      expect(item.resourceId).toBeTruthy();
      // 链接只留在服务端，前端只能拿 token。
      expect(item).not.toHaveProperty("url");
      expect(item).not.toHaveProperty("shareUrl");
      // 平台键不下发（网盘名脱敏的一部分），只下发展示类型。
      expect(item).not.toHaveProperty("platformKey");
      // 离线目标同样要按开关收敛：未启用的 123 / 光鸭 不得出现。
      const targets = (item.supportedTargets ?? []) as string[];
      expect(targets.every((target) => target === "115")).toBe(true);
    }
  });

  it("honours the admin toggle instead of a hardcoded platform allowlist", async () => {
    // 后台开启 123 后，123 的资源必须出现（此前被硬编码白名单之外的开关无效）。
    savePansouPlatformEnabled(database.db, "123", true);
    const cookie = await memberCookie();
    const response = await search(cookie);
    const body = (await response.json()) as { enabledTypes: string[]; items: Array<Record<string, unknown>> };

    expect(body.enabledTypes).toEqual(expect.arrayContaining(["123"]));
    expect(body.items).toHaveLength(3);
    const targets = body.items.flatMap((item) => (item.supportedTargets ?? []) as string[]);
    expect(targets).toContain("123");
  });
});
