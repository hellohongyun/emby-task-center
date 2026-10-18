import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";

import { createDatabase, type DatabaseHandle } from "@emby-task-center/database/client";
import {
  libraryEpisodes,
  libraryItems,
  mediaItems,
  mediaRoots,
  mediaTasks,
  taskSeasons,
} from "@emby-task-center/database/schema";
import { claimTask, createManualTask, createTask } from "@emby-task-center/task-domain/task-service";
import { createApp } from "../app";
import { staticCredentialVerifier } from "../auth/test-session";
import { createLibraryService } from "../library/service";
import type { ScannedMediaItem } from "../library/scan-types";
import { createTmdbClient, type TmdbFetch } from "../tmdb/client";

const sharedPassword = "family-password";
const sessionSecret = "session-signing-secret";
const tmdbToken = "tmdb-server-token";

describe("REST API", () => {
  let directory: string;
  let database: DatabaseHandle;
  let server: Server;
  let baseUrl: string;
  let tmdbAuthorization: string | null;
  let tmdbRequests: string[];
  let webRoot: string;
  let libraryScanItems: ScannedMediaItem[];

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "emby-api-"));
    database = createDatabase(join(directory, "api.sqlite"));
    tmdbAuthorization = null;
    tmdbRequests = [];
    webRoot = join(directory, "web");
    mkdirSync(webRoot);
    writeFileSync(join(webRoot, "index.html"), '<div id="app">production-spa</div>');
    libraryScanItems = [
      {
        relativePath: "Dark/Season 01/Dark.S01E01.strm",
        identity: {
          physicalSeason: 1,
          parsedSeason: 1,
          episodeNumbers: [1],
          absoluteEpisodeNumbers: [],
          numberingMode: "seasonal" as const,
          warning: null,
        },
      },
    ];

    const fetchTmdb: TmdbFetch = async (input, init) => {
      tmdbAuthorization = new Headers(init?.headers).get("authorization");
      const url = String(input);
      tmdbRequests.push(url);
      if (url.includes("/movie/101?")) {
        return new Response(
          JSON.stringify({
            id: 101,
            title: "Arrival",
            original_title: "Arrival",
            release_date: "2016-11-11",
            overview: "First contact.",
            poster_path: "/arrival.jpg",
            backdrop_path: "/arrival-bg.jpg",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/tv/202?")) {
        return new Response(
          JSON.stringify({
            id: 202,
            name: "Dark",
            original_name: "Dark",
            first_air_date: "2017-12-01",
            overview: "A missing child.",
            poster_path: "/dark.jpg",
            backdrop_path: null,
            number_of_episodes: 26,
            seasons: [{ season_number: 1, name: "第1季", episode_count: 26, air_date: "2017-12-01" }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/tv/202/season/1?")) {
        return new Response(JSON.stringify({ episodes: [{ air_date: "2017-12-01" }, { air_date: "2018-01-01" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/tv/70523?")) {
        return new Response(
          JSON.stringify({
            id: 70523,
            name: "Dark",
            original_name: "Dunkel",
            first_air_date: "2017-12-01",
            overview: "A missing child.",
            poster_path: "/dark.jpg",
            backdrop_path: "/dark-bg.jpg",
            number_of_seasons: 1,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/tv/70523/season/0?")) {
        return new Response(JSON.stringify({ episodes: [{ air_date: "2017-09-30" }, { air_date: "2017-12-01" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/tv/70523/season/1?")) {
        return new Response(JSON.stringify({ episodes: [{ air_date: "2017-12-01" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({
          results: [
            {
              id: 101,
              media_type: "movie",
              title: "Arrival",
              original_title: "Arrival",
              release_date: "2016-11-11",
              overview: "First contact.",
              poster_path: "/arrival.jpg",
              backdrop_path: "/arrival-bg.jpg",
            },
            {
              id: 202,
              media_type: "tv",
              name: "Dark",
              original_name: "Dark",
              first_air_date: "2017-12-01",
              overview: "A missing child.",
              poster_path: "/dark.jpg",
              backdrop_path: null,
            },
            { id: 303, media_type: "person", name: "A Performer" },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const library = createLibraryService(
      [{ id: "tv", name: "TV", mediaType: "tv", path: "configured-tv-root" }],
      async () => libraryScanItems,
      database.db,
    );

    const app = createApp({
      database: database.db,
      auth: { sessionSecret, verifyCredentials: staticCredentialVerifier(sharedPassword) },
      authLimits: { maxFailedAttempts: 5, lockoutMinutes: 60 },
      tmdb: createTmdbClient({ token: tmdbToken, fetchImpl: fetchTmdb }),
      library,
      webDistPath: webRoot,
    });
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });

  /**
   * 新建任务（完结入库）—— 追更下线后任务中心唯一的创建入口。
   * 之前这个入口整条被删掉，看板就成了空壳；现在恢复成 ingest 语义。
   */
  it("creates an ingest task from a TMDB hit and is idempotent", async () => {
    const cookie = await login();
    const body = JSON.stringify({ tmdbId: 202, title: "Dark", mediaType: "tv" });

    const created = await fetch(`${baseUrl}/api/tasks`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body,
    });
    expect(created.status).toBe(201);
    const payload = (await created.json()) as {
      created: boolean;
      task: { id: number; taskType: string; title: string; airProgress: number | null };
      seasons: Array<{ seasonNumber: number; airProgress: number | null }>;
    };
    expect(payload.created).toBe(true);
    expect(payload.task.taskType).toBe("ingest");
    expect(payload.task.title).toBe("Dark");
    // TMDB mock：S1 已播 2 集
    expect(payload.task.airProgress).toBe(2);
    expect(payload.seasons.map((season) => season.seasonNumber)).toEqual([1]);
    expect(payload.seasons[0].airProgress).toBe(2);

    // 同一部剧重复添加：复用已有任务，不再多建一条
    const again = await fetch(`${baseUrl}/api/tasks`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body,
    });
    expect(again.status).toBe(200);
    expect(((await again.json()) as { created: boolean }).created).toBe(false);

    const list = (await (await fetch(`${baseUrl}/api/tasks`, { headers: { cookie } })).json()) as {
      tasks: Array<{ id: number }>;
    };
    expect(list.tasks.filter((task) => task.id === payload.task.id)).toHaveLength(1);
  });

  it("rejects a malformed create request", async () => {
    const cookie = await login();
    const response = await fetch(`${baseUrl}/api/tasks`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ tmdbId: -1, title: "" }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_request" });
  });

  it("rejects protected API access without a valid session", async () => {
    const response = await fetch(`${baseUrl}/api/tasks`);

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
  });

  it("serves the compiled SPA entrypoint from the application server", async () => {
    const response = await fetch(`${baseUrl}/`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(await response.text()).toBe('<div id="app">production-spa</div>');
  });

  it("rate limits repeated shared-password failures", async () => {
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "wrong-password" }),
      });
      statuses.push(response.status);
      if (attempt === 4) expect(response.headers.get("retry-after")).toBe("3600");
    }

    expect(statuses).toEqual([401, 401, 401, 401, 429]);
  });

  it("normalizes movie and TV search results without exposing the TMDB token", async () => {
    const cookie = await login();
    const response = await fetch(`${baseUrl}/api/tmdb/search?q=dark`, {
      headers: { cookie },
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      results: [
        {
          id: 101,
          mediaType: "movie",
          title: "Arrival",
          originalTitle: "Arrival",
          releaseYear: 2016,
          releaseDate: "2016-11-11",
          overview: "First contact.",
          posterUrl: "https://image.tmdb.org/t/p/w500/arrival.jpg",
          backdropUrl: "https://image.tmdb.org/t/p/w1280/arrival-bg.jpg",
          runtime: null,
          status: null,
          voteAverage: null,
          budget: null,
          revenue: null,
          trailerKey: null,
        },
        {
          id: 202,
          mediaType: "tv",
          title: "Dark",
          originalTitle: "Dark",
          releaseYear: 2017,
          releaseDate: "2017-12-01",
          overview: "A missing child.",
          posterUrl: "https://image.tmdb.org/t/p/w500/dark.jpg",
          backdropUrl: null,
          totalEpisodes: 26,
          seasons: [{ seasonNumber: 1, name: "第1季", episodeCount: 26, airDate: "2017-12-01" }],
          airedEpisodes: 2,
          runtime: null,
          status: null,
          voteAverage: null,
          budget: null,
          revenue: null,
          trailerKey: null,
        },
      ],
    });
    expect(tmdbAuthorization).toBe(`Bearer ${tmdbToken}`);
    expect(JSON.stringify(body)).not.toContain(tmdbToken);
    expect(cookie).not.toContain(tmdbToken);
  });

  it("keeps season-number mismatches out of the missing-episode totals", async () => {
    const cookie = await login();
    const { task } = createTaskFixture({
      mediaType: "tv",
      taskType: "ingest",
      title: "Dark",
      tmdbId: 202,
      seasonNumber: 1,
    });
    // 看板的已播数来自分季行：手工登记 S01 已播 2 集，不依赖 TMDB 网络。
    const seasonSeededAt = new Date().toISOString();
    database.db
      .update(taskSeasons)
      .set({ airProgress: 2, lastCheckAt: seasonSeededAt, updatedAt: seasonSeededAt })
      .where(and(eq(taskSeasons.taskId, task.id), eq(taskSeasons.seasonNumber, 1)))
      .run();
    const mediaItemId = database.db
      .select({ mediaItemId: mediaTasks.mediaItemId })
      .from(mediaTasks)
      .where(eq(mediaTasks.id, task.id))
      .get()!.mediaItemId;

    // Emby 里这部剧只有 S01 的两集（E01 已入库、E02 缺）。
    const root = database.db.select().from(mediaRoots).where(eq(mediaRoots.containerPath, "configured-tv-root")).get();
    const timestamp = new Date().toISOString();
    const file = database.db
      .insert(libraryItems)
      .values({
        mediaRootId: root!.id,
        mediaItemId,
        relativePath: "Dark/Season 01/Dark.S01E01.strm",
        sourceTitle: "Dark",
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .returning({ id: libraryItems.id })
      .get()!;
    database.db
      .insert(libraryEpisodes)
      .values({
        libraryItemId: file.id,
        parsedSeason: 1,
        episodeNumber: 1,
        numberingMode: "seasonal",
        createdAt: timestamp,
      })
      .run();
    // TMDB 另外报了一季（S03），但媒体库里没有任何一集 → 季号对不上，不能算成整季缺失。
    database.db
      .insert(taskSeasons)
      .values({
        taskId: task.id,
        seasonNumber: 3,
        status: "tracking",
        airProgress: 8,
        lastCheckAt: timestamp,
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .run();

    const list = await fetch(`${baseUrl}/api/tasks`, { headers: { cookie } });
    const body = (await list.json()) as {
      tasks: Array<{
        id: number;
        airProgress: number | null;
        storedProgress: number | null;
        missingEpisodes: number[];
        unmatchedSeasons: Array<{ seasonNumber: number; airedEpisodes: number }>;
        seasons: Array<{ seasonNumber: number; aligned: boolean; missingEpisodes: number[] }>;
      }>;
    };
    const row = body.tasks.find((item) => item.id === task.id)!;
    // 只比对对齐的 S01：已播 2、已存 1、缺 E02；S03 的 8 集不计入，单独报出来
    expect(row.airProgress).toBe(2);
    expect(row.storedProgress).toBe(1);
    expect(row.missingEpisodes).toEqual([2]);
    expect(row.unmatchedSeasons).toEqual([{ seasonNumber: 3, airedEpisodes: 8 }]);
    expect(row.seasons.find((season) => season.seasonNumber === 3)?.aligned).toBe(false);
    expect(row.seasons.find((season) => season.seasonNumber === 3)?.missingEpisodes).toEqual([]);
  });

  /**
   * 「今日更新」：当天 18 点更新、20 点才入库的集，早上打开看板不该显示"缺集"。
   *
   * 已播 5 集、其中 E05 是今天刚播的（还在入库宽限期内）→ 缺集只按 E01–E04 比对（已存 4 集 → 缺 0），
   * E05 单独进 pendingEpisodes，页面标成「今日更新」。
   */
  it("keeps today's episode out of the missing count and reports it as pending", async () => {
    const cookie = await login();
    const { task } = createTaskFixture({
      mediaType: "tv",
      taskType: "ingest",
      title: "Dark",
      tmdbId: 203,
      seasonNumber: 1,
    });
    const timestamp = new Date().toISOString();
    database.db
      .update(taskSeasons)
      .set({ airProgress: 5, airPendingProgress: 1, lastCheckAt: timestamp, updatedAt: timestamp })
      .where(and(eq(taskSeasons.taskId, task.id), eq(taskSeasons.seasonNumber, 1)))
      .run();
    const mediaItemId = database.db
      .select({ mediaItemId: mediaTasks.mediaItemId })
      .from(mediaTasks)
      .where(eq(mediaTasks.id, task.id))
      .get()!.mediaItemId;

    // 库里已有 E01–E04：唯一"还没入库"的 E05 就是今天刚播的那一集。
    const root = database.db.select().from(mediaRoots).where(eq(mediaRoots.containerPath, "configured-tv-root")).get();
    for (const episodeNumber of [1, 2, 3, 4]) {
      const file = database.db
        .insert(libraryItems)
        .values({
          mediaRootId: root!.id,
          mediaItemId,
          relativePath: `Dark/Season 01/Dark.S01E0${episodeNumber}.strm`,
          sourceTitle: "Dark",
          createdAt: timestamp,
          updatedAt: timestamp,
        })
        .returning({ id: libraryItems.id })
        .get()!;
      database.db
        .insert(libraryEpisodes)
        .values({
          libraryItemId: file.id,
          parsedSeason: 1,
          episodeNumber,
          numberingMode: "seasonal",
          createdAt: timestamp,
        })
        .run();
    }

    const list = await fetch(`${baseUrl}/api/tasks`, { headers: { cookie } });
    const body = (await list.json()) as {
      tasks: Array<{
        id: number;
        airProgress: number | null;
        storedProgress: number | null;
        missingEpisodes: number[];
        pendingEpisodes: number[];
        seasons: Array<{ seasonNumber: number; missingEpisodes: number[]; pendingEpisodes: number[] }>;
      }>;
    };
    const row = body.tasks.find((item) => item.id === task.id)!;

    expect(row.missingEpisodes).toEqual([]);
    expect(row.pendingEpisodes).toEqual([5]);
    // 已播仍是 TMDB 口径的 5 集：差额体现为「今日更新 1 集」，不是缺集
    expect(row.airProgress).toBe(5);
    expect(row.storedProgress).toBe(4);
    expect(row.seasons.find((season) => season.seasonNumber === 1)).toMatchObject({
      missingEpisodes: [],
      pendingEpisodes: [5],
    });
  });

  /**
   * 改绑 TMDB（目标条目还不存在）：就地改绑当前条目，并按新条目重建分季与已播进度。
   * 场景：建任务时匹配到了同名的另一部剧 / 手滑填错 id，需要手动修回来。
   */
  it("rebinds a task to another TMDB entry in place and rebuilds its seasons", async () => {
    const cookie = await login();
    const created = await fetch(`${baseUrl}/api/tasks`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ tmdbId: 70523, title: "Dark", mediaType: "tv" }),
    });
    const createdBody = (await created.json()) as { task: { id: number } };
    const before = database.db.select().from(mediaTasks).where(eq(mediaTasks.id, createdBody.task.id)).get()!;

    const rebound = await fetch(`${baseUrl}/api/tasks/${createdBody.task.id}/tmdb`, {
      method: "PUT",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ tmdbId: 202 }),
    });

    expect(rebound.status).toBe(200);
    const payload = (await rebound.json()) as {
      task: { tmdbId: number; title: string; airProgress: number | null; airPendingProgress: number | null };
      seasons: Array<{ seasonNumber: number; airProgress: number | null; airPendingProgress: number | null }>;
      mediaItemId: number;
      merged: boolean;
      metadataSynced: boolean;
    };
    // 目标条目不存在 → 就地改绑：条目 Id 不变（任务、片源关联都不用动）
    expect(payload.mediaItemId).toBe(before.mediaItemId);
    expect(payload.merged).toBe(false);
    expect(payload.metadataSynced).toBe(true);
    expect(payload.task).toMatchObject({ tmdbId: 202, title: "Dark" });
    // 分季按新条目重建：S1 的两集都已播（2017-12-01 / 2018-01-01），没有"今日更新"
    expect(payload.seasons).toEqual([
      expect.objectContaining({ seasonNumber: 1, airProgress: 2, airPendingProgress: 0 }),
    ]);
    expect(payload.task.airProgress).toBe(2);
    expect(database.db.select().from(mediaItems).where(eq(mediaItems.id, before.mediaItemId)).get()).toMatchObject({
      tmdbId: 202,
      mediaType: "tv",
    });
  });

  /**
   * 改绑到"已经在用的"条目：合并过去（任务与库内片源一起迁移，旧条目回收），
   * 否则 media_items 的 (media_type, tmdb_id) 唯一键会冲突，库里也会出现重复条目。
   */
  it("merges into an existing media item when the target TMDB entry is already tracked", async () => {
    const cookie = await login();
    const keep = await fetch(`${baseUrl}/api/tasks`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ tmdbId: 202, title: "Dark", mediaType: "tv" }),
    });
    const keepTask = (await keep.json()) as { task: { id: number } };
    const wrong = await fetch(`${baseUrl}/api/tasks`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ tmdbId: 70523, title: "Dark", mediaType: "tv" }),
    });
    const wrongTask = (await wrong.json()) as { task: { id: number } };
    const wrongItemId = database.db
      .select({ mediaItemId: mediaTasks.mediaItemId })
      .from(mediaTasks)
      .where(eq(mediaTasks.id, wrongTask.task.id))
      .get()!.mediaItemId;
    // 错条目上挂着库内片源：改绑必须一起迁移，不能丢
    const root = database.db.select().from(mediaRoots).where(eq(mediaRoots.containerPath, "configured-tv-root")).get();
    const timestamp = new Date().toISOString();
    database.db
      .insert(libraryItems)
      .values({
        mediaRootId: root!.id,
        mediaItemId: wrongItemId,
        relativePath: "Dark/Season 01/Dark.S01E01.strm",
        sourceTitle: "Dark",
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .run();

    const rebound = await fetch(`${baseUrl}/api/tasks/${wrongTask.task.id}/tmdb`, {
      method: "PUT",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ tmdbId: 202, mediaType: "tv" }),
    });

    expect(rebound.status).toBe(200);
    const payload = (await rebound.json()) as { task: { tmdbId: number }; mediaItemId: number; merged: boolean };
    expect(payload.merged).toBe(true);
    expect(payload.mediaItemId).not.toBe(wrongItemId);
    expect(payload.task.tmdbId).toBe(202);
    // 旧条目被回收；两条任务与库内片源都指向保留下来的那一条
    expect(database.db.select().from(mediaItems).where(eq(mediaItems.id, wrongItemId)).get()).toBeUndefined();
    expect(
      database.db
        .select({ mediaItemId: mediaTasks.mediaItemId })
        .from(mediaTasks)
        .where(eq(mediaTasks.id, wrongTask.task.id))
        .get()!.mediaItemId,
    ).toBe(payload.mediaItemId);
    expect(
      database.db
        .select({ mediaItemId: mediaTasks.mediaItemId })
        .from(mediaTasks)
        .where(eq(mediaTasks.id, keepTask.task.id))
        .get()!.mediaItemId,
    ).toBe(payload.mediaItemId);
    expect(database.db.select().from(libraryItems).all()).toEqual([
      expect.objectContaining({ mediaItemId: payload.mediaItemId }),
    ]);
  });

  /**
   * 看板的「已存」原来只有一个总数，看不出存在哪个媒体库、库内哪个目录。
   * 这里造两个库（配置库根「TV」与 Emby 库「动漫」），E02 两边各有一份：
   * 已存要按并集算成 3 集（同一集不能算两次），并且每库各自的集数与库内目录都要报出来。
   */
  it("attributes stored episodes to their media libraries without double counting", async () => {
    const cookie = await login();
    const { task } = createTaskFixture({
      mediaType: "tv",
      taskType: "ingest",
      title: "Dark",
      tmdbId: 202,
      seasonNumber: 1,
    });
    const timestamp = new Date().toISOString();
    database.db
      .update(taskSeasons)
      .set({ airProgress: 3, lastCheckAt: timestamp, updatedAt: timestamp })
      .where(and(eq(taskSeasons.taskId, task.id), eq(taskSeasons.seasonNumber, 1)))
      .run();
    const mediaItemId = database.db
      .select({ mediaItemId: mediaTasks.mediaItemId })
      .from(mediaTasks)
      .where(eq(mediaTasks.id, task.id))
      .get()!.mediaItemId;

    const tvRoot = database.db
      .select()
      .from(mediaRoots)
      .where(eq(mediaRoots.containerPath, "configured-tv-root"))
      .get()!;
    // Emby 模式下的库根 path 是 `emby:<库Id>`，看板上报的库 id 就是 `<库Id>`。
    const animeRoot = database.db
      .insert(mediaRoots)
      .values({
        name: "动漫",
        mediaType: "tv",
        containerPath: "emby:8888",
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .returning()
      .get()!;

    const seedEpisode = (rootId: number, relativePath: string, episode: number) => {
      const file = database.db
        .insert(libraryItems)
        .values({
          mediaRootId: rootId,
          mediaItemId,
          relativePath,
          sourceTitle: "Dark",
          createdAt: timestamp,
          updatedAt: timestamp,
        })
        .returning({ id: libraryItems.id })
        .get()!;
      database.db
        .insert(libraryEpisodes)
        .values({
          libraryItemId: file.id,
          parsedSeason: 1,
          episodeNumber: episode,
          numberingMode: "seasonal",
          createdAt: timestamp,
        })
        .run();
    };
    seedEpisode(tvRoot.id, "Dark/Season 01/EP01 [1].strm", 1);
    seedEpisode(tvRoot.id, "Dark/Season 01/EP02 [2].strm", 2);
    seedEpisode(animeRoot.id, "Dark/Season 01/EP02 [3].strm", 2);
    seedEpisode(animeRoot.id, "Dark/Season 01/EP03 [4].strm", 3);

    const body = (await (await fetch(`${baseUrl}/api/tasks`, { headers: { cookie } })).json()) as {
      tasks: Array<{
        id: number;
        storedProgress: number | null;
        missingEpisodes: number[];
        libraries: Array<{
          rootId: string;
          name: string;
          episodeCount: number;
          fileCount: number;
          seasons: number[];
          path: string;
        }>;
        seasons: Array<{
          seasonNumber: number;
          storedProgress: number | null;
          libraries: Array<{ rootId: string; name: string; episodeCount: number; path: string }>;
        }>;
      }>;
    };
    const row = body.tasks.find((item) => item.id === task.id)!;
    // 已播 E01–E03；两库并集也是 3 集（E02 存了两份只算一集）→ 不缺集。
    expect(row.storedProgress).toBe(3);
    expect(row.missingEpisodes).toEqual([]);
    expect(row.libraries).toHaveLength(2);
    expect(row.libraries.find((library) => library.name === "TV")).toMatchObject({
      rootId: "configured-tv-root",
      episodeCount: 2,
      seasons: [1],
      path: "Dark",
    });
    expect(row.libraries.find((library) => library.name === "动漫")).toMatchObject({
      rootId: "8888",
      episodeCount: 2,
      fileCount: 2,
      seasons: [1],
      path: "Dark",
    });
    const season = row.seasons.find((item) => item.seasonNumber === 1)!;
    expect(season.storedProgress).toBe(3);
    expect(season.libraries.find((library) => library.name === "TV")).toMatchObject({
      episodeCount: 2,
      path: "Dark/Season 01",
    });
    expect(season.libraries.find((library) => library.name === "动漫")?.episodeCount).toBe(2);
  });

  /** 电影没有逐集明细（只有一条库内条目），照样要能报出"存在哪个库"。 */
  it("reports the owning library for a movie task without episode rows", async () => {
    const cookie = await login();
    const { task } = createTaskFixture({ mediaType: "movie", taskType: "ingest", title: "Arrival", tmdbId: 101 });
    const timestamp = new Date().toISOString();
    const mediaItemId = database.db
      .select({ mediaItemId: mediaTasks.mediaItemId })
      .from(mediaTasks)
      .where(eq(mediaTasks.id, task.id))
      .get()!.mediaItemId;
    const movieRoot = database.db
      .insert(mediaRoots)
      .values({
        name: "电影",
        mediaType: "movie",
        containerPath: "emby:7777",
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .returning()
      .get()!;
    database.db
      .insert(libraryItems)
      .values({
        mediaRootId: movieRoot.id,
        mediaItemId,
        relativePath: "Arrival (2016)/Arrival (2016) [55].strm",
        sourceTitle: "Arrival",
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .run();

    const body = (await (await fetch(`${baseUrl}/api/tasks`, { headers: { cookie } })).json()) as {
      tasks: Array<{
        id: number;
        libraries: Array<{
          rootId: string;
          name: string;
          episodeCount: number;
          fileCount: number;
          seasons: number[];
          path: string;
        }>;
      }>;
    };
    const row = body.tasks.find((item) => item.id === task.id)!;
    expect(row.libraries).toEqual([
      {
        rootId: "7777",
        name: "电影",
        mediaType: "movie",
        episodeCount: 0,
        fileCount: 1,
        seasons: [],
        path: "Arrival (2016)",
      },
    ]);
  });

  it("deletes a task together with its season rows", async () => {
    const cookie = await login();
    const { task } = createTaskFixture({
      mediaType: "tv",
      taskType: "ingest",
      title: "Dark",
      tmdbId: 202,
      seasonNumber: 1,
    });
    expect(database.db.select().from(taskSeasons).where(eq(taskSeasons.taskId, task.id)).all().length).toBeGreaterThan(
      0,
    );

    const removed = await fetch(`${baseUrl}/api/tasks/${task.id}`, { method: "DELETE", headers: { cookie } });
    expect(removed.status).toBe(204);
    // 任务私有数据跟着删：分季行不留孤儿
    expect(database.db.select().from(taskSeasons).where(eq(taskSeasons.taskId, task.id)).all()).toHaveLength(0);
    const list = (await (await fetch(`${baseUrl}/api/tasks`, { headers: { cookie } })).json()) as {
      tasks: Array<{ id: number }>;
    };
    expect(list.tasks.some((item) => item.id === task.id)).toBe(false);
    // 再删一次：已经不存在
    expect((await fetch(`${baseUrl}/api/tasks/${task.id}`, { method: "DELETE", headers: { cookie } })).status).toBe(
      404,
    );
  });

  it("updates the season number and its air progress", async () => {
    const cookie = await login();
    const { task } = createTaskFixture({
      mediaType: "tv",
      taskType: "ingest",
      title: "Dark",
      tmdbId: 70523,
      seasonNumber: 1,
    });
    // createManualTask 不写 tmdbId（它走别名匹配）；这里显式挂上，改季号后才会去 TMDB 查已播。
    const seasonScopedItemId = database.db
      .select({ id: mediaTasks.mediaItemId })
      .from(mediaTasks)
      .where(eq(mediaTasks.id, task.id))
      .get()!.id;
    database.db.update(mediaItems).set({ tmdbId: 70523 }).where(eq(mediaItems.id, seasonScopedItemId)).run();
    expect(task.seasonNumber).toBe(1);
    // 分季行是看板"已播/缺集/今日更新"的数据源：这里先造一条 S00 行，验证改季号会把它一起刷新。
    const seededAt = new Date().toISOString();
    database.db
      .insert(taskSeasons)
      .values({
        taskId: task.id,
        seasonNumber: 0,
        status: "tracking",
        airProgress: 0,
        airPendingProgress: 0,
        lastCheckAt: seededAt,
        createdAt: seededAt,
        updatedAt: seededAt,
      })
      .onConflictDoNothing()
      .run();
    const update = await fetch(`${baseUrl}/api/tasks/${task.id}/season`, {
      method: "PUT",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ seasonNumber: 0 }),
    });
    expect(update.status).toBe(200);
    const updated = (await update.json()) as { seasonNumber: number | null; airProgress: number | null };
    expect(updated.seasonNumber).toBe(0);
    expect(updated.airProgress).toBe(2);
    // 只写任务级、不写分季行的话，看板会停在旧值（表面上像"改了设置没生效"）
    const seasonRow = database.db
      .select()
      .from(taskSeasons)
      .where(and(eq(taskSeasons.taskId, task.id), eq(taskSeasons.seasonNumber, 0)))
      .get()!;
    expect(seasonRow.airProgress).toBe(2);
    expect(seasonRow.airPendingProgress).toBe(0);
  });
  it("serves season progress including the special (season 0) snapshot", async () => {
    const cookie = await login();
    const response = await fetch(`${baseUrl}/api/tmdb/tv/70523/season/0`, { headers: { cookie } });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { result: { seasonNumber: number; airedEpisodes: number } };
    expect(body.result.seasonNumber).toBe(0);
    expect(body.result.airedEpisodes).toBe(2);
  });
  it("deletes tasks in batch and reports missing or running ones as failed", async () => {
    const cookie = await login();
    // 批量建任务的接口已删除：这里直接经任务服务建一条当夹具（batch-delete 本身仍在）
    const created = createTask(database.db, { mediaType: "movie", taskType: "ingest", title: "Arrival", tmdbId: 101 });
    const taskId = created.id;
    const del = await fetch(`${baseUrl}/api/tasks/batch-delete`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ taskIds: [taskId, 999_999] }),
    });
    expect(del.status).toBe(200);
    const result = (await del.json()) as { deleted: number[]; failed: Array<{ taskId: number; error: string }> };
    expect(result.deleted).toEqual([taskId]);
    expect(result.failed).toEqual([{ taskId: 999_999, error: "not_found" }]);
  });

  it("creates a manual task and edits its progress and update schedule", async () => {
    const cookie = await login();
    const { task } = createTaskFixture({
      mediaType: "tv",
      taskType: "ingest",
      title: "斗破苍穹：年番",
      releaseYear: 2022,
    });
    expect(task).toMatchObject({ tmdbId: null, mediaType: "tv", taskType: "ingest" });

    const progress = await fetch(`${baseUrl}/api/tasks/${task.id}/progress`, {
      method: "PUT",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ airProgress: 12 }),
    });
    expect(progress.status).toBe(200);
    expect((await progress.json()).airProgress).toBe(12);

    const schedule = await fetch(`${baseUrl}/api/tasks/${task.id}/schedule`, {
      method: "PUT",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ days: [5], time: "10:00" }),
    });
    expect(schedule.status).toBe(200);
    expect(await schedule.json()).toMatchObject({ scheduleDays: [5], scheduleTime: "10:00" });
  });

  it("maps and clears a manual task folder mapping with episode counts", async () => {
    const cookie = await login();
    const task = createManualTask(database.db, {
      mediaType: "tv",
      taskType: "ingest",
      title: "仙逆",
      releaseYear: 2023,
    });
    expect(task.createdSource).toBe("manual");
    expect(task.mappedRootId).toBeNull();

    const root = database.db.select().from(mediaRoots).where(eq(mediaRoots.containerPath, "configured-tv-root")).get();
    expect(root).toBeDefined();
    const timestamp = new Date().toISOString();
    const seasonOneFiles = ["仙逆 (2023)/Season 01/仙逆.S01E01.strm", "仙逆 (2023)/Season 01/仙逆.S01E02.strm"].map(
      (relativePath) =>
        database.db
          .insert(libraryItems)
          .values({
            mediaRootId: root!.id,
            relativePath,
            sourceTitle: "仙逆",
            createdAt: timestamp,
            updatedAt: timestamp,
          })
          .returning({ id: libraryItems.id })
          .get()!,
    );
    database.db
      .insert(libraryItems)
      .values({
        mediaRootId: root!.id,
        relativePath: "仙逆 (2023)/Season 02/仙逆.S02E01.strm",
        sourceTitle: "仙逆",
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .run();
    seasonOneFiles.forEach((file, index) => {
      database.db
        .insert(libraryEpisodes)
        .values({
          libraryItemId: file.id,
          parsedSeason: 1,
          episodeNumber: index + 1,
          numberingMode: "seasonal",
          createdAt: timestamp,
        })
        .run();
    });

    const put = await fetch(`${baseUrl}/api/tasks/${task.id}/mapping`, {
      method: "PUT",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ rootId: "tv", folderPath: "仙逆 (2023)/Season 01", sourceMode: "mapped" }),
    });
    expect(put.status).toBe(200);
    const mapped = await put.json();
    expect(mapped).toMatchObject({
      folderEpisodeCount: 2,
      task: {
        createdSource: "manual",
        mappedRootId: "tv",
        mappedFolderPath: "仙逆 (2023)/Season 01",
        storedProgress: 2,
        sourceMode: "mapped",
      },
    });

    const fetched = await (await fetch(`${baseUrl}/api/tasks/${task.id}/mapping`, { headers: { cookie } })).json();
    expect(fetched).toMatchObject({
      folderEpisodeCount: 2,
      task: { mappedRootId: "tv", mappedFolderPath: "仙逆 (2023)/Season 01" },
    });

    const cleared = await (
      await fetch(`${baseUrl}/api/tasks/${task.id}/mapping`, {
        method: "DELETE",
        headers: { cookie },
      })
    ).json();
    expect(cleared.task).toMatchObject({ mappedRootId: null, mappedFolderPath: null, storedProgress: 2 });

    const invalid = await fetch(`${baseUrl}/api/tasks/${task.id}/mapping`, {
      method: "PUT",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ rootId: "tv", folderPath: "../escape" }),
    });
    expect(invalid.status).toBe(400);
    const missing = await fetch(`${baseUrl}/api/tasks/999999/mapping`, { headers: { cookie } });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "task_not_found" });
  });

  it("keeps a mapped task's stored progress when creating another TMDB task", async () => {
    const cookie = await login();
    const mappedTask = createManualTask(database.db, {
      mediaType: "tv",
      taskType: "ingest",
      title: "仙逆",
      releaseYear: 2023,
    });
    const root = database.db.select().from(mediaRoots).where(eq(mediaRoots.containerPath, "configured-tv-root")).get();
    expect(root).toBeDefined();
    const timestamp = new Date().toISOString();
    const seasonOneFiles = ["仙逆 (2023)/Season 01/仙逆.S01E01.strm", "仙逆 (2023)/Season 01/仙逆.S01E02.strm"].map(
      (relativePath) =>
        database.db
          .insert(libraryItems)
          .values({
            mediaRootId: root!.id,
            relativePath,
            sourceTitle: "仙逆",
            createdAt: timestamp,
            updatedAt: timestamp,
          })
          .returning({ id: libraryItems.id })
          .get()!,
    );
    seasonOneFiles.forEach((file, index) => {
      database.db
        .insert(libraryEpisodes)
        .values({
          libraryItemId: file.id,
          parsedSeason: 1,
          episodeNumber: index + 1,
          numberingMode: "seasonal",
          createdAt: timestamp,
        })
        .run();
    });
    // 未匹配的 Dark 库存行，创建 TMDB 任务时会被 matchInventory 命中
    database.db
      .insert(libraryItems)
      .values({
        mediaRootId: root!.id,
        relativePath: "Dark (2017)/Season 01/Dark.S01E01.strm",
        sourceTitle: "Dark",
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .run();

    const put = await fetch(`${baseUrl}/api/tasks/${mappedTask.id}/mapping`, {
      method: "PUT",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ rootId: "tv", folderPath: "仙逆 (2023)/Season 01", sourceMode: "mapped" }),
    });
    expect(put.status).toBe(200);
    expect((await put.json()).task).toMatchObject({ storedProgress: 2, sourceMode: "mapped" });

    // 让后台扫描同样产出仙逆文件夹的条目（模拟真实磁盘），否则 persistScan 会清掉手工插入的行
    libraryScanItems = [
      {
        relativePath: "Dark/Season 01/Dark.S01E01.strm",
        identity: {
          physicalSeason: 1,
          parsedSeason: 1,
          episodeNumbers: [1],
          absoluteEpisodeNumbers: [],
          numberingMode: "seasonal" as const,
          warning: null,
        },
      },
      {
        relativePath: "仙逆 (2023)/Season 01/仙逆.S01E01.strm",
        identity: {
          physicalSeason: 1,
          parsedSeason: 1,
          episodeNumbers: [1],
          absoluteEpisodeNumbers: [],
          numberingMode: "seasonal" as const,
          warning: null,
        },
      },
      {
        relativePath: "仙逆 (2023)/Season 01/仙逆.S01E02.strm",
        identity: {
          physicalSeason: 1,
          parsedSeason: 1,
          episodeNumbers: [2],
          absoluteEpisodeNumbers: [],
          numberingMode: "seasonal" as const,
          warning: null,
        },
      },
    ];

    createTaskFixture({ mediaType: "tv", taskType: "ingest", title: "Forged caller title", tmdbId: 70523 });

    const stored = database.db
      .select({ storedProgress: mediaTasks.storedProgress })
      .from(mediaTasks)
      .where(eq(mediaTasks.id, mappedTask.id))
      .get();
    expect(stored?.storedProgress).toBe(2);
  });

  it("maps a movie task folder and caps stored progress at 1", async () => {
    const cookie = await login();
    const task = createManualTask(database.db, {
      mediaType: "movie",
      taskType: "ingest",
      title: "诺兰",
      releaseYear: 2020,
    });
    const root = database.db.select().from(mediaRoots).where(eq(mediaRoots.containerPath, "configured-tv-root")).get();
    const timestamp = new Date().toISOString();
    database.db
      .insert(libraryItems)
      .values({
        mediaRootId: root!.id,
        relativePath: "Movie (2020)/Movie.strm",
        sourceTitle: "Movie",
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .run();

    const put = await fetch(`${baseUrl}/api/tasks/${task.id}/mapping`, {
      method: "PUT",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ rootId: "tv", folderPath: "Movie (2020)" }),
    });
    expect(put.status).toBe(200);
    const body = await put.json();
    expect(body).toMatchObject({
      folderEpisodeCount: 1,
      task: { mappedRootId: "tv", mappedFolderPath: "Movie (2020)", storedProgress: 1 },
    });
  });

  it("lists deduplicated folders for a library root", async () => {
    const cookie = await login();
    const root = database.db.select().from(mediaRoots).where(eq(mediaRoots.containerPath, "configured-tv-root")).get();
    expect(root).toBeDefined();
    const timestamp = new Date().toISOString();
    for (const relativePath of [
      "Dark/Season 01/Dark.S01E01.strm",
      "Dark/Season 01/Dark.S01E02.strm",
      "Dark/Season 02/Dark.S02E01.strm",
      "Other Show/Season 01/Other.S01E01.strm",
    ]) {
      database.db
        .insert(libraryItems)
        .values({
          mediaRootId: root!.id,
          relativePath,
          sourceTitle: "x",
          createdAt: timestamp,
          updatedAt: timestamp,
        })
        .run();
    }

    const response = await fetch(`${baseUrl}/api/library/roots/tv/folders`, { headers: { cookie } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      folders: ["Dark", "Dark/Season 01", "Dark/Season 02", "Other Show", "Other Show/Season 01"],
    });

    const missing = await fetch(`${baseUrl}/api/library/roots/unknown/folders`, { headers: { cookie } });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "library_root_not_found" });
  });

  it("stores and returns manual source-name aliases for a task", async () => {
    const cookie = await login();
    createTaskFixture({ mediaType: "tv", taskType: "ingest", title: "Forged", tmdbId: 70523 });

    const put = await fetch(`${baseUrl}/api/tasks/1/aliases`, {
      method: "PUT",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ aliases: ["斗破苍弯年番", "斗破苍穹年番"] }),
    });
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ aliases: ["斗破苍弯年番", "斗破苍穹年番"] });

    const settings = await (await fetch(`${baseUrl}/api/tasks/1/settings`, { headers: { cookie } })).json();
    expect(settings.aliases).toEqual(["斗破苍弯年番", "斗破苍穹年番"]);
  });

  it("returns sanitized scan metadata for a configured library root", async () => {
    const cookie = await login();
    const response = await fetch(`${baseUrl}/api/library/roots/tv/scan`, {
      headers: { cookie },
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      root: { id: "tv", name: "TV", mediaType: "tv" },
      items: [
        {
          relativePath: "Dark/Season 01/Dark.S01E01.strm",
          identity: {
            physicalSeason: 1,
            parsedSeason: 1,
            episodeNumbers: [1],
            absoluteEpisodeNumbers: [],
            numberingMode: "seasonal",
            warning: null,
          },
        },
      ],
    });
    expect(JSON.stringify(body)).not.toContain("secret.example");
  });

  it("cancels, retries, and deletes only non-running tasks", async () => {
    const cookie = await login();
    const task = createTask(database.db, { mediaType: "movie", tmdbId: 1, taskType: "ingest", title: "Movie" });
    const cancelled = await fetch(`${baseUrl}/api/tasks/${task.id}/cancel`, { method: "POST", headers: { cookie } });
    expect(cancelled.status).toBe(200);
    expect(await cancelled.json()).toMatchObject({ status: "cancelled" });
    const retried = await fetch(`${baseUrl}/api/tasks/${task.id}/retry`, { method: "POST", headers: { cookie } });
    expect(await retried.json()).toMatchObject({ status: "pending", statusMessage: null });
    claimTask(database.db, task.id, "worker");
    expect((await fetch(`${baseUrl}/api/tasks/${task.id}`, { method: "DELETE", headers: { cookie } })).status).toBe(
      409,
    );
    const removable = createTask(database.db, { mediaType: "movie", tmdbId: 3, taskType: "ingest", title: "Old" });
    expect(
      (await fetch(`${baseUrl}/api/tasks/${removable.id}`, { method: "DELETE", headers: { cookie } })).status,
    ).toBe(204);
    expect(
      (await fetch(`${baseUrl}/api/tasks/${removable.id}/cancel`, { method: "POST", headers: { cookie } })).status,
    ).toBe(404);
  });

  it("serves authenticated activity and system state without secrets", async () => {
    const cookie = await login();
    const task = createTask(database.db, { mediaType: "movie", tmdbId: 2, taskType: "ingest", title: "Arrival" });
    claimTask(database.db, task.id, "openclaw-a");

    const activity = await (await fetch(`${baseUrl}/api/activity`, { headers: { cookie } })).json();
    expect(activity).toMatchObject({
      activity: [{ taskId: task.id, title: "Arrival", phase: "claim", workerId: "openclaw-a" }],
    });
    expect(JSON.stringify(activity)).not.toContain(sessionSecret);
    const status = await (await fetch(`${baseUrl}/api/system/status`, { headers: { cookie } })).json();
    expect(status).toMatchObject({ rootCount: 1, lastScanAt: null, serverTime: expect.any(String) });
  });

  async function login(): Promise<string> {
    const response = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: sharedPassword }),
    });
    const cookie = response.headers.get("set-cookie");

    expect(response.status).toBe(200);
    expect(cookie).toContain("HttpOnly");
    return cookie!.split(";", 1)[0];
  }
  /**
   * 建任务的接口已删除（应用不再创建任务），但很多用例需要"先有一个任务"当夹具。
   * 这里直接经任务服务落库，省掉一层 fake fetch，断言照旧。
   */
  function createTaskFixture(input: Record<string, unknown>) {
    const task = createManualTask(database.db, input as unknown as Parameters<typeof createManualTask>[1]);
    return { task };
  }

  it("clears the session cookie on logout", async () => {
    const cookie = await login();
    const logout = await fetch(`${baseUrl}/api/auth/logout`, { method: "POST", headers: { cookie } });

    expect(logout.status).toBe(204);
    const setCookie = logout.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("emby_task_session=;");
    expect(setCookie).toContain("Max-Age=0");
  });

  it("exposes the completed movie retention hours in the task list response", async () => {
    const cookie = await login();
    const response = await fetch(`${baseUrl}/api/tasks`, { headers: { cookie } });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { retentionHours: number; tasks: unknown[] };
    expect(body.retentionHours).toBe(24);
    expect(Array.isArray(body.tasks)).toBe(true);
  });
});
