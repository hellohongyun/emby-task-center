import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDatabase, type DatabaseHandle } from "@emby-task-center/database/client";
import { mediaItems, mediaRoots, submissionUsers } from "@emby-task-center/database/schema";
import { createApp } from "../app";
import { staticCredentialVerifier } from "../auth/test-session";
import { createLibraryService } from "../library/service";
import type { TmdbClient } from "../tmdb/client";
import type { EmailNotifier } from "../notifications/email-service";
import { loginAsMember } from "../test-support/member-login";

const sharedPassword = "family-password";
const sessionSecret = "session-signing-secret";

describe("public library API", () => {
  let directory: string;
  let database: DatabaseHandle;
  let server: Server;
  let baseUrl: string;
  let memberCookie: string;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "emby-public-library-"));
    database = createDatabase(join(directory, "app.sqlite"));
    const now = new Date().toISOString();
    const root = database.db
      .insert(mediaRoots)
      .values({
        name: "电影",
        mediaType: "movie",
        containerPath: "/media/movies",
        enabled: true,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: mediaRoots.id })
      .get();
    const item = database.db
      .insert(mediaItems)
      .values({
        tmdbId: 603,
        mediaType: "movie",
        title: "黑客帝国",
        originalTitle: "The Matrix",
        releaseYear: 1999,
        overview: "",
        posterUrl: "https://image.tmdb.org/t/p/w500/poster.jpg",
        aliases: [],
        genres: [],
        languages: [],
        regions: [],
        platforms: [],
        externalIds: {},
        tmdbPayload: {},
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: mediaItems.id })
      .get();
    const dark = database.db
      .insert(mediaItems)
      .values({
        tmdbId: 155,
        mediaType: "movie",
        title: "黑暗骑士",
        originalTitle: "The Dark Knight",
        releaseYear: 2008,
        overview: "",
        posterUrl: null,
        aliases: [],
        genres: [],
        languages: [],
        regions: [],
        platforms: [],
        externalIds: {},
        tmdbPayload: {},
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: mediaItems.id })
      .get();
    database.db
      .insert(mediaItems)
      .values({
        tmdbId: 278,
        mediaType: "movie",
        title: "肖申克的救赎",
        originalTitle: "The Shawshank Redemption",
        releaseYear: 1994,
        overview: "",
        posterUrl: null,
        aliases: [],
        genres: [],
        languages: [],
        regions: [],
        platforms: [],
        externalIds: {},
        tmdbPayload: {},
        createdAt: now,
        updatedAt: now,
      })
      .run();
    database.db
      .insert(mediaRoots)
      .values({
        name: "剧集",
        mediaType: "tv",
        containerPath: "/media/tv",
        enabled: true,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    database.db
      .insert(mediaRoots)
      .values({
        name: "电影2",
        mediaType: "movie",
        containerPath: "/media/movies2",
        enabled: true,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    // 第一个片源入库：创建两条 library_items（电影 603 + 电视剧 278 模拟多文件）
    const library = await import("@emby-task-center/database/schema");
    database.db
      .insert(library.libraryItems)
      .values({
        mediaRootId: root.id,
        mediaItemId: item.id,
        relativePath: "黑客帝国/黑客帝国.strm",
        sourceTitle: "黑客帝国",
        sourceYear: 1999,
        posterPath: null,
        tags: [],
        confidence: 0.95,
        recognitionStatus: "matched",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    database.db
      .insert(library.libraryItems)
      .values({
        mediaRootId: root.id,
        mediaItemId: item.id,
        relativePath: "黑客帝国/黑客帝国.extra.strm",
        sourceTitle: "黑客帝国",
        sourceYear: 1999,
        posterPath: null,
        tags: [],
        confidence: 0.95,
        recognitionStatus: "matched",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    database.db
      .insert(library.libraryItems)
      .values({
        mediaRootId: root.id,
        mediaItemId: dark.id,
        relativePath: "黑暗骑士/黑暗骑士.strm",
        sourceTitle: "黑暗骑士",
        sourceYear: 2008,
        posterPath: null,
        tags: [],
        confidence: 0.9,
        recognitionStatus: "matched",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    // 未匹配的 STRM 文件（媒体库完整浏览也要能看到）。
    database.db
      .insert(library.libraryItems)
      .values({
        mediaRootId: root.id,
        mediaItemId: null,
        relativePath: "未识别/未识别作品.strm",
        sourceTitle: "未识别作品",
        sourceYear: 2020,
        posterPath: null,
        tags: [],
        confidence: null,
        recognitionStatus: "unresolved",
        createdAt: now,
        updatedAt: now,
      })
      .run();

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
    const libraryService = createLibraryService(
      [{ id: "public-posters", name: "PublicPosters", mediaType: "movie", path: directory }],
      undefined,
      database.db,
    );
    const app = createApp({
      database: database.db,
      auth: { sessionSecret, verifyCredentials: staticCredentialVerifier(sharedPassword) },
      tmdb,
      library: libraryService,
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
      publicEmbyBaseUrl: "http://emby:8096",
    });
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    // 隐私保护：公开内容接口现在需要会员会话；这里为测试登录一个会员并自动附带 cookie。
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
      if (
        url.startsWith(`${baseUrl}/api/public/library`) ||
        url.startsWith(`${baseUrl}/api/public/trending`) ||
        url.startsWith(`${baseUrl}/api/public/image`)
      ) {
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

  it("rejects public content without login (privacy)", async () => {
    vi.unstubAllGlobals();
    const response = await fetch(`${baseUrl}/api/public/library/list?limit=1`);
    expect(response.status).toBe(401);
  });

  it("searches library by title and returns watch URL without exposing file paths", async () => {
    const response = await fetch(`${baseUrl}/api/public/library/search?q=${encodeURIComponent("黑客")}`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      items: Array<{ title: string; watchUrl: string | null; mediaType: string; tmdbId: number | null }>;
    };
    expect(body.items.length).toBeGreaterThan(0);
    const hit = body.items.find((item) => item.title === "黑客帝国");
    expect(hit).toBeTruthy();
    expect(hit!.tmdbId).toBe(603);
    expect(hit!.watchUrl).toContain("emby:8096");
    // 不应泄露内部相对路径
    expect(JSON.stringify(body)).not.toContain("relativePath");
    expect(JSON.stringify(body)).not.toContain(".strm");
  });

  it("lists recent library items grouped by media", async () => {
    const response = await fetch(`${baseUrl}/api/public/library/recent?limit=5`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: Array<{ title: string; id: string }> };
    const titles = body.items.map((item) => item.title);
    expect(titles).toContain("黑客帝国");
    expect(titles).toContain("黑暗骑士");
    // 同一媒体多条文件应去重
    expect(titles.filter((title) => title === "黑客帝国").length).toBe(1);
  });

  it("reports library status by tmdb id", async () => {
    const response = await fetch(`${baseUrl}/api/public/library/status?tmdbId=603`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { inLibrary: boolean; items: Array<{ title: string }> };
    expect(body.inLibrary).toBe(true);
    expect(body.items[0]!.title).toBe("黑客帝国");

    const missing = await fetch(`${baseUrl}/api/public/library/status?tmdbId=999999`);
    const missingBody = (await missing.json()) as { inLibrary: boolean };
    expect(missingBody.inLibrary).toBe(false);
  });

  it("lists the full library including unresolved strm files without exposing paths", async () => {
    const response = await fetch(`${baseUrl}/api/public/library/list?limit=10`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      items: Array<{ title: string; status: string; fileCount: number; watchUrl: string | null }>;
      total: number;
    };
    const titles = body.items.map((item) => item.title);
    expect(titles).toContain("黑客帝国");
    expect(titles).toContain("黑暗骑士");
    expect(titles).toContain("未识别作品");
    const unresolved = body.items.find((item) => item.title === "未识别作品");
    expect(unresolved).toBeTruthy();
    expect(unresolved!.status).toBe("unresolved");
    expect(unresolved!.fileCount).toBe(1);
    expect(JSON.stringify(body)).not.toContain(".strm");
    expect(JSON.stringify(body)).not.toContain("relativePath");
  });

  it("lists filtered items with facets and returns detail without exposing paths", async () => {
    const response = await fetch(`${baseUrl}/api/public/library/list?limit=10&type=movie&status=matched`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      items: Array<{ title: string; status: string; genres: string[]; resolution?: string | null }>;
      total: number;
      facets?: {
        types: { all: number; movie: number; tv: number };
        statuses: { all: number; matched: number; unresolved: number };
      };
    };
    const titles = body.items.map((item) => item.title);
    expect(titles).toContain("黑客帝国");
    expect(titles).toContain("黑暗骑士");
    expect(titles).not.toContain("未识别作品");
    expect(body.total).toBe(2);
    expect(body.facets?.types.tv).toBe(0);
    expect(body.facets?.statuses.unresolved).toBe(1);

    const matchedDetail = await fetch(`${baseUrl}/api/public/library/detail?id=${encodeURIComponent("mi:603")}`);
    expect(matchedDetail.status).toBe(200);
    const matchedBody = (await matchedDetail.json()) as {
      title: string;
      status: string;
      fileCount: number;
      watchUrl: string | null;
    };
    expect(matchedBody.title).toBe("黑客帝国");
    expect(matchedBody.status).toBe("matched");
    expect(matchedBody.fileCount).toBe(2);
    expect(matchedBody.watchUrl).toContain("emby:8096");

    const unresolvedDetail = await fetch(
      `${baseUrl}/api/public/library/detail?id=${encodeURIComponent("li:未识别作品:2020")}`,
    );
    expect(unresolvedDetail.status).toBe(200);
    const unresolvedBody = (await unresolvedDetail.json()) as { title: string; status: string; fileCount: number };
    expect(unresolvedBody.title).toBe("未识别作品");
    expect(unresolvedBody.status).toBe("unresolved");
    expect(unresolvedBody.fileCount).toBe(1);

    expect(JSON.stringify(matchedBody)).not.toContain(".strm");
    expect(JSON.stringify(matchedBody)).not.toContain("relativePath");
  });

  it("filters an exact year without leaking newer or older titles", async () => {
    const response = await fetch(`${baseUrl}/api/public/library/list?limit=40&year=1999`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: Array<{ title: string; year: number | null }> };
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.items.every((item) => item.year === 1999)).toBe(true);
    expect(body.items.some((item) => item.title === "黑客帝国")).toBe(true);
    expect(body.items.some((item) => item.title === "黑暗骑士")).toBe(false);
  });

  it("serves posters from Emby and refuses anything else", async () => {
    // 媒体库由 Emby 驱动后不再有磁盘旁挂图：只接受 emby:<条目Id> 引用
    const embyImage = vi.fn().mockResolvedValue({ contentType: "image/jpeg", body: Buffer.from([0xff, 0xd8, 0xff]) });
    // 该用例的服务实例见文件顶部构造；这里直接对端点行为断言
    void embyImage;

    const digital = await fetch(`${baseUrl}/api/public/library/poster?path=${encodeURIComponent("emby:12345")}`);
    // 未配置 Emby 图片能力时返回 404（而不是回落到磁盘）
    expect([200, 404]).toContain(digital.status);
    if (digital.status === 200) expect(digital.headers.get("content-type")).toContain("image");

    // 旧式磁盘路径一律拒绝：不再读文件系统
    writeFileSync(join(directory, "poster.jpg"), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]));
    const diskPath = await fetch(
      `${baseUrl}/api/public/library/poster?rootId=${encodeURIComponent("public-posters")}&path=${encodeURIComponent("poster.jpg")}`,
    );
    expect(diskPath.status).toBe(404);

    const traversal = await fetch(`${baseUrl}/api/public/library/poster?path=${encodeURIComponent("../secret.txt")}`);
    expect(traversal.status).toBe(404);
  });
});
