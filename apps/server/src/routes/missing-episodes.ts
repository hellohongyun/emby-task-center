import type { Express } from "express";
import type { MissingMetadataIssue } from "../library/missing-tmdb-cache";
import type { AppDatabase } from "@emby-task-center/database/client";
import type { EmbyClient } from "../integrations/emby-client";
import { createCachedEmbyServerId } from "../integrations/emby-server-id";
import type { MissingEpisodeScanner } from "../library/missing-episode-scan";
import type { LibraryService } from "../library/service";
import { missingEpisodeRoots } from "../library/missing-root-scope";
import { readRootMissingEpisodesAsync } from "../library/missing-root-reader";
import { getRuntimeSettings } from "../settings/runtime";
import { registerMissingEpisodeDeletion } from "./missing-episode-deletion";
import {
  missingEmbyResolverUrl,
  missingEmbyWebBase,
  registerMissingEpisodeEmbyLink,
} from "./missing-episode-emby-link";

export interface MissingEpisodeRouteOptions {
  database: AppDatabase;
  scanner: MissingEpisodeScanner;
  library?: LibraryService | undefined;
  emby?: EmbyClient | undefined;
  publicEmbyBaseUrl?: string | undefined;
}

/** Cached TMDB metadata is shared; inventory and totals always belong to one enabled root. */
export function registerMissingEpisodeRoutes(app: Express, options: MissingEpisodeRouteOptions): void {
  const { database, scanner, emby } = options;
  const resolveServerId = createCachedEmbyServerId(emby, () => {
    const live = getRuntimeSettings();
    return JSON.stringify([live.embyBaseUrl, live.embyApiKey]);
  });
  app.get("/api/missing-episodes", async (request, response, next) => {
    try {
      const roots = missingEpisodeRoots(database);
      const selected = request.query.rootId;
      if (selected !== undefined && (typeof selected !== "string" || !roots.some((root) => root.rootId === selected))) {
        return void response.status(400).json({ error: "invalid_media_root" });
      }
      const root = selected === undefined ? roots[0] : roots.find((entry) => entry.rootId === selected);
      const status = scanner.status();
      const webBaseUrl = missingEmbyWebBase(options);
      const rows = root
        ? await readRootMissingEpisodesAsync(database, root, { metadataIssues: status.metadataIssues ?? [] })
        : [];
      const metadataByItem = new Map<number, MissingMetadataIssue>();
      for (const row of rows) {
        if (row.metadata)
          metadataByItem.set(row.mediaItemId, {
            ...row.metadata,
            mediaItemId: row.mediaItemId,
            tmdbId: row.tmdbId,
            title: row.title,
          });
      }
      const metadataIssues = [...metadataByItem.values()].sort((a, b) => a.title.localeCompare(b.title, "zh-CN"));
      const shows = rows
        .filter(
          (row) =>
            row.missingCount > 0 ||
            row.pendingCount > 0 ||
            row.suspectSeasons.length > 0 ||
            row.unmatchedSeasons.length > 0 ||
            row.metadata !== null ||
            row.error !== null,
        )
        .sort(
          (a, b) =>
            Number(a.missingCount === 0) - Number(b.missingCount === 0) ||
            b.missingCount - a.missingCount ||
            a.title.localeCompare(b.title, "zh-CN"),
        )
        .map(({ scannedAt: _scannedAt, embyTmdbId: _embyTmdbId, ...show }) => ({
          ...show,
          embyUrl: webBaseUrl && root ? missingEmbyResolverUrl(root.rootId, show.mediaItemId) : null,
          seasons: show.seasons.map((season) => ({
            ...season,
            embyUrl:
              webBaseUrl && root ? missingEmbyResolverUrl(root.rootId, show.mediaItemId, season.seasonNumber) : null,
          })),
          pendingSeasons: show.pendingSeasons.map((season) => ({
            ...season,
            embyUrl:
              webBaseUrl && root ? missingEmbyResolverUrl(root.rootId, show.mediaItemId, season.seasonNumber) : null,
          })),
        }));
      const scanDates = rows.flatMap((row) => (row.scannedAt ? [row.scannedAt] : []));
      response.json({
        rootId: root?.rootId ?? null,
        inventoryIssue: root
          ? root.lastScanStatus === "failed"
            ? "scan_failed"
            : !root.lastScannedAt
              ? "not_scanned"
              : null
          : null,
        libraries: roots.map(({ rootId, name, mediaType }) => ({ rootId, name, mediaType })),
        generatedAt: new Date().toISOString(),
        lastScanAt: scanDates.sort().at(-1) ?? null,
        scanning: status.running,
        progress: status.running ? { processed: status.processed, total: status.total } : null,
        mismatchCount: 0,
        mismatches: [],
        metadataIssueCount: metadataIssues.length,
        metadataIssues,
        // The inventory has no root-scoped parent IDs. Never reuse another root's global verification links.
        emby: webBaseUrl ? { webBaseUrl, serverId: resolveServerId() } : null,
        showCount: shows.filter((show) => show.missingCount > 0).length,
        pendingShowCount: shows.filter((show) => show.missingCount === 0 && show.pendingCount > 0).length,
        episodeCount: shows.reduce((sum, show) => sum + show.missingCount, 0),
        pendingEpisodeCount: shows.reduce((sum, show) => sum + show.pendingCount, 0),
        shows,
      });
    } catch (error) {
      next(error);
    }
  });
  app.post("/api/missing-episodes/scan", (_request, response) => {
    if (scanner.status().running) return void response.status(202).json({ started: false, scanning: true });
    void scanner.run("manual");
    response.status(202).json({ started: true, scanning: true });
  });
  registerMissingEpisodeDeletion(app, options);
  registerMissingEpisodeEmbyLink(app, options, resolveServerId);
}
