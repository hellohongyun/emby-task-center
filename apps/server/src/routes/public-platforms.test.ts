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

const sharedPassword = "family-password";
const sessionSecret = "session-signing-secret";

describe("public platforms dictionary API", () => {
  let directory: string;
  let database: DatabaseHandle;
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "emby-platforms-"));
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

  it("returns enabled platforms in sort order without auth", async () => {
    const response = await fetch(`${baseUrl}/api/public/platforms`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { platforms: Array<{ code: string; name: string }> };
    const names = body.platforms.map((entry) => entry.name);
    expect(names).toContain("腾讯视频");
    expect(names).toContain("芒果TV");
    expect(names).toContain("乐视视频");
    expect(names).toContain("其他");
    expect(names.indexOf("腾讯视频")).toBeLessThan(names.indexOf("芒果TV"));
    expect(body.platforms[0]?.code).toBe("tencent");
  });
});
