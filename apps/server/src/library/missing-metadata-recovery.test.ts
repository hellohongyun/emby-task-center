import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDatabase, type DatabaseHandle } from "@emby-task-center/database/client";
import {
  libraryEpisodes,
  libraryItems,
  mediaItems,
  mediaRoots,
  missingEpisodeSnapshots,
} from "@emby-task-center/database/schema";
import { readSettings, toPublicSettings, writeSettings } from "../settings/store";
import type { TmdbClient } from "../tmdb/client";
import { createMissingEpisodeScanner } from "./missing-episode-scan";
import { TMDB_CACHE_TTL_MS, TMDB_RETRY_MS } from "./missing-tmdb-cache";

const now = new Date("2026-10-03T00:00:00Z");
const episode = (number: number) => ({ episodeNumber: number, name: `第${number}集`, airDate: "2020-01-01" });

describe("persisted missing metadata recovery", () => {
  let directory: string;
  let database: DatabaseHandle;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    directory = mkdtempSync(join(tmpdir(), "emby-metadata-recovery-"));
    database = createDatabase(join(directory, "scan.sqlite"));
    const at = now.toISOString();
    const root = database.db
      .insert(mediaRoots)
      .values({ name: "剧集", mediaType: "tv", containerPath: "emby:1", createdAt: at, updatedAt: at })
      .returning()
      .get()!;
    const media = database.db
      .insert(mediaItems)
      .values({ tmdbId: 100, mediaType: "tv", title: "测试剧", createdAt: at, updatedAt: at })
      .returning()
      .get()!;
    for (const season of [1, 2]) {
      const item = database.db
        .insert(libraryItems)
        .values({
          mediaRootId: root.id,
          mediaItemId: media.id,
          relativePath: `测试剧/S${season}E01.strm`,
          sourceTitle: "测试剧",
          createdAt: at,
          updatedAt: at,
        })
        .returning()
        .get()!;
      database.db
        .insert(libraryEpisodes)
        .values({
          libraryItemId: item.id,
          parsedSeason: season,
          episodeNumber: 1,
          numberingMode: "seasonal",
          createdAt: at,
        })
        .run();
    }
  });
  afterEach(() => {
    database.close();
    rmSync(directory, { recursive: true, force: true });
    vi.useRealTimers();
  });
  function restartDatabase() {
    database.close();
    database = createDatabase(join(directory, "scan.sqlite"));
  }
  function fixture(failingSeason: number | null = 2) {
    const details = vi.fn().mockResolvedValue({
      seasons: [1, 2].map((seasonNumber) => ({ seasonNumber, episodeCount: 2, airDate: "2020-01-01" })),
    });
    const seasonEpisodes = vi.fn().mockImplementation(async (_id: number, season: number) => {
      if (season === failingSeason) throw new Error("season offline");
      return [episode(1), episode(2)];
    });
    return { tmdb: { details, seasonEpisodes } as unknown as TmdbClient, details, seasonEpisodes };
  }

  it("persists first partial failure without publishing a fake complete snapshot", async () => {
    const first = fixture();
    const scanner = createMissingEpisodeScanner({ database: database.db, tmdb: first.tmdb });
    await scanner.run("manual");
    expect(database.db.select().from(missingEpisodeSnapshots).all()).toEqual([]);
    expect(scanner.status()).toMatchObject({
      failed: 1,
      processed: 1,
      metadataIssues: [{ mediaItemId: 1, unavailableSeasons: [2], lastCompleteAt: null }],
    });

    restartDatabase();
    const next = fixture(null);
    const restarted = createMissingEpisodeScanner({ database: database.db, tmdb: next.tmdb });
    expect(restarted.status().metadataIssues).toMatchObject([{ unavailableSeasons: [2], lastCompleteAt: null }]);
    await restarted.run("startup");
    expect(next.details).not.toHaveBeenCalled();
    expect(database.db.select().from(missingEpisodeSnapshots).all()).toEqual([]);

    vi.setSystemTime(new Date(now.getTime() + TMDB_RETRY_MS));
    await restarted.run("manual");
    expect(next.seasonEpisodes.mock.calls.map((call) => call[1])).toEqual([2]);
    expect(database.db.select().from(missingEpisodeSnapshots).get()).toMatchObject({ missingCount: 2, error: null });
    expect(restarted.status().metadataIssues).toEqual([]);
    restartDatabase();
    expect(createMissingEpisodeScanner({ database: database.db, tmdb: next.tmdb }).status().metadataIssues).toEqual([]);
  });

  it("preserves the complete display when one expired season fails and recovers after restart", async () => {
    const complete = fixture(null);
    await createMissingEpisodeScanner({ database: database.db, tmdb: complete.tmdb }).run("manual");
    const before = database.db.select().from(missingEpisodeSnapshots).get()!;
    vi.setSystemTime(new Date(now.getTime() + TMDB_CACHE_TTL_MS + 1));
    const partial = fixture();
    partial.seasonEpisodes.mockImplementation(async (_id, season) => {
      if (season === 2) throw new Error("season offline");
      return [episode(1), episode(2), episode(3)];
    });
    await createMissingEpisodeScanner({ database: database.db, tmdb: partial.tmdb }).run("manual");
    const failed = database.db.select().from(missingEpisodeSnapshots).get()!;
    expect(failed).toMatchObject({
      missing: before.missing,
      missingCount: before.missingCount,
      airedCount: before.airedCount,
      storedCount: before.storedCount,
      fetchedAt: before.fetchedAt,
      scannedAt: before.scannedAt,
      error: "tmdb_partial_unavailable",
    });
    expect(failed.tmdbSeasons[0]?.episodes).toHaveLength(3);
    expect(failed.tmdbSeasons[1]?.episodes).toEqual(before.tmdbSeasons[1]?.episodes);
    restartDatabase();
    const recovery = fixture(null);
    const restarted = createMissingEpisodeScanner({ database: database.db, tmdb: recovery.tmdb });
    await restarted.run("startup");
    expect(recovery.details).not.toHaveBeenCalled();
    vi.setSystemTime(new Date(now.getTime() + TMDB_CACHE_TTL_MS + TMDB_RETRY_MS + 1));
    await restarted.run("manual");
    expect(recovery.seasonEpisodes.mock.calls.map((call) => call[1])).toEqual([2]);
    expect(database.db.select().from(missingEpisodeSnapshots).get()).toMatchObject({ missingCount: 3, error: null });
  });

  it("persists a TV-details failure with no seasons and isolates internal cache from settings APIs", async () => {
    const failure = fixture();
    failure.details.mockRejectedValue(new Error("offline"));
    await createMissingEpisodeScanner({ database: database.db, tmdb: failure.tmdb }).run("manual");
    restartDatabase();
    const next = fixture(null);
    const restarted = createMissingEpisodeScanner({ database: database.db, tmdb: next.tmdb });
    expect(restarted.status().metadataIssues).toMatchObject([{ error: "tmdb_unavailable", lastCompleteAt: null }]);
    await restarted.run("startup");
    expect(next.details).not.toHaveBeenCalled();
    expect(toPublicSettings(readSettings(database.db)).some((entry) => String(entry.key).startsWith("internal."))).toBe(
      false,
    );
    expect(writeSettings(database.db, { "internal.missingMetadataCache.1": null }).updated).toEqual([]);
  });
});
