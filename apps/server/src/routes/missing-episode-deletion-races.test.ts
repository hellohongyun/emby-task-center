import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDatabase, type DatabaseHandle } from "@emby-task-center/database/client";
import {
  auditLogs,
  libraryItems,
  mediaItems,
  mediaRoots,
  missingEpisodeSnapshots,
} from "@emby-task-center/database/schema";
import { registerMissingEpisodeDeletion } from "./missing-episode-deletion";
import type { EmbyClient } from "../integrations/emby-client";
import type { MissingEpisodeScanner } from "../library/missing-episode-scan";
import { getRuntimeSettings } from "../settings/runtime";

describe("deletion configuration revalidation", () => {
  let database: DatabaseHandle;
  let server: Server;
  let url: string;
  let originalAddress: string;
  const listLibraryItems = vi.fn();
  const deleteItem = vi.fn();
  const timestamp = "2026-01-01T00:00:00.000Z";
  beforeEach(async () => {
    vi.resetAllMocks();
    database = createDatabase(":memory:");
    database.db
      .insert(mediaRoots)
      .values({
        id: 1,
        name: "动漫",
        containerPath: "emby:anime",
        mediaType: "tv",
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .run();
    database.db
      .insert(mediaItems)
      .values({ id: 1, title: "暗黑", mediaType: "tv", tmdbId: 202, createdAt: timestamp, updatedAt: timestamp })
      .run();
    database.db
      .insert(libraryItems)
      .values({ mediaRootId: 1, mediaItemId: 1, relativePath: "e1.strm", createdAt: timestamp, updatedAt: timestamp })
      .run();
    database.db
      .insert(missingEpisodeSnapshots)
      .values({
        mediaItemId: 1,
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
    listLibraryItems.mockResolvedValue([{ id: "series-a", type: "tv", tmdbId: 202 }]);
    deleteItem.mockResolvedValue(undefined);
    originalAddress = getRuntimeSettings().embyBaseUrl;
    const app = express();
    app.use(express.json());
    registerMissingEpisodeDeletion(app, {
      database: database.db,
      emby: {
        configured: true,
        listItemEpisodes: vi.fn().mockResolvedValue([{ id: "e1", seasonNumber: 1, episodeNumber: 1, name: "开端" }]),
        listLibraryItems,
        deleteItem,
      } as unknown as EmbyClient,
      scanner: { run: vi.fn().mockResolvedValue(undefined) } as unknown as MissingEpisodeScanner,
    });
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/missing-episodes/delete`;
  });
  afterEach(async () => {
    getRuntimeSettings().embyBaseUrl = originalAddress;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    database.close();
  });
  function post() {
    return fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rootId: "anime", mediaItemIds: [1] }),
    });
  }

  it.each([{ enabled: false }, { containerPath: "emby:changed" }])(
    "rejects a root changed during the awaited library read: %s",
    async (change) => {
      listLibraryItems.mockImplementationOnce(async () => {
        database.db.update(mediaRoots).set(change).where(eq(mediaRoots.id, 1)).run();
        return [{ id: "series-a", type: "tv", tmdbId: 202 }];
      });
      const response = await post();
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: "media_root_changed" });
      expect(deleteItem).not.toHaveBeenCalled();
      expect(database.db.select().from(libraryItems).all()).toHaveLength(1);
    },
  );

  it("rejects an Emby connection change during the library read", async () => {
    listLibraryItems.mockImplementationOnce(async () => {
      getRuntimeSettings().embyBaseUrl = "https://changed.test";
      return [{ id: "series-a", type: "tv", tmdbId: 202 }];
    });
    const response = await post();
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "emby_connection_changed" });
    expect(deleteItem).not.toHaveBeenCalled();
  });

  it.each(["connection", "root"])(
    "stops subsequent deletes and audits a partial result if the %s changes",
    async (kind) => {
      listLibraryItems.mockResolvedValueOnce([
        { id: "series-a", type: "tv", tmdbId: 202 },
        { id: "series-b", type: "tv", tmdbId: 202 },
      ]);
      deleteItem.mockImplementationOnce(async () => {
        if (kind === "connection") getRuntimeSettings().embyBaseUrl = "https://changed.test";
        else database.db.update(mediaRoots).set({ enabled: false }).where(eq(mediaRoots.id, 1)).run();
      });
      expect(await (await post()).json()).toMatchObject({
        deleted: 0,
        failed: 1,
        results: [
          {
            embyItemIds: ["series-a"],
            error: kind === "connection" ? "emby_connection_changed" : "media_root_changed",
          },
        ],
      });
      expect(deleteItem.mock.calls).toEqual([["series-a"]]);
      expect(database.db.select().from(libraryItems).all()).toHaveLength(1);
      expect(database.db.select().from(auditLogs).get()).toMatchObject({ action: "missing_episode.delete_partial" });
    },
  );
});
