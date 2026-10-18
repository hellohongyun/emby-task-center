import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { eq } from "drizzle-orm";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { createDatabase, type DatabaseHandle } from "@emby-task-center/database/client";
import {
  libraryEpisodes,
  libraryItems,
  mediaItems,
  mediaRoots,
  missingEpisodeSnapshots,
} from "@emby-task-center/database/schema";
import type { EmbyClient } from "../integrations/emby-client";
import type { MissingEpisodeScanner } from "../library/missing-episode-scan";
import type { MissingMetadataIssue } from "../library/missing-tmdb-cache";
import { registerMissingEpisodeRoutes } from "./missing-episodes";
const timestamp = "2026-01-01T00:00:00.000Z";
const episode = (episodeNumber: number) => ({ episodeNumber, name: `剧情 ${episodeNumber}`, airDate: "2020-01-01" });
describe("missing episode public-root contract", () => {
  let database: DatabaseHandle;
  let server: Server;
  let base: string;
  const listLibraryItems = vi.fn();
  const listItemEpisodes = vi.fn();
  const deleteItem = vi.fn();
  let metadataIssues: MissingMetadataIssue[];
  beforeEach(async () => {
    vi.resetAllMocks();
    database = createDatabase(":memory:");
    metadataIssues = [];
    for (const [name, publicId, enabled] of [
      ["A", "2", true],
      ["B", "88", true],
      ["旧库", "99", false],
    ] as const) {
      database.db
        .insert(mediaRoots)
        .values({
          name,
          containerPath: `emby:${publicId}`,
          enabled,
          mediaType: "tv",
          createdAt: timestamp,
          updatedAt: timestamp,
        })
        .run();
    }
    database.db
      .insert(mediaItems)
      .values({ id: 1, title: "同一部剧", tmdbId: 101, mediaType: "tv", createdAt: timestamp, updatedAt: timestamp })
      .run();
    seedInventory(1, 1);
    seedInventory(2, 2);
    seedInventory(3, 1);
    seedInventory(3, 2);
    database.db
      .insert(missingEpisodeSnapshots)
      .values({
        mediaItemId: 1,
        tmdbId: 101,
        title: "同一部剧",
        tmdbSeasons: [{ seasonNumber: 1, episodes: [episode(1), episode(2)] }],
        fetchedAt: timestamp,
        missing: [],
        missingCount: 0,
        airedCount: 2,
        storedCount: 2,
        unmatchedSeasons: [],
        scannedAt: timestamp,
        embySeriesId: "wrong-other-root",
        embySeasons: [{ seasonNumber: 1, id: "wrong-season" }],
      })
      .run();
    listLibraryItems.mockImplementation(async ({ libraryId }: { libraryId: string }) => [
      { id: `series-${libraryId}`, type: "tv", tmdbId: 101 },
    ]);
    listItemEpisodes.mockImplementation(async (id: string) => [
      { id: `${id}-ep`, seasonNumber: 1, episodeNumber: id === "series-2" ? 1 : 2, name: "开场" },
    ]);
    deleteItem.mockResolvedValue(undefined);
    const app = express();
    app.use(express.json());
    registerMissingEpisodeRoutes(app, {
      database: database.db,
      emby: { configured: true, listLibraryItems, listItemEpisodes, deleteItem } as unknown as EmbyClient,
      scanner: {
        status: () => ({ running: false, processed: 0, total: 1, metadataIssues }),
        run: vi.fn().mockResolvedValue(undefined),
      } as unknown as MissingEpisodeScanner,
    });
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/missing-episodes`;
  });
  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    database.close();
  });
  function seedInventory(rootId: number, number: number, season = 1, mediaItemId = 1) {
    const row = database.db
      .insert(libraryItems)
      .values({
        mediaRootId: rootId,
        mediaItemId,
        relativePath: `剧名 [series${rootId}]/Season ${season}/E${number}.strm`,
        embyItemId: `r${rootId}s${season}e${number}`,
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .returning()
      .get()!;
    database.db
      .insert(libraryEpisodes)
      .values({
        libraryItemId: row.id,
        parsedSeason: season,
        episodeNumber: number,
        numberingMode: "seasonal",
        createdAt: timestamp,
      })
      .run();
  }
  function read(rootId?: string) {
    return fetch(`${base}${rootId === undefined ? "" : `?rootId=${rootId}`}`);
  }
  function post(rootId: string) {
    return fetch(`${base}/delete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rootId, mediaItemIds: [1] }),
    });
  }
  it("computes complementary copies independently and defaults to an enabled root", async () => {
    const a = await (await read()).json();
    const b = await (await read("88")).json();
    expect(a).toMatchObject({
      rootId: "2",
      episodeCount: 1,
      showCount: 1,
      libraries: [
        { rootId: "2", name: "A" },
        { rootId: "88", name: "B" },
      ],
    });
    expect(a.shows[0]).toMatchObject({
      embySeriesId: null,
      seasons: [{ embySeasonId: null, episodes: [episode(2)] }],
    });
    expect(b).toMatchObject({ rootId: "88", episodeCount: 1, shows: [{ seasons: [{ episodes: [episode(1)] }] }] });
    expect(a.shows[0].libraries).toHaveLength(1);
    expect(b.shows[0].libraries[0].rootId).toBe("88");
    expect(listLibraryItems).not.toHaveBeenCalled();
    expect(listItemEpisodes).not.toHaveBeenCalled();
  });
  it("uses the GET public ID for deletion even if it collides with another local root ID", async () => {
    const view = await (await read()).json();
    const result = await (await post(view.libraries[0].rootId)).json();
    expect(result).toMatchObject({ rootId: "2", deleted: 1, failed: 0 });
    expect(listLibraryItems).toHaveBeenCalledWith({ libraryId: "2", mediaType: "tv" });
    expect(deleteItem.mock.calls).toEqual([["series-2"]]);
    expect(
      database.db
        .select()
        .from(libraryItems)
        .all()
        .map((item) => item.mediaRootId),
    ).toEqual([2, 3, 3]);
    expect(database.db.select().from(missingEpisodeSnapshots).all()).toHaveLength(1);
  });
  it.each(["1", "99", "absent"])("rejects local-only, disabled and unknown root %s", async (rootId) => {
    expect((await read(rootId)).status).toBe(400);
    expect((await post(rootId)).status).toBe(400);
    expect(listLibraryItems).not.toHaveBeenCalled();
    expect(deleteItem).not.toHaveBeenCalled();
  });
  it("keeps disabled inventory and history but returns no libraries when all are disabled", async () => {
    database.db.update(mediaRoots).set({ enabled: false }).run();
    expect(await (await read()).json()).toMatchObject({ rootId: null, libraries: [], shows: [], episodeCount: 0 });
    expect(database.db.select().from(libraryItems).all()).toHaveLength(4);
    expect(database.db.select().from(missingEpisodeSnapshots).all()).toHaveLength(1);
  });
  it("shows absent seasons as unmatched warnings without turning them into deletable gaps", async () => {
    database.db
      .update(missingEpisodeSnapshots)
      .set({
        tmdbSeasons: [
          { seasonNumber: 1, episodes: [episode(1)] },
          { seasonNumber: 2, episodes: [episode(1), episode(2)] },
        ],
      })
      .run();
    const body = await (await read()).json();
    expect(body).toMatchObject({
      showCount: 0,
      episodeCount: 0,
      pendingShowCount: 0,
      shows: [{ missingCount: 0, unmatchedSeasons: [{ seasonNumber: 2, airedEpisodes: 2 }] }],
    });
    expect(await (await post("2")).json()).toMatchObject({ deleted: 0, results: [{ error: "no_missing_episodes" }] });
    expect(deleteItem).not.toHaveBeenCalled();
  });
  it("keeps suspect-only works visible, without inheriting cross-root guards", async () => {
    for (let number = 2; number <= 10; number++) seedInventory(1, number);
    database.db
      .update(missingEpisodeSnapshots)
      .set({
        suspectSeasons: [{ seasonNumber: 2, aired: 100, stored: 10 }],
        tmdbSeasons: [{ seasonNumber: 1, episodes: Array.from({ length: 20 }, (_, i) => episode(i + 1)) }],
      })
      .run();
    expect(await (await read()).json()).toMatchObject({
      showCount: 0,
      episodeCount: 0,
      pendingShowCount: 0,
      shows: [{ missingCount: 0, suspectSeasons: [{ seasonNumber: 1, aired: 20, stored: 10 }] }],
    });
  });
  it("does not authorize stale merged-episode gaps after fresh Emby range validation", async () => {
    listItemEpisodes.mockResolvedValue([
      { id: "combined", seasonNumber: 1, episodeNumber: 1, episodeNumberEnd: 2, name: "合并集" },
    ]);
    expect((await (await read()).json()).episodeCount).toBe(1);
    expect(await (await post("2")).json()).toMatchObject({ deleted: 0, results: [{ error: "no_missing_episodes" }] });
    expect(deleteItem).not.toHaveBeenCalled();
  });
  it("applies episode name guards only to fresh root-scoped episodes before deletion", async () => {
    database.db
      .update(missingEpisodeSnapshots)
      .set({ tmdbSeasons: [{ seasonNumber: 1, episodes: [episode(1), episode(2), episode(3)] }] })
      .run();
    listItemEpisodes.mockResolvedValue([
      { id: "one", seasonNumber: 1, episodeNumber: 1, name: "开场" },
      { id: "two", seasonNumber: 2, episodeNumber: 1, name: "剧情 2" },
      { id: "three", seasonNumber: 2, episodeNumber: 2, name: "剧情 3" },
    ]);
    expect(await (await post("2")).json()).toMatchObject({ deleted: 0, results: [{ error: "no_missing_episodes" }] });
    expect(deleteItem).not.toHaveBeenCalled();
  });
  it("fails closed on incomplete episodes or unavailable TMDB seasons", async () => {
    listItemEpisodes.mockRejectedValueOnce(new Error("emby_pagination_truncated"));
    expect(await (await post("2")).json()).toMatchObject({
      deleted: 0,
      results: [{ error: "emby_episode_read_failed" }],
    });
    database.db
      .update(missingEpisodeSnapshots)
      .set({ tmdbSeasons: [{ seasonNumber: 1, episodes: [], unavailable: true }] })
      .run();
    expect(await (await post("2")).json()).toMatchObject({
      deleted: 0,
      results: [{ error: "missing_metadata_incomplete" }],
    });
    expect(deleteItem).not.toHaveBeenCalled();
  });
  it("filters metadata failures to the current root including works without display snapshots", async () => {
    database.db
      .insert(mediaItems)
      .values({ id: 2, title: "仅B失败", tmdbId: 102, mediaType: "tv", createdAt: timestamp, updatedAt: timestamp })
      .run();
    seedInventory(2, 1, 1, 2);
    metadataIssues = [
      {
        mediaItemId: 2,
        tmdbId: 102,
        title: "仅B失败",
        stale: true,
        error: "tmdb_unavailable",
        failedSeasons: [1],
        unavailableSeasons: [1],
        lastCompleteAt: null,
        expiresAt: null,
        attemptedAt: timestamp,
        retryAt: timestamp,
      },
    ];
    expect(await (await read("2")).json()).toMatchObject({ metadataIssueCount: 0, metadataIssues: [] });
    expect(await (await read("88")).json()).toMatchObject({
      metadataIssueCount: 1,
      shows: [
        expect.anything(),
        expect.objectContaining({ mediaItemId: 2, missingCount: 0, error: "metadata_incomplete" }),
      ],
    });
  });
  it("stops deletion if root ownership or TMDB binding changes during fresh episode reads", async () => {
    listItemEpisodes.mockImplementationOnce(async () => {
      database.db.update(mediaItems).set({ tmdbId: 999 }).where(eq(mediaItems.id, 1)).run();
      return [{ id: "one", seasonNumber: 1, episodeNumber: 1, name: "开场" }];
    });
    expect(await (await post("2")).json()).toMatchObject({ deleted: 0, results: [{ error: "media_item_changed" }] });
    expect(deleteItem).not.toHaveBeenCalled();
  });
});
