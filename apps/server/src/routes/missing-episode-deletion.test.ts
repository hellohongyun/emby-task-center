import express from "express";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { request as httpRequest, type Server } from "node:http";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDatabase, type DatabaseHandle } from "@emby-task-center/database/client";
import {
  auditLogs,
  libraryEpisodes,
  libraryItems,
  mediaItems,
  mediaRoots,
  missingEpisodeSnapshots,
} from "@emby-task-center/database/schema";
import { registerMissingEpisodeDeletion } from "./missing-episode-deletion";
import type { EmbyClient } from "../integrations/emby-client";
import type { MissingEpisodeScanner } from "../library/missing-episode-scan";
import { createLibraryService, type LibraryService } from "../library/service";
import { createWorkSummaryStore } from "../library/work-summaries";

describe("selected-library deletion boundary", () => {
  let directory: string;
  let database: DatabaseHandle;
  let server: Server;
  let url: string;
  let rootId: number;
  let otherRootId: number;
  let mediaItemId: number;
  let library: LibraryService;
  const listLibraryItems = vi.fn();
  const deleteItem = vi.fn();
  const searchItems = vi.fn();
  const scan = vi.fn();
  const timestamp = "2026-01-01T00:00:00.000Z";
  beforeEach(async () => {
    vi.clearAllMocks();
    directory = mkdtempSync(join(tmpdir(), "scoped-delete-"));
    database = createDatabase(join(directory, "app.sqlite"));
    rootId = database.db
      .insert(mediaRoots)
      .values({
        name: "动漫",
        containerPath: "emby:anime",
        mediaType: "tv",
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .returning()
      .get()!.id;
    otherRootId = database.db
      .insert(mediaRoots)
      .values({ name: "剧集", containerPath: "emby:tv", mediaType: "tv", createdAt: timestamp, updatedAt: timestamp })
      .returning()
      .get()!.id;
    mediaItemId = database.db
      .insert(mediaItems)
      .values({ title: "暗黑", mediaType: "tv", tmdbId: 202, createdAt: timestamp, updatedAt: timestamp })
      .returning()
      .get()!.id;
    seedInventory(rootId, "anime-ep");
    seedInventory(otherRootId, "tv-ep");
    database.db
      .insert(missingEpisodeSnapshots)
      .values({
        mediaItemId,
        tmdbId: 202,
        title: "暗黑",
        fetchedAt: timestamp,
        tmdbSeasons: [
          {
            seasonNumber: 1,
            episodes: [
              { episodeNumber: 1, name: "开端", airDate: "2020-01-01" },
              { episodeNumber: 2, name: "谎言", airDate: "2020-01-08" },
            ],
          },
        ],
        missing: [],
        unmatchedSeasons: [],
        airedCount: 2,
        storedCount: 1,
        missingCount: 1,
        scannedAt: timestamp,
      })
      .run();
    listLibraryItems.mockImplementation(async ({ libraryId }: { libraryId: string }) => [
      { id: `${libraryId}-series`, type: "tv", tmdbId: 202 },
    ]);
    deleteItem.mockResolvedValue(undefined);
    scan.mockResolvedValue(undefined);
    const app = express();
    app.use(express.json());
    library = createLibraryService(
      [
        { id: "anime", name: "动漫", path: "emby:anime", mediaType: "tv" },
        { id: "tv", name: "剧集", path: "emby:tv", mediaType: "tv" },
      ],
      undefined,
      database.db,
    );
    registerMissingEpisodeDeletion(app, {
      database: database.db,
      library,
      emby: {
        configured: true,
        listItemEpisodes: vi.fn().mockResolvedValue([{ id: "e1", seasonNumber: 1, episodeNumber: 1, name: "开端" }]),
        listLibraryItems,
        deleteItem,
        searchItems,
      } as unknown as EmbyClient,
      scanner: { run: scan } as unknown as MissingEpisodeScanner,
    });
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/missing-episodes/delete`;
  });
  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });
  function seedInventory(id: number, episode: string) {
    const row = database.db
      .insert(libraryItems)
      .values({
        mediaRootId: id,
        mediaItemId,
        embyItemId: episode,
        relativePath: `${episode}.strm`,
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .returning()
      .get()!;
    database.db
      .insert(libraryEpisodes)
      .values({
        libraryItemId: row.id,
        parsedSeason: 1,
        episodeNumber: 1,
        numberingMode: "seasonal",
        createdAt: timestamp,
      })
      .run();
  }
  function post(body: unknown) {
    // Each fixture owns a fresh socket; a closed previous server's pooled connection must not be reused.
    return new Promise<Response>((resolve, reject) => {
      const request = httpRequest(
        url,
        { method: "POST", agent: false, headers: { "content-type": "application/json" } },
        (incoming) => {
          const chunks: Buffer[] = [];
          incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
          incoming.once("error", reject);
          incoming.once("end", () =>
            resolve(new Response(Buffer.concat(chunks).toString(), { status: incoming.statusCode })),
          );
        },
      );
      request.once("error", reject);
      request.end(JSON.stringify(body));
    });
  }
  it("deletes only the selected root and preserves the other copy, episodes and shared snapshot", async () => {
    const summaries = createWorkSummaryStore(database.db);
    const selectedRoot = library.listRoots().find((root) => root.id === "anime")!;
    const otherRoot = library.listRoots().find((root) => root.id === "tv")!;
    expect(library.getInventory("anime")?.items).toHaveLength(1);
    const otherPayload = library.getInventoryPayload("tv");
    expect(summaries.get(selectedRoot)?.summary.totalFiles).toBe(1);
    expect(summaries.get(otherRoot)?.summary.totalFiles).toBe(1);
    const untouchedAt = database.db.select().from(mediaRoots).where(eq(mediaRoots.id, otherRootId)).get()!.updatedAt;
    const response = await post({ rootId: "anime", mediaItemIds: [mediaItemId] });
    expect(await response.json()).toMatchObject({ deleted: 1, failed: 0 });
    expect(listLibraryItems).toHaveBeenCalledWith({ libraryId: "anime", mediaType: "tv" });
    expect(deleteItem.mock.calls).toEqual([["anime-series"]]);
    expect(searchItems).not.toHaveBeenCalled();
    expect(database.db.select().from(libraryItems).all()).toMatchObject([
      { mediaRootId: otherRootId, embyItemId: "tv-ep" },
    ]);
    expect(database.db.select().from(libraryEpisodes).all()).toHaveLength(1);
    expect(database.db.select().from(missingEpisodeSnapshots).all()).toHaveLength(1);
    expect(JSON.parse(database.db.select().from(auditLogs).get()!.before!)).toMatchObject({ rootId, rootName: "动漫" });
    expect(scan).toHaveBeenCalledWith("manual");
    expect(library.getInventory("anime")?.items).toHaveLength(0);
    expect(library.getInventoryPayload("tv")).toBe(otherPayload);
    expect(summaries.get(selectedRoot)?.summary.totalFiles).toBe(0);
    expect(summaries.get(otherRoot)?.summary.totalFiles).toBe(1);
    expect(database.db.select().from(mediaRoots).where(eq(mediaRoots.id, otherRootId)).get()!.updatedAt).toBe(
      untouchedAt,
    );
  });
  it.each([undefined, "", "1", "1.2", "0", "9007199254740992", "999"])(
    "rejects a missing or invalid root %s before contacting Emby",
    async (id) => {
      expect((await post({ rootId: id, mediaItemIds: [mediaItemId] })).status).toBe(400);
      expect(listLibraryItems).not.toHaveBeenCalled();
      expect(deleteItem).not.toHaveBeenCalled();
    },
  );
  it("rejects a disabled library", async () => {
    database.db.update(mediaRoots).set({ enabled: false }).where(eq(mediaRoots.id, rootId)).run();
    expect((await post({ rootId: "anime", mediaItemIds: [mediaItemId] })).status).toBe(400);
    expect(deleteItem).not.toHaveBeenCalled();
  });
  it("rejects works without inventory in the requested library", async () => {
    const _extra = database.db
      .insert(mediaRoots)
      .values({
        name: "空库",
        containerPath: "emby:empty",
        mediaType: "tv",
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .returning()
      .get()!;
    const response = await post({ rootId: "empty", mediaItemIds: [mediaItemId] });
    expect(await response.json()).toMatchObject({ deleted: 0, results: [{ error: "outside_media_root" }] });
    expect(deleteItem).not.toHaveBeenCalled();
    database.db.delete(libraryEpisodes).run();
    database.db.delete(libraryItems).where(eq(libraryItems.mediaItemId, mediaItemId)).run();
    expect(await (await post({ rootId: "anime", mediaItemIds: [mediaItemId] })).json()).toMatchObject({
      deleted: 0,
      results: [{ error: "outside_media_root" }],
    });
  });
  it("keeps local rows when pagination fails or Emby deletion fails", async () => {
    listLibraryItems.mockRejectedValueOnce(new Error("emby_pagination_truncated"));
    expect((await post({ rootId: "anime", mediaItemIds: [mediaItemId] })).status).toBe(502);
    expect(deleteItem).not.toHaveBeenCalled();
    deleteItem.mockRejectedValueOnce(new Error("offline"));
    expect(await (await post({ rootId: "anime", mediaItemIds: [mediaItemId] })).json()).toMatchObject({
      deleted: 0,
      results: [{ error: "emby_delete_failed" }],
    });
    expect(database.db.select().from(libraryItems).all()).toHaveLength(2);
    expect(database.db.select().from(missingEpisodeSnapshots).all()).toHaveLength(1);
  });

  it("does not delete a show that now has no missing episodes", async () => {
    database.db
      .update(missingEpisodeSnapshots)
      .set({
        tmdbSeasons: [{ seasonNumber: 1, episodes: [{ episodeNumber: 1, name: "开端", airDate: "2020-01-01" }] }],
      })
      .run();
    expect(await (await post({ rootId: "anime", mediaItemIds: [mediaItemId] })).json()).toMatchObject({
      deleted: 0,
      results: [{ error: "no_missing_episodes" }],
    });
    expect(deleteItem).not.toHaveBeenCalled();
  });

  it("clears the shared snapshot after the last root copy is deleted", async () => {
    await post({ rootId: "anime", mediaItemIds: [mediaItemId] });
    await post({ rootId: "tv", mediaItemIds: [mediaItemId] });
    expect(deleteItem.mock.calls).toEqual([["anime-series"], ["tv-series"]]);
    expect(database.db.select().from(libraryItems).all()).toHaveLength(0);
    expect(database.db.select().from(libraryEpisodes).all()).toHaveLength(0);
    expect(database.db.select().from(missingEpisodeSnapshots).all()).toHaveLength(0);
  });

  it("audits partial deletion without clearing another root or claiming full success", async () => {
    listLibraryItems.mockResolvedValueOnce([
      { id: "anime-a", type: "tv", tmdbId: 202 },
      { id: "anime-b", type: "tv", tmdbId: 202 },
    ]);
    deleteItem.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("offline"));
    expect(await (await post({ rootId: "anime", mediaItemIds: [mediaItemId] })).json()).toMatchObject({
      deleted: 0,
      failed: 1,
      results: [{ embyItemIds: ["anime-a"], error: "emby_delete_failed" }],
    });
    expect(database.db.select().from(libraryItems).all()).toHaveLength(2);
    expect(database.db.select().from(libraryEpisodes).all()).toHaveLength(2);
    expect(database.db.select().from(auditLogs).get()).toMatchObject({ action: "missing_episode.delete_partial" });
    expect(scan).toHaveBeenCalledWith("manual");
  });
});
