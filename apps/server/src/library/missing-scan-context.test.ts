import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDatabase, type DatabaseHandle } from "@emby-task-center/database/client";
import { libraryEpisodes, libraryItems, mediaItems, mediaRoots } from "@emby-task-center/database/schema";
import { createMissingScanContext } from "./missing-scan-context";
import { loadMissingScanData } from "./missing-scan-data";

const repo = fileURLToPath(new URL("../../../../", import.meta.url));
describe("missing scan worker context", () => {
  let directory: string;
  let workerUrl: URL;
  let handle: DatabaseHandle;
  let itemId: number;
  let context: Awaited<ReturnType<typeof createMissingScanContext>> | undefined;
  beforeAll(async () => {
    mkdirSync(join(repo, ".local"), { recursive: true });
    directory = mkdtempSync(join(repo, ".local/missing-scan-test-"));
    const manifest = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    const path = join(directory, "missing-scan-worker.mjs");
    await build({
      entryPoints: [join(repo, "apps/server/src/library/missing-scan-worker.ts")],
      outfile: path,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node24",
      logLevel: "silent",
      external: Object.keys(manifest.dependencies).filter((name) => !name.startsWith("@emby-task-center/")),
    });
    workerUrl = pathToFileURL(path);
  });
  beforeEach(() => {
    handle = createDatabase(join(directory, `${crypto.randomUUID()}.sqlite`));
    const now = "2026-01-01";
    const root = handle.db
      .insert(mediaRoots)
      .values({
        name: "历史剧集",
        containerPath: "emby:fixture",
        mediaType: "tv",
        enabled: false,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
    const item = handle.db
      .insert(mediaItems)
      .values({ title: "剧集", mediaType: "tv", tmdbId: 10, createdAt: now, updatedAt: now })
      .returning()
      .get();
    itemId = item.id;
    for (let copy = 0; copy < 2; copy++) {
      const inventory = handle.db
        .insert(libraryItems)
        .values({
          mediaRootId: root.id,
          mediaItemId: item.id,
          relativePath: `${copy}.strm`,
          sourceTitle: copy ? "B" : "A",
          createdAt: now,
          updatedAt: now,
        })
        .returning()
        .get();
      for (const episode of [0, 1, null]) {
        handle.db
          .insert(libraryEpisodes)
          .values({
            libraryItemId: inventory.id,
            parsedSeason: episode === 0 ? null : 1,
            episodeNumber: episode,
            absoluteEpisodeNumber: episode === null ? 99 : 100,
            createdAt: now,
          })
          .run();
      }
    }
    context = undefined;
  });
  afterEach(async () => {
    await context?.close();
    handle.close();
  });
  afterAll(() => {
    if (!resolve(directory).startsWith(resolve(repo, ".local") + sep)) throw new Error("unexpected_test_cleanup_path");
    rmSync(directory, { recursive: true, force: true });
  });
  it("matches direct grouping, preserves zero/absolute fallback and historical candidates, and yields during startup", async () => {
    let heartbeat = false;
    const tick = new Promise<void>((done) =>
      setTimeout(() => {
        heartbeat = true;
        done();
      }, 0),
    );
    context = await createMissingScanContext(handle.db, workerUrl);
    expect(heartbeat).toBe(true);
    await tick;
    const direct = loadMissingScanData(handle.db);
    expect(context.candidates).toEqual(direct.candidates);
    expect(await context.read(itemId)).toEqual(direct.read(itemId));
    expect((await context.read(itemId)).stored).toEqual(
      new Map([
        [0, new Set([0])],
        [1, new Set([1, 99])],
      ]),
    );
  });
  it("keeps an immutable snapshot after concurrent writes, while the next run observes them", async () => {
    context = await createMissingScanContext(handle.db, workerUrl);
    handle.db.update(mediaItems).set({ title: "新标题" }).where(eq(mediaItems.id, itemId)).run();
    handle.db.update(libraryEpisodes).set({ episodeNumber: 7 }).run();
    expect((await context.read(itemId)).stored.get(0)).toEqual(new Set([0]));
    expect(context.candidates[0]?.title).toBe("剧集");
    await context.close();
    context = await createMissingScanContext(handle.db, workerUrl);
    expect(context.candidates[0]?.title).toBe("新标题");
    expect((await context.read(itemId)).stored.get(0)).toEqual(new Set([7]));
  });
  it("rejects reads after close and permits repeated close", async () => {
    context = await createMissingScanContext(handle.db, workerUrl);
    const read = context.read(itemId);
    const rejected = expect(read).rejects.toThrow("missing_scan_context_closed");
    await context.close();
    await rejected;
    await expect(context.read(itemId)).rejects.toThrow("missing_scan_context_closed");
    await context.close();
  });
  it("reports worker initialization failures without leaking a pending request", async () => {
    const path = join(directory, "broken.mjs");
    writeFileSync(path, "throw new Error('fixture_missing_worker_failure');");
    await expect(createMissingScanContext(handle.db, pathToFileURL(path))).rejects.toThrow(
      "fixture_missing_worker_failure",
    );
  });
  it("uses the same data semantics for an unavailable worker artifact", async () => {
    context = await createMissingScanContext(handle.db, pathToFileURL(join(directory, "absent.mjs")));
    expect(await context.read(itemId)).toEqual(loadMissingScanData(handle.db).read(itemId));
  });
});
