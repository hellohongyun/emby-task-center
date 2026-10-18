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
import { getRuntimeSettings } from "../settings/runtime";
import { registerMissingEpisodeRoutes } from "./missing-episodes";
const timestamp = "2026-01-01T00:00:00.000Z";
describe("root-safe Emby viewing links", () => {
  let database: DatabaseHandle;
  let server: Server;
  let base: string;
  let originalWeb: string;
  let originalKey: string;
  const listLibraryItems = vi.fn();
  const listSeasons = vi.fn();
  const searchItems = vi.fn();
  beforeEach(async () => {
    vi.resetAllMocks();
    const runtime = getRuntimeSettings();
    originalWeb = runtime.embyWebUrl;
    originalKey = runtime.embyApiKey;
    runtime.embyWebUrl = "https://emby.test";
    runtime.embyApiKey = "secret-that-must-never-appear-in-links";
    database = createDatabase(":memory:");
    for (const [name, id, enabled] of [
      ["A", "upstream-A", true],
      ["B", "upstream-B", true],
      ["停用", "old", false],
    ] as const) {
      const root = database.db
        .insert(mediaRoots)
        .values({
          name,
          containerPath: `emby:${id}`,
          mediaType: "tv",
          enabled,
          createdAt: timestamp,
          updatedAt: timestamp,
        })
        .returning()
        .get()!;
      if (!enabled) continue;
      const row = database.db
        .insert(libraryItems)
        .values({
          mediaRootId: root.id,
          mediaItemId: null,
          relativePath: `${name}/E1.strm`,
          createdAt: timestamp,
          updatedAt: timestamp,
        })
        .returning()
        .get()!;
      if (root.id === 1)
        database.db
          .insert(mediaItems)
          .values({ id: 1, title: "同一剧", mediaType: "tv", tmdbId: 101, createdAt: timestamp, updatedAt: timestamp })
          .run();
      database.db.update(libraryItems).set({ mediaItemId: 1 }).where(eq(libraryItems.id, row.id)).run();
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
    database.db
      .insert(missingEpisodeSnapshots)
      .values({
        mediaItemId: 1,
        tmdbId: 101,
        title: "同一剧",
        fetchedAt: timestamp,
        tmdbSeasons: [
          {
            seasonNumber: 1,
            episodes: [1, 2].map((episodeNumber) => ({ episodeNumber, name: null, airDate: "2020-01-01" })),
          },
        ],
        missing: [],
        unmatchedSeasons: [],
        missingCount: 0,
        airedCount: 2,
        storedCount: 1,
        scannedAt: timestamp,
        embySeriesId: "untrusted-global-series",
        embySeasons: [{ seasonNumber: 1, id: "untrusted-global-season" }],
      })
      .run();
    listLibraryItems.mockImplementation(async ({ libraryId }: { libraryId: string }) => [
      { id: `${libraryId}-series`, type: "tv", tmdbId: 101 },
      { id: "unrelated", type: "tv", tmdbId: 999 },
    ]);
    listSeasons.mockImplementation(async (id: string) => [{ id: `${id}-s1`, seasonNumber: 1, name: "第一季" }]);
    const app = express();
    registerMissingEpisodeRoutes(app, {
      database: database.db,
      emby: {
        configured: true,
        listLibraryItems,
        listSeasons,
        searchItems,
        systemInfo: vi.fn().mockResolvedValue({ id: "server-1" }),
      } as unknown as EmbyClient,
      scanner: {
        status: () => ({ running: false, processed: 0, total: 1 }),
        run: vi.fn(),
      } as unknown as MissingEpisodeScanner,
    });
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    database.close();
    getRuntimeSettings().embyWebUrl = originalWeb;
    getRuntimeSettings().embyApiKey = originalKey;
  });
  const resolver = (rootId = "upstream-A", seasonNumber?: number) =>
    `/api/missing-episodes/emby-link?rootId=${rootId}&mediaItemId=1${seasonNumber === undefined ? "" : `&seasonNumber=${seasonNumber}`}`;
  const read = (path: string) => fetch(`${base}${path}`, { redirect: "manual" });

  it("resolves a season URL returned by GET strictly inside the selected root", async () => {
    const payload = await (await read("/api/missing-episodes?rootId=upstream-A")).json();
    const show = payload.shows[0];
    expect(JSON.stringify(payload)).not.toContain("secret-that-must-never");
    expect(show.embyUrl).toBe(resolver());
    expect(show.seasons[0].embyUrl).toBe(resolver("upstream-A", 1));
    expect(listLibraryItems).not.toHaveBeenCalled();
    expect(listSeasons).not.toHaveBeenCalled();
    const response = await read(show.seasons[0].embyUrl);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain(
      "https://emby.test/web/index.html#!/item?id=upstream-A-series-s1",
    );
    expect(listLibraryItems).toHaveBeenCalledWith({ libraryId: "upstream-A", mediaType: "tv" });
    expect(listSeasons.mock.calls).toEqual([["upstream-A-series"]]);
    expect(searchItems).not.toHaveBeenCalled();
    expect(response.headers.get("location")).not.toContain("untrusted-global");
    expect(response.headers.get("location")).not.toContain("secret-that-must-never");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
  it("takes the same TMDB work from root B instead of reusing root A IDs", async () => {
    const response = await read(resolver("upstream-B", 1));
    expect(response.headers.get("location")).toContain("id=upstream-B-series-s1");
    expect(listSeasons.mock.calls).toEqual([["upstream-B-series"]]);
  });
  it("falls back to this root's series when the requested season is absent", async () => {
    listSeasons.mockResolvedValue([]);
    expect((await read(resolver("upstream-A", 5))).headers.get("location")).toContain("id=upstream-A-series");
  });
  it("does not request seasons for a series-level link", async () => {
    expect((await read(resolver())).status).toBe(302);
    expect(listSeasons).not.toHaveBeenCalled();
  });
  it.each(["old", "1", "unknown"])("rejects disabled or non-public root %s before contacting Emby", async (id) => {
    expect((await read(resolver(id, 1))).status).toBe(400);
    expect(listLibraryItems).not.toHaveBeenCalled();
  });
  it.each(["-1", "1.5", "oops", "9007199254740992"])("validates season %s", async (number) => {
    expect((await read(`${resolver()}&seasonNumber=${number}`)).status).toBe(400);
    expect(listLibraryItems).not.toHaveBeenCalled();
  });
  it("rejects a work not owned by the selected library", async () => {
    database.db.delete(libraryEpisodes).where(eq(libraryEpisodes.libraryItemId, 1)).run();
    database.db.delete(libraryItems).where(eq(libraryItems.mediaRootId, 1)).run();
    expect((await read(resolver())).status).toBe(404);
    expect(listLibraryItems).not.toHaveBeenCalled();
  });
  it("returns no link without a web URL and exposes no pasted credentials or query keys", async () => {
    getRuntimeSettings().embyWebUrl = "";
    const payload = await (await read("/api/missing-episodes")).json();
    expect(payload.shows[0].embyUrl).toBeNull();
    expect(payload.shows[0].seasons[0].embyUrl).toBeNull();
    expect((await read(resolver())).status).toBe(503);
    getRuntimeSettings().embyWebUrl =
      "https://user:password@emby.test/base/web/index.html?api_key=pasted-secret#token=other-secret";
    const response = await read(resolver());
    expect(response.status).toBe(302);
    const url = response.headers.get("location")!;
    expect(url).toContain("https://emby.test/base/web/index.html#!/item?id=upstream-A-series");
    for (const secret of ["password", "pasted-secret", "other-secret", "secret-that-must-never"])
      expect(url).not.toContain(secret);
  });
  it("reports upstream read errors and missing provider matches without redirecting", async () => {
    listLibraryItems.mockRejectedValueOnce(new Error("offline"));
    expect((await read(resolver())).status).toBe(502);
    listLibraryItems.mockResolvedValueOnce([{ id: "wrong-tmdb", type: "tv", tmdbId: 999 }]);
    const response = await read(resolver());
    expect(response.status).toBe(404);
    expect(response.headers.get("location")).toBeNull();
  });
  it("rejects root or binding changes during awaited lookups", async () => {
    listSeasons.mockImplementationOnce(async () => {
      database.db.update(mediaRoots).set({ enabled: false }).where(eq(mediaRoots.id, 1)).run();
      return [{ id: "root-A-season", seasonNumber: 1 }];
    });
    expect((await read(resolver("upstream-A", 1))).status).toBe(409);
  });
});
