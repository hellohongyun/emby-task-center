import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDatabase, type DatabaseHandle } from "@emby-task-center/database/client";
import { mediaItems } from "@emby-task-center/database/schema";
import { checkDuplicate } from "./dedup";
import type { EmbyClient } from "../integrations/emby-client";

describe("pansou dedup", () => {
  let directory: string;
  let database: DatabaseHandle;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "emby-dedup-"));
    database = createDatabase(join(directory, "app.sqlite"));
  });

  afterEach(() => {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });

  function seedMovie(tmdbId: number, title: string, year: number) {
    const timestamp = new Date().toISOString();
    database.db
      .insert(mediaItems)
      .values({
        mediaType: "movie",
        title,
        releaseYear: year,
        tmdbId,
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .run();
  }

  it("detects duplicate via local STRM media library tmdbId", async () => {
    seedMovie(278, "肖申克的救赎", 1994);
    const result = await checkDuplicate({
      database: database.db,
      tmdbId: 278,
      title: "肖申克的救赎",
      year: 1994,
      mediaType: "movie",
    });
    expect(result.inLibrary).toBe(true);
    // Emby 不可达时回退本地库存；该库存现在由 Emby 同步而来，故来源标记为 library 而不是 strm
    expect(result.source).toBe("library");
  });

  it("detects duplicate by normalized title+year fallback", async () => {
    seedMovie(999, "肖申克的救赎", 1994);
    const result = await checkDuplicate({
      database: database.db,
      tmdbId: null,
      title: " 肖申克的救赎 ",
      year: 1994,
      mediaType: "movie",
    });
    expect(result.inLibrary).toBe(true);
  });

  it("uses Emby when configured and returns source=emby", async () => {
    const emby: EmbyClient = {
      configured: true,
      systemInfo: async () => ({ id: null, serverName: "t", version: "1" }),
      verify: async () => true,
      searchItems: async () => [{ id: "e1", name: "肖申克的救赎", year: 1994, type: "movie", tmdbId: 278 }],
    };
    const result = await checkDuplicate({
      database: database.db,
      emby,
      tmdbId: 278,
      title: "肖申克的救赎",
      year: 1994,
      mediaType: "movie",
    });
    expect(result.inLibrary).toBe(true);
    expect(result.source).toBe("emby");
  });

  it("returns not in library when nothing matches", async () => {
    const result = await checkDuplicate({
      database: database.db,
      tmdbId: 404,
      title: "不存在",
      year: 2000,
      mediaType: "movie",
    });
    expect(result.inLibrary).toBe(false);
    expect(result.source).toBeNull();
  });
});
