import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDatabase, type DatabaseHandle } from "@emby-task-center/database/client";
import { libraryItems, mediaItems, mediaRoots } from "@emby-task-center/database/schema";
import { createPublicLibraryReader } from "./public-library-reader";
import { createPublicLibraryWorkerReader } from "./public-library-worker-client";

const repo = fileURLToPath(new URL("../../../../", import.meta.url));
const filters = {
  type: "all",
  status: "all",
  resolution: "all",
  codec: "",
  genre: "",
  actor: "",
  yearFrom: null,
  yearTo: null,
  query: "",
};
describe("real public library worker", () => {
  let directory: string;
  let workerUrl: URL;
  let handle: DatabaseHandle;
  let reader: ReturnType<typeof createPublicLibraryWorkerReader>;
  let itemId: number;
  let rootId: number;
  beforeAll(async () => {
    mkdirSync(join(repo, ".local"), { recursive: true });
    directory = mkdtempSync(join(repo, ".local/public-library-worker-test-"));
    const manifest = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    const path = join(directory, "public-library-worker.mjs");
    await build({
      entryPoints: [join(repo, "apps/server/src/routes/public-library-worker.ts")],
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
    handle = createDatabase(join(directory, `${crypto.randomUUID()}.sqlite`));
    const now = "2026-01-01";
    const root = handle.db
      .insert(mediaRoots)
      .values({
        name: "电影",
        containerPath: "emby:fixture",
        mediaType: "movie",
        enabled: true,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
    rootId = root.id;
    const item = handle.db
      .insert(mediaItems)
      .values({
        title: "测试电影",
        mediaType: "movie",
        tmdbId: 10,
        genres: ["动作"],
        tmdbPayload: { cast: ["演员"] },
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
    itemId = item.id;
    handle.db
      .insert(libraryItems)
      .values({
        mediaRootId: root.id,
        mediaItemId: item.id,
        relativePath: "Movie.strm",
        sourceTitle: "电影",
        tags: ["2160p"],
        createdAt: now,
        updatedAt: now,
      })
      .run();
    reader = createPublicLibraryWorkerReader({ database: handle.db }, null, workerUrl);
  });
  afterEach(async () => {
    await reader.close();
    handle.close();
  });
  afterAll(() => {
    if (!resolve(directory).startsWith(resolve(repo, ".local") + sep)) throw new Error("unexpected_test_cleanup_path");
    rmSync(directory, { recursive: true, force: true });
  });
  it("matches synchronous semantics and leaves the main event loop available", async () => {
    let heartbeat = false;
    const tick = new Promise<void>((done) =>
      setTimeout(() => {
        heartbeat = true;
        done();
      }, 0),
    );
    const page = await reader.list(filters, "latest", 24, 0);
    expect(heartbeat).toBe(true);
    await tick;
    expect(page).toEqual(createPublicLibraryReader({ database: handle.db }, null).list(filters, "latest", 24, 0));
    const pages = await Promise.all([reader.list(filters, "title", 1, 0), reader.list(filters, "year", 1, 0)]);
    expect(pages.map((value) => value.total)).toEqual([1, 1]);
  });
  it("observes other-connection metadata changes without requiring timestamp changes", async () => {
    await reader.list(filters, "latest", 24, 0);
    handle.db.update(mediaItems).set({ title: "扫描更新" }).where(eq(mediaItems.id, itemId)).run();
    // Worker index checks are bounded to one check per second.
    await new Promise((done) => setTimeout(done, 1100));
    const page = await reader.list({ ...filters, query: "扫描更新" }, "latest", 24, 0);
    expect(page.items[0]?.title).toBe("扫描更新");
  });
  it("immediately hides and restores inventory after root toggles across connections", async () => {
    expect((await reader.list(filters, "latest", 24, 0)).total).toBe(1);
    handle.db.update(mediaRoots).set({ enabled: false }).where(eq(mediaRoots.id, rootId)).run();
    expect(await reader.list(filters, "latest", 24, 0)).toMatchObject({
      total: 0,
      items: [],
      facets: { types: { all: 0 }, genres: [], resolutions: [] },
    });
    expect(reader.detail(`mi:${itemId}`)).toBeUndefined();
    handle.db.update(mediaRoots).set({ enabled: true }).where(eq(mediaRoots.id, rootId)).run();
    expect(await reader.list(filters, "latest", 24, 0)).toMatchObject({
      total: 1,
      items: [{ id: `mi:${itemId}`, fileCount: 1 }],
      facets: { types: { all: 1 }, genres: ["动作"], resolutions: ["2160p"] },
    });
    expect(handle.db.select().from(libraryItems).all()).toHaveLength(1);
  });
  it("rejects a crashed worker request and can recreate it for the next request", async () => {
    await reader.close();
    const brokenPath = join(directory, `restart-${crypto.randomUUID()}.mjs`);
    writeFileSync(brokenPath, "throw new Error('fixture_worker_failure');");
    reader = createPublicLibraryWorkerReader({ database: handle.db }, null, pathToFileURL(brokenPath));
    await expect(reader.list(filters, "latest", 24, 0)).rejects.toThrow("fixture_worker_failure");
    writeFileSync(brokenPath, readFileSync(workerUrl));
    expect((await reader.list(filters, "latest", 24, 0)).total).toBe(1);
  });
  it("closing rejects in-flight requests and prevents new ones", async () => {
    const request = reader.list(filters, "latest", 24, 0);
    const rejected = expect(request).rejects.toThrow("public_library_reader_closed");
    await reader.close();
    await rejected;
    await expect(reader.list(filters, "latest", 24, 0)).rejects.toThrow("public_library_reader_closed");
  });
});
