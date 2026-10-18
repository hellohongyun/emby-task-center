import type { Express } from "express";
import { and, eq, inArray, isNull } from "drizzle-orm";

import type { AppDatabase } from "@emby-task-center/database/client";
import { libraryItems, mediaAliases, mediaItems, mediaRoots } from "@emby-task-center/database/schema";
import { refreshTvTaskAirProgress } from "../library/air-progress";
import type { LibraryService } from "../library/service";
import { cleanupOrphanMediaItems, matchUnresolvedToTmdb, buildTmdbPayload } from "../library/tmdb-enrichment";
import type { TmdbClient } from "../tmdb/client";
import { registerLibraryPages } from "./library-pages";

export interface LibraryRouteOptions {
  library: LibraryService;
  database: AppDatabase;
  tmdb: TmdbClient;
  /** Emby 客户端：媒体库改用 Emby 当信息源后，海报由服务端带 token 代理取图。 */
  emby?: { image?(itemId: string): Promise<{ contentType: string; body: Buffer } | null> } | undefined;
}

// P3：位置参数改为选项对象（_notifier 占位已无人使用，直接删除）。
export function registerLibraryRoutes(app: Express, options: LibraryRouteOptions): void {
  const { library, database, tmdb, emby } = options;
  const invalidatePages = registerLibraryPages(app, database, library);
  app.get("/api/library/roots", (_request, response) => {
    response.json({ roots: library.listRoots() });
  });

  /** 补齐未匹配 STRM 的 TMDB 元数据（限速处理），并回收无引用的孤儿媒体条目。 */
  app.post("/api/library/match-unresolved", async (request, response, next) => {
    try {
      const limit = Math.max(1, Math.min(500, Number(request.query.limit) || 200));
      const matched = await matchUnresolvedToTmdb(database, tmdb, { limit });
      const cleaned = cleanupOrphanMediaItems(database, { limit: 500 });
      // 这两步都会改 library_items，库存缓存必须作废，否则页面还显示旧的海报/题材
      library.invalidateInventory();
      invalidatePages();
      response.json({ ...matched, cleaned });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/library/roots/:rootId/scan", async (request, response, next) => {
    try {
      const result = await library.scanRoot(request.params.rootId);
      if (!result) {
        response.status(404).json({ error: "library_root_not_found" });
        return;
      }
      await refreshTvTaskAirProgress(database, tmdb);
      response.json(result);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/library/roots/:rootId/scan", async (request, response, next) => {
    try {
      const result = await library.scanRoot(request.params.rootId);
      if (!result) {
        response.status(404).json({ error: "library_root_not_found" });
        return;
      }
      await refreshTvTaskAirProgress(database, tmdb);
      // 当前页会单独读取作品概要，不再把整库分集作为扫描响应下发。
      invalidatePages();
      response.json({ root: result.root, discoveredCount: result.items.length });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/library/roots/:rootId/inventory", (request, response) => {
    /*
     * 直接 send 服务端**已序列化好**的 JSON。
     *
     * 为什么不用 `response.json(inventory)`：这个接口要为每个库根吐出几万条 item
     * （最大的根 66,202 条 ≈ 34MB），而媒体库页一次并发拉全部 32 个根。
     * 每次都 stringify 几十 MB 是同步阻塞，会把事件循环占满、拖死其它页面。
     * 服务端把序列化结果连同库存一起缓存，重复请求几乎零成本。
     */
    const payload = library.getInventoryPayload(request.params.rootId);
    if (payload === null) {
      response.status(404).json({ error: "library_root_not_found" });
      return;
    }
    response.type("application/json").send(payload);
  });

  app.post("/api/library/bind-unresolved", async (request, response, next) => {
    try {
      const databaseId = Number(request.body?.databaseId);
      const tmdbId = Number(request.body?.tmdbId);
      const hasPathLocator = typeof request.body?.relativePath === "string" && typeof request.body?.rootId === "string";
      if (
        !Number.isInteger(tmdbId) ||
        tmdbId <= 0 ||
        (!(Number.isInteger(databaseId) && databaseId > 0) && !hasPathLocator)
      ) {
        return void response.status(400).json({ error: "invalid_args" });
      }
      let row =
        Number.isInteger(databaseId) && databaseId > 0
          ? database.select().from(libraryItems).where(eq(libraryItems.id, databaseId)).get()
          : undefined;
      // 前端用的可能是旧扫描快照的 id（扫描会重建行），用 目录标识 + 相对路径 兜底定位。
      if (!row && hasPathLocator) {
        const rootKey = String(request.body.rootId);
        const rootMatch = database
          .select({ id: mediaRoots.id, name: mediaRoots.name })
          .from(mediaRoots)
          .all()
          .find((item) => item.name.toLowerCase() === rootKey.toLowerCase() || String(item.id) === rootKey);
        if (rootMatch) {
          row = database
            .select()
            .from(libraryItems)
            .where(
              and(
                eq(libraryItems.mediaRootId, rootMatch.id),
                eq(libraryItems.relativePath, String(request.body.relativePath)),
              ),
            )
            .get();
        }
      }
      if (!row) {
        return void response.status(404).json({ error: "library_item_not_found" });
      }
      const root = database.select().from(mediaRoots).where(eq(mediaRoots.id, row.mediaRootId)).get();
      const types: Array<"movie" | "tv"> =
        root?.mediaType === "movie" ? ["movie"] : root?.mediaType === "tv" ? ["tv"] : ["movie", "tv"];
      let meta: Awaited<ReturnType<typeof tmdb.details>> | null = null;
      for (const mediaType of types) {
        try {
          meta = await tmdb.details(mediaType, tmdbId);
          break;
        } catch {
          // try next type
        }
      }
      if (!meta) {
        return void response.status(400).json({ error: "tmdb_not_found" });
      }
      // 绑定护栏：电影目录不能绑剧集，剧集目录不能绑电影。
      if (root?.mediaType === "movie" && meta.mediaType !== "movie") {
        return void response.status(400).json({ error: "type_mismatch", message: "该目录是电影目录，不能绑定剧集。" });
      }
      if (root?.mediaType === "tv" && meta.mediaType !== "tv") {
        return void response.status(400).json({ error: "type_mismatch", message: "该目录是剧集目录，不能绑定电影。" });
      }
      const timestamp = new Date().toISOString();
      let media = database
        .select()
        .from(mediaItems)
        .where(and(eq(mediaItems.mediaType, meta.mediaType), eq(mediaItems.tmdbId, meta.id)))
        .get();
      if (!media) {
        const inserted = database
          .insert(mediaItems)
          .values({
            tmdbId: meta.id,
            mediaType: meta.mediaType,
            title: meta.title,
            originalTitle: meta.originalTitle || null,
            releaseYear: meta.releaseYear,
            overview: meta.overview ?? "",
            posterUrl: meta.posterUrl,
            backdropUrl: meta.backdropUrl,
            genres: meta.genres ?? [],
            languages: [],
            regions: [],
            platforms: [],
            seasonCount: meta.mediaType === "tv" ? (meta.seasons?.length ?? null) : null,
            episodeCount:
              meta.mediaType === "tv"
                ? (meta.totalEpisodes ?? meta.seasons?.reduce((sum, season) => sum + season.episodeCount, 0) ?? null)
                : null,
            aliases: [],
            externalIds: {},
            tmdbPayload: buildTmdbPayload(meta),
            syncedAt: timestamp,
            createdAt: timestamp,
            updatedAt: timestamp,
          })
          .returning({ id: mediaItems.id })
          .get();
        media = database.select().from(mediaItems).where(eq(mediaItems.id, inserted.id)).get();
      }
      if (!media) {
        return void response.status(500).json({ error: "media_item_not_created" });
      }
      const peerRows = database
        .select({ id: libraryItems.id })
        .from(libraryItems)
        .where(
          and(
            eq(libraryItems.mediaRootId, row.mediaRootId),
            isNull(libraryItems.mediaItemId),
            eq(libraryItems.sourceTitle, row.sourceTitle),
            row.sourceYear == null ? isNull(libraryItems.sourceYear) : eq(libraryItems.sourceYear, row.sourceYear),
          ),
        )
        .all();
      const peerIds = peerRows.map((peer) => peer.id);
      if (!peerIds.includes(databaseId)) peerIds.push(databaseId);
      const updated = database
        .update(libraryItems)
        .set({
          mediaItemId: media.id,
          sourceTitle: meta.title,
          sourceYear: meta.releaseYear,
          recognitionStatus: "matched",
          confidence: 1,
          updatedAt: timestamp,
        })
        .where(inArray(libraryItems.id, peerIds))
        .run();
      // 别名学习：把片源标题记为该媒体条目的显式别名，下次扫描同款命名即可自动命中。
      const learnedTitle = row.sourceTitle?.trim();
      if (learnedTitle && learnedTitle !== meta.title) {
        const aliasExists = database
          .select({ id: mediaAliases.id })
          .from(mediaAliases)
          .where(and(eq(mediaAliases.itemId, media.id), eq(mediaAliases.name, learnedTitle)))
          .get();
        if (!aliasExists) {
          database
            .insert(mediaAliases)
            .values({
              itemId: media.id,
              name: learnedTitle,
              source: "manual",
              createdAt: timestamp,
            })
            .run();
        }
      }
      // 绑定会改写 library_items.mediaItemId / 片名年份，库存缓存随之作废
      library.invalidateInventory();
      invalidatePages();
      response.json({ linked: updated.changes, mediaItemId: media.id });
    } catch (error) {
      next(error);
    }
  });

  /** 管理端 TMDB 图片代理：解决管理界面直连 image.tmdb.org 破图/无法访问的问题。 */
  /**
   * Emby 海报代理（管理端）：库存里的 posterPath 现在是 `emby:<条目Id>` 引用，
   * 服务端带 token 取图并缓存一天——前端拿不到 token，也不该拿。
   */
  app.get("/api/library/emby-poster", async (request, response) => {
    const id = String(request.query.id ?? "");
    if (!/^[0-9]+$/.test(id) || !emby?.image) return void response.status(400).json({ error: "invalid_request" });
    const image = await emby.image(id).catch(() => null);
    if (!image) return void response.status(404).json({ error: "image_not_found" });
    response.setHeader("content-type", image.contentType);
    response.setHeader("cache-control", "private, max-age=86400");
    response.send(image.body);
  });

  app.get("/api/library/tmdb-image", async (request, response) => {
    const raw = String(request.query.url ?? "");
    if (!/^https?:\/\//i.test(raw)) return void response.status(400).json({ error: "invalid_url" });
    try {
      const parsed = new URL(raw);
      const allowedHosts = ["image.tmdb.org", "www.themoviedb.org", "themoviedb.org"];
      if (!allowedHosts.includes(parsed.hostname)) {
        return void response.status(403).json({ error: "host_not_allowed" });
      }
    } catch {
      return void response.status(400).json({ error: "invalid_url" });
    }
    try {
      const fetched = await fetch(raw, {
        signal: AbortSignal.timeout(15_000),
        headers: { referer: "https://www.themoviedb.org/" },
      });
      if (!fetched.ok) throw new Error(`upstream_${fetched.status}`);
      const contentType = fetched.headers.get("content-type") ?? "image/jpeg";
      const buffer = Buffer.from(await fetched.arrayBuffer());
      response.setHeader("content-type", contentType);
      response.setHeader("cache-control", "public, max-age=86400");
      response.send(buffer);
    } catch {
      const placeholder = Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="150" height="220"><rect width="150" height="220" fill="#15242e"/><text x="75" y="115" fill="#3a5666" font-size="26" text-anchor="middle">海报</text></svg>',
      );
      response.setHeader("content-type", "image/svg+xml");
      response.setHeader("cache-control", "no-store");
      response.send(placeholder);
    }
  });

  app.get("/api/library/media/:mediaItemId", (request, response) => {
    const id = Number(request.params.mediaItemId);
    if (!Number.isInteger(id) || id <= 0) {
      return void response.status(400).json({ error: "invalid_id" });
    }
    const item = database.select().from(mediaItems).where(eq(mediaItems.id, id)).get();
    if (!item) {
      return void response.status(404).json({ error: "media_item_not_found" });
    }
    response.json({ item });
  });

  app.get("/api/library/roots/:rootId/inventory/:itemId", (request, response) => {
    const item = library.getItem(request.params.rootId, request.params.itemId);
    if (!item) {
      response.status(404).json({ error: "library_item_not_found" });
      return;
    }
    response.json({ item });
  });

  app.get("/api/library/roots/:rootId/folders", (request, response) => {
    if (!library.listRoots().some((root) => root.id === request.params.rootId)) {
      response.status(404).json({ error: "library_root_not_found" });
      return;
    }
    response.json({ folders: library.listRootFolders?.(request.params.rootId) ?? [] });
  });
}
