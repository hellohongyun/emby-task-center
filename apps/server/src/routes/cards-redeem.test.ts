import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { eq } from "drizzle-orm";

import { createDatabase, type DatabaseHandle } from "@emby-task-center/database/client";
import { cardKeys, verificationCodes } from "@emby-task-center/database/schema";
import { createApp } from "../app";
import { staticCredentialVerifier } from "../auth/test-session";
import { createLibraryService } from "../library/service";
import type { TmdbClient } from "../tmdb/client";
import type { EmbyClient } from "../integrations/emby-client";
import type { EmailNotifier } from "../notifications/email-service";

const sharedPassword = "family-password";
const sessionSecret = "session-signing-secret";

describe("卡密兑换的两条关键语义", () => {
  let directory: string;
  let database: DatabaseHandle;
  let server: Server;
  let baseUrl: string;
  let adminCookie: string;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "emby-cards-"));
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
    const app = createApp({
      database: database.db,
      auth: { sessionSecret, verifyCredentials: staticCredentialVerifier(sharedPassword) },
      tmdb,
      library: createLibraryService([]),
      integrationServices: {
        email: { configured: false } as EmailNotifier,
        emby: { configured: false } as EmbyClient,
      },
    });
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: sharedPassword }),
    });
    adminCookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });

  async function createCard(kind: "month" | "year" = "month"): Promise<string> {
    const response = await fetch(`${baseUrl}/api/cards`, {
      method: "POST",
      headers: { cookie: adminCookie, "content-type": "application/json" },
      body: JSON.stringify({ kind, count: 1 }),
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { codes: string[] };
    return body.codes[0]!;
  }

  function seedVerificationCode(email: string, code = "123456") {
    database.db
      .insert(verificationCodes)
      .values({
        email,
        code,
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
        consumed: false,
        createdAt: new Date().toISOString(),
      })
      .run();
  }

  async function activate(email: string, cardCode: string) {
    seedVerificationCode(email);
    const response = await fetch(`${baseUrl}/api/public/subscriptions/activate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, code: "123456", cardCode }),
    });
    return {
      status: response.status,
      body: (await response.json()) as { error?: string; member?: { subscriptionExpiresAt: string | null } },
    };
  }

  it("同一邮箱重复提交同一张卡：不重复加时长（幂等）", async () => {
    const code = await createCard("month");
    const first = await activate("repeat@example.com", code);
    expect(first.status).toBe(200);
    const expiryAfterFirst = first.body.member?.subscriptionExpiresAt;
    expect(expiryAfterFirst).toBeTruthy();

    const second = await activate("repeat@example.com", code);
    expect(second.status).toBe(200);
    expect(second.body.member?.subscriptionExpiresAt).toBe(expiryAfterFirst);
  });

  it("已被使用的卡：另一个邮箱兑换会被拒绝（card_used），归属不变", async () => {
    const code = await createCard("month");
    const owner = await activate("owner@example.com", code);
    expect(owner.status).toBe(200);

    const other = await activate("other@example.com", code);
    expect(other.status).toBe(400);
    expect(other.body.error).toBe("card_used");

    const row = database.db.select().from(cardKeys).where(eq(cardKeys.code, code)).get()!;
    expect(row.usedByEmail).toBe("owner@example.com");
    expect(row.status).toBe("used");
  });

  it("不存在的卡密仍然返回 invalid_card（区分于 card_used）", async () => {
    const result = await activate("nobody@example.com", "NOSUCHCODE12");
    expect(result.status).toBe(400);
    expect(result.body.error).toBe("invalid_card");
  });
});
