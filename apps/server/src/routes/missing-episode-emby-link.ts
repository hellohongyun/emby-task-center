import type { Express } from "express";
import { and, eq } from "drizzle-orm";
import { libraryItems, mediaItems } from "@emby-task-center/database/schema";
import { resolveMissingEpisodeRoot } from "../library/missing-root-scope";
import { getRuntimeSettings } from "../settings/runtime";
import type { MissingEpisodeRouteOptions } from "./missing-episodes";

/** Keep web URLs free of credentials and query tokens, even if a pasted configuration contains them. */
export function missingEmbyWebBase(options: MissingEpisodeRouteOptions): string {
  const configured = (getRuntimeSettings().embyWebUrl || options.publicEmbyBaseUrl || "").trim();
  if (!configured) return "";
  try {
    const url = new URL(configured);
    if (!["http:", "https:"].includes(url.protocol)) return "";
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url
      .toString()
      .replace(/\/+$/, "")
      .replace(/\/web(?:\/index\.html)?$/i, "");
  } catch {
    return "";
  }
}

export function missingEmbyResolverUrl(rootId: string, mediaItemId: number, seasonNumber?: number): string {
  const query = new URLSearchParams({ rootId, mediaItemId: String(mediaItemId) });
  if (seasonNumber !== undefined) query.set("seasonNumber", String(seasonNumber));
  return `/api/missing-episodes/emby-link?${query}`;
}

/** Resolve links on click using only the selected root, without slowing regular inventory reads. */
export function registerMissingEpisodeEmbyLink(
  app: Express,
  options: MissingEpisodeRouteOptions,
  resolveServerId: () => string | null,
): void {
  const { database, emby } = options;
  const connectionKey = () => {
    const live = getRuntimeSettings();
    return JSON.stringify([live.embyBaseUrl, live.embyApiKey]);
  };
  app.get("/api/missing-episodes/emby-link", async (request, response, next) => {
    try {
      const { rootId, mediaItemId, seasonNumber } = request.query;
      const id = typeof mediaItemId === "string" && /^[1-9]\d*$/.test(mediaItemId) ? Number(mediaItemId) : NaN;
      const season =
        seasonNumber === undefined
          ? undefined
          : typeof seasonNumber === "string" && /^\d+$/.test(seasonNumber)
            ? Number(seasonNumber)
            : NaN;
      if (
        typeof rootId !== "string" ||
        !Number.isSafeInteger(id) ||
        (season !== undefined && !Number.isSafeInteger(season))
      ) {
        return void response.status(400).json({ error: "invalid_request" });
      }
      const root = resolveMissingEpisodeRoot(database, rootId);
      if (!root) return void response.status(400).json({ error: "invalid_media_root" });
      const item = database.select().from(mediaItems).where(eq(mediaItems.id, id)).get();
      const ownsItem = () =>
        Boolean(
          database
            .select({ id: libraryItems.id })
            .from(libraryItems)
            .where(and(eq(libraryItems.mediaRootId, root.id), eq(libraryItems.mediaItemId, id)))
            .get(),
        );
      if (!item || item.mediaType !== "tv" || !ownsItem()) {
        return void response.status(404).json({ error: "outside_media_root" });
      }
      if (item.tmdbId == null) return void response.status(409).json({ error: "no_tmdb_id" });
      const webBase = missingEmbyWebBase(options);
      if (!webBase) return void response.status(503).json({ error: "emby_web_not_configured" });
      if (!emby?.configured || !emby.listLibraryItems) {
        return void response.status(503).json({ error: "emby_not_configured" });
      }
      const originalConnection = connectionKey();
      let matches;
      try {
        matches = (await emby.listLibraryItems({ libraryId: root.rootId, mediaType: "tv" })).filter(
          (candidate) => candidate.type === "tv" && candidate.tmdbId === item.tmdbId,
        );
      } catch {
        return void response.status(502).json({ error: "emby_library_read_failed" });
      }
      if (!matches.length) return void response.status(404).json({ error: "emby_item_not_found" });
      let targetId = matches[0]!.id;
      if (season !== undefined && emby.listSeasons) {
        try {
          for (const match of matches) {
            const target = (await emby.listSeasons(match.id)).find((entry) => entry.seasonNumber === season);
            if (target) {
              targetId = target.id;
              break;
            }
          }
        } catch {
          return void response.status(502).json({ error: "emby_season_read_failed" });
        }
      }
      const liveRoot = resolveMissingEpisodeRoot(database, rootId);
      if (!liveRoot || liveRoot.id !== root.id || liveRoot.containerPath !== root.containerPath) {
        return void response.status(409).json({ error: "media_root_changed" });
      }
      const currentItem = database.select().from(mediaItems).where(eq(mediaItems.id, id)).get();
      if (!ownsItem() || currentItem?.tmdbId !== item.tmdbId || currentItem.mediaType !== "tv") {
        return void response.status(409).json({ error: "media_item_changed" });
      }
      if (connectionKey() !== originalConnection || missingEmbyWebBase(options) !== webBase) {
        return void response.status(409).json({ error: "emby_connection_changed" });
      }
      const query = new URLSearchParams({ id: targetId });
      const serverId = resolveServerId();
      if (serverId) query.set("serverId", serverId);
      response.setHeader("Cache-Control", "no-store");
      response.redirect(302, `${webBase}/web/index.html#!/item?${query}`);
    } catch (error) {
      next(error);
    }
  });
}
