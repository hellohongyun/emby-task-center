import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDatabase, type DatabaseHandle } from "@emby-task-center/database/client";
import { libraryEpisodes, libraryItems, libraryScanRuns } from "@emby-task-center/database/schema";
import { synchronizeRoots } from "./root-state";
import { createScanWriter } from "./scan-writer";
import { createLibraryService, type LibraryRootConfig, type LibraryService } from "./service";
import type { ScannedMediaItem } from "./scan-types";

const repo = fileURLToPath(new URL("../../../../", import.meta.url));
const root: LibraryRootConfig = { id: "fixture", name: "测试库", mediaType: "tv", path: "emby:fixture" };
const startedAt = "2026-09-30T00:00:00.000Z";
const items: ScannedMediaItem[] = [
  {
    relativePath: "Fixture/Season 01/Fixture S01E01.strm",
    embyItemId: "fixture-episode",
    tmdbId: 70523,
    sourceTitleHint: "Fixture",
    sourceYearHint: 2017,
    identity: {
      physicalSeason: 1,
      parsedSeason: 1,
      numberingMode: "seasonal",
      episodeNumbers: [1],
      absoluteEpisodeNumbers: [],
      warning: null,
    },
  },
];

describe("scan persistence worker", () => {
  let directory: string;
  let workerUrl: URL;
  let databasePath: string;
  let database: DatabaseHandle;
  let writer: ReturnType<typeof createScanWriter>;
  let service: LibraryService | undefined;

  beforeAll(async () => {
    const scratch = join(repo, ".local");
    mkdirSync(scratch, { recursive: true });
    directory = mkdtempSync(join(scratch, "scan-writer-test-"));
    const workerPath = join(directory, "scan-worker.mjs");
    const manifest = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    // 构建当前源码，避免依赖过期 dist；产物留在仓库下以解析原生 node_modules 依赖。
    await build({
      entryPoints: [join(repo, "apps/server/src/library/scan-worker.ts")],
      outfile: workerPath,
      bundle: true,
      platform: "node",
      target: "node24",
      format: "esm",
      logLevel: "silent",
      external: Object.keys(manifest.dependencies).filter((name) => !name.startsWith("@emby-task-center/")),
    });
    workerUrl = pathToFileURL(workerPath);
  });

  beforeEach(() => {
    databasePath = join(directory, `${crypto.randomUUID()}.sqlite`);
    database = createDatabase(databasePath);
    synchronizeRoots(database.db, [root]);
    writer = createScanWriter(databasePath, workerUrl);
  });

  afterEach(async () => {
    await service?.close?.();
    service = undefined;
    await writer.close();
    database.close();
  });

  afterAll(() => {
    const expectedParent = resolve(repo, ".local") + sep;
    if (!resolve(directory).startsWith(expectedParent)) throw new Error("unexpected_test_cleanup_path");
    rmSync(directory, { recursive: true, force: true });
  });

  it("persists actual inventory through the worker and keeps unchanged episode rows", async () => {
    await writer.persist(root, items, startedAt, [root]);
    const item = database.db.select().from(libraryItems).get();
    const episode = database.db.select().from(libraryEpisodes).get();
    expect(item).toMatchObject({ embyItemId: "fixture-episode", createdAt: startedAt, updatedAt: startedAt });
    expect(episode).toMatchObject({ libraryItemId: item!.id, episodeNumber: 1, createdAt: startedAt });
    await writer.persist(root, items, "2026-10-01T00:00:00.000Z", [root]);
    expect(database.db.select().from(libraryItems).get()).toEqual(item);
    expect(database.db.select().from(libraryEpisodes).get()).toEqual(episode);
    expect(database.db.select().from(libraryScanRuns).all()).toHaveLength(2);
  });

  it("propagates worker failures and accepts a later valid request", async () => {
    await expect(writer.persist({ ...root, path: "emby:missing-root" }, items, startedAt, [root])).rejects.toThrow(
      "Configured media root is not persisted",
    );
    expect(database.db.select().from(libraryItems).all()).toEqual([]);
    await expect(writer.persist(root, items, startedAt, [root])).resolves.toBeUndefined();
    expect(database.db.select().from(libraryItems).all()).toHaveLength(1);
  });

  it("passes the completeness boundary to the worker before removing unseen rows", async () => {
    const second = { ...items[0]!, embyItemId: "second", relativePath: "Fixture/Season 01/Fixture S01E02.strm" };
    await writer.persist(root, [...items, second], startedAt, [root], true);
    await writer.persist(root, items, startedAt, [root]);
    expect(database.db.select().from(libraryItems).all()).toHaveLength(2);
    await writer.persist(root, items, startedAt, [root], true);
    expect(database.db.select().from(libraryItems).all()).toHaveLength(1);
  });

  it("connects the file-backed library service to the real worker", async () => {
    service = createLibraryService([root], async () => items, database.db, { databasePath, workerUrl });
    await service.scanRoot(root.id);
    expect(service.getInventory(root.id)?.items).toHaveLength(1);
    expect(database.db.select().from(libraryEpisodes).get()?.episodeNumber).toBe(1);
  });

  it("rejects pending and future work on close and releases the worker for cleanup", async () => {
    const pending = writer.persist(root, items, startedAt, [root]);
    const rejected = expect(pending).rejects.toThrow("scan_writer_closed");
    await writer.close();
    await rejected;
    await expect(writer.persist(root, items, startedAt, [root])).rejects.toThrow("scan_writer_closed");
    await expect(writer.close()).resolves.toBeUndefined();
  });
});
