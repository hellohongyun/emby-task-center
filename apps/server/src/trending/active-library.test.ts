import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabase, type DatabaseHandle } from "@emby-task-center/database/client";
import { libraryItems, mediaItems, mediaRoots } from "@emby-task-center/database/schema";
import { registerPublicTrendingRoutes } from "./routes";
import type { TrendingService } from "./service";
import type { TrendingItem, TrendingResult } from "./types";

describe("trending availability uses enabled libraries", () => {
  let directory: string;
  let database: DatabaseHandle;
  let server: Server;
  let baseUrl: string;
  let activeRootId: number;
  let disabledRootId: number;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "trending-active-stock-"));
    database = createDatabase(join(directory, "app.sqlite"));
    const ts = new Date().toISOString();
    const media = database.db
      .insert(mediaItems)
      .values({
        mediaType: "movie",
        title: "正片名称",
        originalTitle: "Original Title",
        aliases: ["别名"],
        tmdbId: 42,
        doubanId: "13",
        releaseYear: 2020,
        createdAt: ts,
        updatedAt: ts,
      })
      .returning()
      .get();
    for (const enabled of [true, false]) {
      const root = database.db
        .insert(mediaRoots)
        .values({
          name: enabled ? "当前库" : "历史库",
          mediaType: "movie",
          containerPath: enabled ? "/active" : "/disabled",
          enabled,
          createdAt: ts,
          updatedAt: ts,
        })
        .returning()
        .get();
      if (enabled) activeRootId = root.id;
      else disabledRootId = root.id;
      database.db
        .insert(libraryItems)
        .values([
          {
            mediaRootId: root.id,
            mediaItemId: media.id,
            relativePath: "matched",
            sourceTitle: "正片名称",
            createdAt: ts,
            updatedAt: ts,
          },
          {
            mediaRootId: root.id,
            relativePath: "unresolved",
            sourceTitle: "未匹配名称",
            sourceYear: 2020,
            createdAt: ts,
            updatedAt: ts,
          },
        ])
        .run();
    }
    const titles = ["TMDB lookup", "Douban lookup", "正片名称", "Original Title", "别名", "未匹配名称"];
    const items: TrendingItem[] = titles.map((title, i) => ({
      id: String(i),
      title,
      year: 2020,
      mediaType: "movie",
      source: "tmdb",
      rank: i + 1,
      posterUrl: null,
      rating: null,
      ...(i === 0 ? { tmdbId: 42 } : {}),
      ...(i === 1 ? { externalUrl: "https://movie.douban.com/subject/13/" } : {}),
    }));
    const result: TrendingResult = {
      sections: [{ key: "tmdb_hot", source: "tmdb", label: "热门", items, updatedAt: 1, stale: false }],
      updatedAt: 1,
      degradedSources: [],
    };
    const service = { getSections: async () => result } as unknown as TrendingService;
    const app = express();
    registerPublicTrendingRoutes(app, { service, database: database.db, embyBaseUrl: "https://emby.example/" });
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });

  async function availability() {
    const response = await fetch(`${baseUrl}/api/public/trending`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as TrendingResult;
    return body.sections[0].items.map(({ inLibrary, watchUrl }) => ({ inLibrary, watchUrl }));
  }

  it("updates TMDB, Douban, titles, aliases and unresolved matches immediately on toggle", async () => {
    const available = Array.from({ length: 6 }, () => ({
      inLibrary: true,
      watchUrl: "https://emby.example/web/index.html",
    }));
    const unavailable = Array.from({ length: 6 }, () => ({ inLibrary: false, watchUrl: null }));
    expect(await availability()).toEqual(available);
    database.db.update(mediaRoots).set({ enabled: false }).where(eq(mediaRoots.id, activeRootId)).run();
    expect(await availability()).toEqual(unavailable);
    expect(database.db.select().from(libraryItems).all()).toHaveLength(4);
    database.db.update(mediaRoots).set({ enabled: true }).where(eq(mediaRoots.id, disabledRootId)).run();
    expect(await availability()).toEqual(available);
    expect(database.db.select().from(libraryItems).all()).toHaveLength(4);
  });
});
