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
import { loginAsMemberAfterAdminCreate } from "../test-support/member-login";
import type { PansouClient, PansouRawResponse } from "../pansou/pansou-client";
import { createResourceTokenStore } from "../pansou/resource-tokens";

const sharedPassword = "family-password";
const sessionSecret = "session-signing-secret";

function fakePansou(raw: PansouRawResponse): PansouClient {
  return { search: async () => raw };
}

describe("public pansou search API", () => {
  let directory: string;
  let database: DatabaseHandle;
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "emby-pansou-"));
    database = createDatabase(join(directory, "app.sqlite"));
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
    const pansou = fakePansou({
      code: 0,
      message: "success",
      data: {
        total: 3,
        merged_by_type: {
          other: [{ url: "https://www.guangyapan.com/s/1", note: "光鸭云盘资源 4K HDR10", source: "plugin:gying" }],
          magnet: [{ url: "magnet:?xt=urn:btih:ABC", note: "磁力资源", source: "plugin:lingjisp" }],
          "123": [{ url: "https://www.123pan.com/s/2", note: "123云盘资源", source: "plugin:gying" }],
        },
      },
    });
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
      pansou,
      pansouTokens: createResourceTokenStore(),
    });
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });

  async function seedAndLogin(): Promise<string> {
    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: sharedPassword }),
    });
    const adminCookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
    return loginAsMemberAfterAdminCreate(baseUrl, database.db, adminCookie, "member@example.com");
  }

  it("requires a member session", async () => {
    const response = await fetch(`${baseUrl}/api/public/pansou/search?kw=test`);
    expect(response.status).toBe(401);
  });

  it("returns masked resources with resourceId and no url/password/netdisk name", async () => {
    const cookie = await seedAndLogin();
    const response = await fetch(`${baseUrl}/api/public/pansou/search?kw=${encodeURIComponent("肖申克的救赎")}`, {
      headers: { cookie },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: Array<Record<string, unknown>> };
    expect(body.items.length).toBeGreaterThan(0);
    for (const item of body.items) {
      expect(item.resourceId).toBeTruthy();
      expect(item).not.toHaveProperty("url");
      expect(item).not.toHaveProperty("password");
      const masked = String(item.maskedNote ?? "");
      expect(masked).not.toContain("光鸭云盘");
      expect(masked).not.toContain("123云盘");
    }
  });
});
