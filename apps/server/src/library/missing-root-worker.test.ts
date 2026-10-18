import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import BetterSqlite3 from "better-sqlite3";
import { build } from "esbuild";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDatabase, type DatabaseHandle } from "@emby-task-center/database/client";
import {
  libraryEpisodes,
  libraryItems,
  mediaItems,
  mediaRoots,
  missingEpisodeSnapshots,
} from "@emby-task-center/database/schema";
import { createMissingRootReader } from "./missing-root-reader";
import { missingEpisodeRoots, readRootMissingEpisodes, type MissingEpisodeRoot } from "./missing-root-scope";

const repo = fileURLToPath(new URL("../../../../", import.meta.url));
const now = new Date(2026, 9, 18);
const timestamp = "2026-01-01T00:00:00.000Z";

describe("readonly missing-root worker", () => {
  let directory: string;
  let workerUrl: URL;
  let database: DatabaseHandle;
  let reader: ReturnType<typeof createMissingRootReader>;
  let roots: MissingEpisodeRoot[];
  let inventoryId: number;

  beforeAll(async () => {
    directory = mkdtempSync(join(repo, ".local/missing-root-worker-test-"));
    const manifest = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
    const path = join(directory, "missing-root-worker.mjs");
    await build({
      entryPoints: [join(repo, "apps/server/src/library/missing-root-worker.ts")],
      outfile: path,
      bundle: true,
      platform: "node",
      target: "node24",
      format: "esm",
      logLevel: "silent",
      external: Object.keys(manifest.dependencies).filter((name) => !name.startsWith("@emby-task-center/")),
    });
    workerUrl = pathToFileURL(path);
  });
  beforeEach(() => {
    database = createDatabase(join(directory, `${crypto.randomUUID()}.sqlite`));
    for (let id = 1; id <= 2; id++) {
      database.db
        .insert(mediaRoots)
        .values({
          id,
          name: `库 ${id}`,
          mediaType: "tv",
          containerPath: `emby:upstream-${id}`,
          enabled: true,
          createdAt: timestamp,
          updatedAt: timestamp,
        })
        .run();
    }
    database.db
      .insert(mediaItems)
      .values({ id: 1, title: "测试剧", mediaType: "tv", tmdbId: 10, createdAt: timestamp, updatedAt: timestamp })
      .run();
    for (const rootId of [1, 2]) {
      const inventory = database.db
        .insert(libraryItems)
        .values({
          mediaRootId: rootId,
          mediaItemId: 1,
          relativePath: `剧集/${rootId}.strm`,
          createdAt: timestamp,
          updatedAt: timestamp,
        })
        .returning()
        .get();
      if (rootId === 1) inventoryId = inventory.id;
      for (const episodeNumber of rootId === 1 ? [1] : [1, 2]) {
        database.db
          .insert(libraryEpisodes)
          .values({ libraryItemId: inventory.id, parsedSeason: 1, episodeNumber, createdAt: timestamp })
          .run();
      }
    }
    database.db
      .insert(missingEpisodeSnapshots)
      .values({
        mediaItemId: 1,
        tmdbId: 10,
        title: "测试剧",
        fetchedAt: timestamp,
        scannedAt: timestamp,
        tmdbSeasons: [
          {
            seasonNumber: 1,
            episodes: [1, 2, 3].map((episodeNumber) => ({ episodeNumber, name: null, airDate: "2020-01-01" })),
          },
        ],
        missing: [],
        unmatchedSeasons: [],
        airedCount: 3,
        storedCount: 1,
        missingCount: 2,
      })
      .run();
    roots = missingEpisodeRoots(database.db);
    reader = createMissingRootReader(database.db, workerUrl);
  });
  afterEach(async () => {
    await reader.close();
    database.close();
    vi.restoreAllMocks();
  });
  afterAll(() => {
    if (!resolve(directory).startsWith(resolve(repo, ".local") + sep)) throw new Error("unexpected_test_cleanup_path");
    rmSync(directory, { recursive: true, force: true });
  });

  it("matches direct results per root and yields the main event loop while initializing", async () => {
    let heartbeat = false;
    const tick = new Promise<void>((done) =>
      setTimeout(() => {
        heartbeat = true;
        done();
      }, 0),
    );
    const result = await reader.read(roots[0]!, { now });
    expect(heartbeat).toBe(true);
    await tick;
    expect(result).toEqual(readRootMissingEpisodes(database.db, roots[0]!, { now }));
    expect(result[0]).toMatchObject({ missingCount: 2, storedProgress: 1 });
    expect((await reader.read(roots[1]!, { now }))[0]).toMatchObject({ missingCount: 1, storedProgress: 2 });
  });

  it("merges identical in-flight reads but never reuses a result across changes, roots or options", async () => {
    const first = reader.read(roots[0]!, { now });
    expect(reader.read(roots[0]!, { now })).toBe(first);
    const peer = new BetterSqlite3((database.db as unknown as { $client: BetterSqlite3.Database }).$client.name);
    try {
      peer
        .prepare(
          "INSERT INTO library_episodes (library_item_id, parsed_season, episode_number, created_at) VALUES (?, 1, 2, ?)",
        )
        .run(inventoryId, timestamp);
    } finally {
      peer.close();
    }
    const changed = reader.read(roots[0]!, { now });
    const otherRoot = reader.read(roots[1]!, { now });
    const otherOptions = reader.read(roots[0]!, { now, mediaItemIds: [] });
    expect(changed).not.toBe(first);
    expect(otherRoot).not.toBe(changed);
    expect(otherOptions).not.toBe(changed);
    const [, after, other, empty] = await Promise.all([first, changed, otherRoot, otherOptions]);
    expect(after[0]).toMatchObject({ missingCount: 1, storedProgress: 2 });
    expect(other[0]?.libraries[0]?.rootId).toBe(roots[1]!.rootId);
    expect(empty).toEqual([]);
    expect(await reader.read(roots[0]!, { now })).toEqual(after);
  });

  it("reads no unrelated snapshots and rejects a root disabled after it was selected", async () => {
    database.db
      .insert(mediaItems)
      .values({ id: 2, title: "其他库", mediaType: "tv", tmdbId: 20, createdAt: timestamp, updatedAt: timestamp })
      .run();
    database.db
      .insert(libraryItems)
      .values({
        mediaRootId: 2,
        mediaItemId: 2,
        relativePath: "Other.strm",
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .run();
    database.db
      .insert(missingEpisodeSnapshots)
      .values({
        mediaItemId: 2,
        tmdbId: 20,
        title: "其他库",
        fetchedAt: timestamp,
        scannedAt: timestamp,
        tmdbSeasons: [],
        missing: [],
        unmatchedSeasons: [],
        airedCount: 0,
        storedCount: 0,
        missingCount: 0,
      })
      .run();
    const raw = (database.db as unknown as { $client: BetterSqlite3.Database }).$client;
    raw
      .prepare("UPDATE missing_episode_snapshots SET tmdb_seasons_json = 'invalid-json' WHERE media_item_id = 2")
      .run();
    expect(await reader.read(roots[0]!, { now })).toHaveLength(1);
    raw.prepare("UPDATE media_roots SET enabled = 0 WHERE id = 1").run();
    await expect(reader.read(roots[0]!, { now })).rejects.toThrow("missing_root_changed");
  });

  it("rejects a crashed worker request, then recreates the worker for a later read", async () => {
    await reader.close();
    const broken = join(directory, `${crypto.randomUUID()}.mjs`);
    writeFileSync(broken, "throw new Error('fixture_root_worker_failure');");
    reader = createMissingRootReader(database.db, pathToFileURL(broken));
    await expect(reader.read(roots[0]!, { now })).rejects.toThrow("fixture_root_worker_failure");
    writeFileSync(broken, readFileSync(workerUrl));
    expect((await reader.read(roots[0]!, { now }))[0]?.missingCount).toBe(2);
  });

  it("terminates the worker, rejects pending reads and prevents reopening after close", async () => {
    const terminate = vi.spyOn(Worker.prototype, "terminate");
    const result = reader.read(roots[0]!, { now });
    const rejected = expect(result).rejects.toThrow("missing_root_reader_closed");
    await Promise.all([reader.close(), reader.close()]);
    await rejected;
    expect(terminate).toHaveBeenCalledTimes(1);
    await expect(reader.read(roots[0]!, { now })).rejects.toThrow("missing_root_reader_closed");
  });

  it("closes a live worker when its database has already closed", async () => {
    const terminate = vi.spyOn(Worker.prototype, "terminate");
    const result = reader.read(roots[0]!, { now });
    const rejected = expect(result).rejects.toThrow("missing_root_reader_closed");
    database.close();
    await expect(reader.read(roots[0]!, { now })).rejects.toThrow("missing_root_database_closed");
    await rejected;
    expect(terminate).toHaveBeenCalledTimes(1);
  });

  it("falls back without a compiled worker and still obeys explicit close", async () => {
    await reader.close();
    reader = createMissingRootReader(database.db, pathToFileURL(join(directory, "not-built.mjs")));
    expect(await reader.read(roots[0]!, { now })).toEqual(readRootMissingEpisodes(database.db, roots[0]!, { now }));
    const pending = reader.read(roots[0]!, { now });
    const rejected = expect(pending).rejects.toThrow("missing_root_reader_closed");
    await reader.close();
    await rejected;
  });

  it("does not merge across changes made by its own database connection", async () => {
    const first = reader.read(roots[0]!, { now });
    database.db
      .insert(libraryEpisodes)
      .values({ libraryItemId: inventoryId, parsedSeason: 1, episodeNumber: 2, createdAt: timestamp })
      .run();
    const changed = reader.read(roots[0]!, { now });
    expect(changed).not.toBe(first);
    await first;
    expect((await changed)[0]?.storedProgress).toBe(2);
  });

  it("uses the direct fallback for memory databases even when the worker bundle exists", async () => {
    const memory = createDatabase(":memory:");
    memory.db
      .insert(mediaRoots)
      .values({
        id: 1,
        name: "内存库",
        mediaType: "tv",
        containerPath: "emby:memory",
        enabled: true,
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .run();
    const direct = createMissingRootReader(memory.db, workerUrl);
    try {
      expect(await direct.read(missingEpisodeRoots(memory.db)[0]!, { now })).toEqual([]);
    } finally {
      await direct.close();
      memory.close();
    }
  });
});
