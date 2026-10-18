import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDatabase, type DatabaseHandle } from "@emby-task-center/database/client";
import { submissionUsers } from "@emby-task-center/database/schema";
import { createApp } from "../app";
import { staticCredentialVerifier } from "../auth/test-session";
import { createLibraryService } from "../library/service";
import type { TmdbClient } from "../tmdb/client";
import type { EmailNotifier } from "../notifications/email-service";
import { createTrendingService } from "./service";
import { loginAsMember } from "../test-support/member-login";

const sharedPassword = "family-password";
const sessionSecret = "session-signing-secret";

function tmdbMovie(id: number, title: string, year: number, rating: number) {
  return {
    id,
    title,
    media_type: "movie",
    poster_path: "/poster.jpg",
    release_date: `${year}-01-01`,
    vote_average: rating,
    overview: "",
  };
}

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });
}

function buildFetch(): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/trending/movie/day")) return jsonResponse({ results: [tmdbMovie(603, "黑客帝国", 1999, 8.0)] });
    if (url.includes("/movie/popular")) return jsonResponse({ results: [tmdbMovie(155, "黑暗骑士", 2008, 9.0)] });
    if (url.includes("/movie/top_rated")) return jsonResponse({ results: [] });
    if (url.includes("douban.com/j/search_subjects")) return jsonResponse({ subjects: [] });
    if (url.includes("movie.douban.com/top250")) return new Response("<html></html>\n", { status: 200 });
    return jsonResponse({ results: [] });
  }) as typeof fetch;
}

describe("trending routes", () => {
  let directory: string;
  let database: DatabaseHandle;
  let server: Server;
  let baseUrl: string;
  let memberCookie: string;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "emby-trending-route-"));
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
    const trendingService = createTrendingService({
      database: database.db,
      tmdbToken: "test-token",
      fetchImpl: buildFetch(),
    });
    await trendingService.refresh();
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
      trending: trendingService,
    });
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    // 隐私保护：热点接口现在需要会员会话；测试登录一个会员并自动附带 cookie。
    const timestamp = new Date().toISOString();
    database.db
      .insert(submissionUsers)
      .values({
        email: "member@example.com",
        enabled: true,
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .run();
    memberCookie = await loginAsMember(baseUrl, database.db, "member@example.com");
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith(`${baseUrl}/api/public/trending`)) {
        return realFetch(input, {
          ...init,
          headers: { ...(init?.headers as Record<string, string> | undefined), cookie: memberCookie },
        });
      }
      return realFetch(input, init);
    });
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("rejects trending content without login (privacy)", async () => {
    vi.unstubAllGlobals();
    const response = await fetch(`${baseUrl}/api/public/trending`);
    expect(response.status).toBe(401);
  });

  it("serves trending sections for logged-in members", async () => {
    const response = await fetch(`${baseUrl}/api/public/trending`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      sections: Array<{ key: string; items: unknown[] }>;
      degradedSources: string[];
    };
    expect(body.sections.map((section) => section.key)).toContain("tmdb_trending");
    expect(body.sections.find((section) => section.key === "tmdb_trending")!.items.length).toBeGreaterThan(0);
  });

  /**
   * 猫眼与奈飞榜单已下线（用户要求从首页删除）。
   *
   * 这条走的是**真实 HTTP 接口**而不是读常量：常量删了、但服务里还留着旧快照，
   * 或者别处又把它们拼回响应，都会被这里抓住——只看 DEFAULT_SECTIONS 看不出来。
   */
  it("会员看到的首页榜单里不再有猫眼与奈飞", async () => {
    const response = await fetch(`${baseUrl}/api/public/trending`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      sections: Array<{ key: string; label: string; source: string }>;
    };

    expect(body.sections.length, "榜单列表不该为空——空列表会让下面的断言变成假阳性").toBeGreaterThan(0);
    const keys = body.sections.map((section) => section.key);
    const sources = body.sections.map((section) => section.source);
    expect(keys).not.toContain("maoyan_realtime");
    expect(keys).not.toContain("maoyan_year");
    expect(keys).not.toContain("netflix_movies");
    expect(keys).not.toContain("netflix_tv");
    expect(sources).not.toContain("maoyan");
    expect(sources).not.toContain("netflix");
    // 标签里也不该再出现这两个平台名
    expect(body.sections.map((section) => section.label).join("|")).not.toMatch(/猫眼|奈飞/);
  });

  it("requires admin session for source config endpoints", async () => {
    const response = await fetch(`${baseUrl}/api/trending/sources`);
    expect(response.status).toBe(401);
  });

  it("lets admin update and re-read source config after login", async () => {
    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: sharedPassword }),
    });
    expect(login.status).toBe(200);
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];

    const put = await fetch(`${baseUrl}/api/trending/sources/tmdb`, {
      method: "PUT",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ enabled: false, ttlMinutes: 120 }),
    });
    expect(put.status).toBe(200);

    const read = await fetch(`${baseUrl}/api/trending/sources`, { headers: { cookie } });
    expect(read.status).toBe(200);
    const body = (await read.json()) as { sources: Array<{ key: string; enabled: boolean; ttlMs: number }> };
    const tmdb = body.sources.find((entry) => entry.key === "tmdb_trending");
    expect(tmdb).toBeTruthy();
    expect(tmdb!.enabled).toBe(false);
    expect(tmdb!.ttlMs).toBe(120 * 60_000);
  });
});
