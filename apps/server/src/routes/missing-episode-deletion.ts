import type { Express } from "express";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import {
  libraryEpisodes,
  libraryItems,
  mediaItems,
  mediaRoots,
  missingEpisodeSnapshots,
} from "@emby-task-center/database/schema";
import { audit } from "../subscriptions/domain-utils";
import { mapWithLimit } from "../util/concurrency";
import type { MissingEpisodeRouteOptions } from "./missing-episodes";
import { getRuntimeSettings } from "../settings/runtime";
import { resolveMissingEpisodeRoot } from "../library/missing-root-scope";
import { verifyRootMissingForDeletion } from "../library/missing-delete-verification";

const DeleteSchema = z.object({
  rootId: z.string().min(1).max(512),
  mediaItemIds: z.array(z.number().int().positive()).min(1).max(100),
});

/** 删除边界来自当前库的完整 Emby 列表；绝不调用全库 TMDB 搜索。 */
export function registerMissingEpisodeDeletion(app: Express, options: MissingEpisodeRouteOptions): void {
  const { database, emby, scanner, library } = options;
  function connectionKey() {
    const live = getRuntimeSettings();
    return JSON.stringify([live.embyBaseUrl, live.embyApiKey]);
  }
  app.post("/api/missing-episodes/delete", async (request, response, next) => {
    try {
      const parsed = DeleteSchema.safeParse(request.body);
      if (!parsed.success) return void response.status(400).json({ error: "invalid_request" });
      const root = resolveMissingEpisodeRoot(database, parsed.data.rootId);
      if (!root) {
        return void response.status(400).json({ error: "invalid_media_root" });
      }
      if (!emby?.configured || !emby.listLibraryItems || !emby.deleteItem) {
        return void response.status(503).json({ error: "emby_not_configured" });
      }
      const ids = [...new Set(parsed.data.mediaItemIds)];
      const items = database
        .select()
        .from(mediaItems)
        .where(and(inArray(mediaItems.id, ids), eq(mediaItems.mediaType, "tv")))
        .all();
      const byId = new Map(items.map((item) => [item.id, item]));
      const ownedIds = new Set(
        database
          .select({ id: libraryItems.mediaItemId })
          .from(libraryItems)
          .where(and(eq(libraryItems.mediaRootId, root.id), inArray(libraryItems.mediaItemId, ids)))
          .all()
          .map((item) => item.id),
      );
      const snapshots = new Map(
        database
          .select()
          .from(missingEpisodeSnapshots)
          .where(inArray(missingEpisodeSnapshots.mediaItemId, ids))
          .all()
          .map((item) => [item.mediaItemId, item] as const),
      );
      // 在开始任何删除前等待完整列表；分页截断/异常时不执行任何写操作。
      const originalConnection = connectionKey();
      let candidates;
      try {
        candidates = await emby.listLibraryItems({ libraryId: root.containerPath.slice(5), mediaType: "tv" });
      } catch {
        return void response.status(502).json({ error: "emby_library_read_failed" });
      }
      const liveRoot = database.select().from(mediaRoots).where(eq(mediaRoots.id, root.id)).get();
      if (!liveRoot?.enabled || liveRoot.containerPath !== root.containerPath) {
        return void response.status(409).json({ error: "media_root_changed" });
      }
      if (connectionKey() !== originalConnection) {
        return void response.status(409).json({ error: "emby_connection_changed" });
      }
      const results = await mapWithLimit(ids, 2, async (mediaItemId) => {
        const item = byId.get(mediaItemId);
        const result: { mediaItemId: number; title: string; ok: boolean; embyItemIds: string[]; error?: string } = {
          mediaItemId,
          title: item?.title ?? "",
          ok: false,
          embyItemIds: [],
        };
        if (!item) return { ...result, error: "not_found" };
        if (!ownedIds.has(mediaItemId)) return { ...result, error: "outside_media_root" };
        if (item.tmdbId == null) return { ...result, error: "no_tmdb_id" };
        const snapshot = snapshots.get(mediaItemId);
        if (
          !snapshot ||
          snapshot.tmdbId !== item.tmdbId ||
          !snapshot.fetchedAt ||
          !snapshot.tmdbSeasons.length ||
          snapshot.tmdbSeasons.some((season) => season.unavailable)
        ) {
          return { ...result, error: "missing_metadata_incomplete" };
        }
        const matches = candidates.filter((candidate) => candidate.type === "tv" && candidate.tmdbId === item.tmdbId);
        if (!matches.length) return { ...result, error: "emby_item_not_found" };
        try {
          if (!(await verifyRootMissingForDeletion(database, emby, matches, snapshot.tmdbSeasons))) {
            return { ...result, error: "no_missing_episodes" };
          }
        } catch {
          return { ...result, error: "emby_episode_read_failed" };
        }
        for (const match of matches) {
          try {
            if (connectionKey() !== originalConnection) throw new Error("emby_connection_changed");
            const currentRoot = database.select().from(mediaRoots).where(eq(mediaRoots.id, root.id)).get();
            if (!currentRoot?.enabled || currentRoot.containerPath !== root.containerPath) {
              throw new Error("media_root_changed");
            }
            const currentItem = database.select().from(mediaItems).where(eq(mediaItems.id, mediaItemId)).get();
            const stillOwned = database
              .select({ id: libraryItems.id })
              .from(libraryItems)
              .where(and(eq(libraryItems.mediaRootId, root.id), eq(libraryItems.mediaItemId, mediaItemId)))
              .get();
            if (!stillOwned || currentItem?.tmdbId !== item.tmdbId || currentItem.mediaType !== "tv") {
              throw new Error("media_item_changed");
            }
            await emby.deleteItem!(match.id);
            result.embyItemIds.push(match.id);
          } catch (error) {
            if (result.embyItemIds.length)
              audit(
                database,
                "admin",
                "missing_episode.delete_partial",
                "media_item",
                mediaItemId,
                { title: item.title, rootId: root.id, rootName: root.name },
                { embyItemIds: result.embyItemIds },
              );
            const reason = error instanceof Error ? error.message : "";
            return {
              ...result,
              error: ["emby_connection_changed", "media_root_changed", "media_item_changed"].includes(reason)
                ? reason
                : "emby_delete_failed",
            };
          }
        }
        database.transaction((tx) => {
          const localIds = tx
            .select({ id: libraryItems.id })
            .from(libraryItems)
            .where(and(eq(libraryItems.mediaRootId, root.id), eq(libraryItems.mediaItemId, mediaItemId)))
            .all()
            .map((row) => row.id);
          if (localIds.length) {
            tx.delete(libraryEpisodes).where(inArray(libraryEpisodes.libraryItemId, localIds)).run();
            tx.delete(libraryItems).where(inArray(libraryItems.id, localIds)).run();
          }
          // 同时推进分页汇总版本，避免 TTL 内展示旧的作品数量。
          tx.update(mediaRoots).set({ updatedAt: new Date().toISOString() }).where(eq(mediaRoots.id, root.id)).run();
          const remaining = tx
            .select({ id: libraryItems.id })
            .from(libraryItems)
            .where(eq(libraryItems.mediaItemId, mediaItemId))
            .get();
          // 快照按作品聚合：另一个库仍有副本时保留，后台重算其缺集结果。
          if (!remaining)
            tx.delete(missingEpisodeSnapshots).where(eq(missingEpisodeSnapshots.mediaItemId, mediaItemId)).run();
          audit(
            tx,
            "admin",
            "missing_episode.deleted",
            "media_item",
            mediaItemId,
            { title: item.title, rootId: root.id, rootName: root.name },
            { embyItemIds: result.embyItemIds },
          );
        });
        const serviceRootId = library?.rootIdForPath?.(root.containerPath);
        library?.invalidateInventory(serviceRootId ?? undefined);
        result.ok = true;
        return result;
      });
      const deleted = results.filter((result) => result.ok).length;
      if (results.some((result) => result.embyItemIds.length)) void scanner.run("manual").catch(() => {});
      response.json({ rootId: parsed.data.rootId, results, deleted, failed: results.length - deleted });
    } catch (error) {
      next(error);
    }
  });
}
