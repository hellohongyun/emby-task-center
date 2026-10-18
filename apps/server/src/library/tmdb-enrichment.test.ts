import { describe, expect, it } from "vitest";

import { createDatabase } from "@emby-task-center/database/client";
import { libraryItems, mediaAliases, mediaItems, mediaRoots } from "@emby-task-center/database/schema";
import type { TmdbClient } from "../tmdb/client";
import { cleanupOrphanMediaItems, matchUnresolvedToTmdb } from "./tmdb-enrichment";

function tmdbMock(results: Awaited<ReturnType<TmdbClient["search"]>>): TmdbClient {
  return {
    search: async () => results,
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
}

describe("TMDB enrichment for unresolved STRM", () => {
  it("searches TMDB by title+year, creates media item and links library rows", async () => {
    const handle = createDatabase(":memory:");
    const now = new Date().toISOString();
    const root = handle.db
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
    handle.db
      .insert(libraryItems)
      .values({
        mediaRootId: root.id,
        mediaItemId: null,
        relativePath: "宝贝计划/宝贝计划.strm",
        sourceTitle: "宝贝计划",
        sourceYear: 2006,
        posterPath: "宝贝计划/poster.jpg",
        tags: ["2160p"],
        confidence: null,
        recognitionStatus: "unresolved",
        createdAt: now,
        updatedAt: now,
      })
      .run();

    const tmdb = tmdbMock([
      {
        id: 123,
        mediaType: "movie",
        title: "宝贝计划",
        originalTitle: "Rob-B-Hood",
        releaseYear: 2006,
        overview: "一部喜剧动作片",
        posterUrl: "https://image.tmdb.org/t/p/w500/robot.jpg",
        backdropUrl: null,
        genres: ["喜剧", "动作"],
        status: "Released",
        voteAverage: 7.1,
      },
    ]);

    const result = await matchUnresolvedToTmdb(handle.db, tmdb, { limit: 10 });
    expect(result.matchedGroups).toBe(1);
    expect(result.createdMediaItems).toBe(1);
    expect(result.linkedLibraryItems).toBe(1);

    const linked = handle.db.select().from(libraryItems).get();
    expect(linked?.mediaItemId).not.toBeNull();
    expect(linked?.recognitionStatus).toBe("matched");
    const media = handle.db.select().from(mediaItems).get();
    expect(media?.title).toBe("宝贝计划");
    expect(media?.tmdbId).toBe(123);
    handle.close();
  });

  it("skips candidates when the title/year do not agree", async () => {
    const handle = createDatabase(":memory:");
    const now = new Date().toISOString();
    const root = handle.db
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
    handle.db
      .insert(libraryItems)
      .values({
        mediaRootId: root.id,
        mediaItemId: null,
        relativePath: "某个片/某个片.strm",
        sourceTitle: "某个片",
        sourceYear: 2020,
        tags: [],
        confidence: null,
        recognitionStatus: "unresolved",
        createdAt: now,
        updatedAt: now,
      })
      .run();

    const tmdb = tmdbMock([
      {
        id: 999,
        mediaType: "movie",
        title: "另一个片",
        originalTitle: "Other",
        releaseYear: 2018,
        overview: "",
        posterUrl: null,
        backdropUrl: null,
        genres: [],
        status: null,
        voteAverage: null,
      },
    ]);

    const result = await matchUnresolvedToTmdb(handle.db, tmdb, { limit: 10 });
    expect(result.matchedGroups).toBe(0);
    expect(result.failedGroups).toBe(1);
    expect(handle.db.select().from(mediaItems).all()).toHaveLength(0);
    handle.close();
  });

  it("matches translated title variants like 大家的故事/我们的故事 when year agrees", async () => {
    const handle = createDatabase(":memory:");
    const now = new Date().toISOString();
    const root = handle.db
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
    handle.db
      .insert(libraryItems)
      .values({
        mediaRootId: root.id,
        mediaItemId: null,
        relativePath: "宝可梦：大家的故事 (2018)/movie.strm",
        sourceTitle: "宝可梦：大家的故事",
        sourceYear: 2018,
        tags: [],
        confidence: null,
        recognitionStatus: "unresolved",
        createdAt: now,
        updatedAt: now,
      })
      .run();

    const tmdb = tmdbMock([
      {
        id: 555,
        mediaType: "movie",
        title: "宝可梦剧场版：我们的故事",
        originalTitle: "Pokémon the Movie: The Power of Us",
        releaseYear: 2018,
        overview: "",
        posterUrl: null,
        backdropUrl: null,
        genres: ["动画"],
        status: "Released",
        voteAverage: 7.0,
      },
    ]);

    const result = await matchUnresolvedToTmdb(handle.db, tmdb, { limit: 10 });
    expect(result.matchedGroups).toBe(1);
    const media = handle.db.select().from(mediaItems).get();
    expect(media?.tmdbId).toBe(555);
    handle.close();
  });

  it("cleans orphan media items but keeps items referenced by files or tasks", async () => {
    const handle = createDatabase(":memory:");
    const now = new Date().toISOString();
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    const root = handle.db
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

    const used = handle.db
      .insert(mediaItems)
      .values({
        tmdbId: 1,
        mediaType: "movie",
        title: "已关联电影",
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
    const orphan = handle.db
      .insert(mediaItems)
      .values({
        tmdbId: 2,
        mediaType: "movie",
        title: "孤儿电影",
        aliases: [],
        genres: [],
        languages: [],
        regions: [],
        platforms: [],
        externalIds: {},
        tmdbPayload: {},
        createdAt: old,
        updatedAt: old,
      })
      .returning({ id: mediaItems.id })
      .get();
    handle.db.insert(mediaAliases).values({ itemId: orphan.id, name: "别名", createdAt: now }).run();
    handle.db
      .insert(libraryItems)
      .values({
        mediaRootId: root.id,
        mediaItemId: used.id,
        relativePath: "used/used.strm",
        sourceTitle: "已关联电影",
        tags: [],
        confidence: 0.95,
        recognitionStatus: "matched",
        createdAt: now,
        updatedAt: now,
      })
      .run();

    const deleted = cleanupOrphanMediaItems(handle.db, { limit: 10 });
    expect(deleted).toBe(1);
    expect(
      handle.db
        .select()
        .from(mediaItems)
        .all()
        .map((item) => item.id),
    ).toEqual([used.id]);
    expect(handle.db.select().from(mediaAliases).all()).toHaveLength(0);
    handle.close();
  });
});
