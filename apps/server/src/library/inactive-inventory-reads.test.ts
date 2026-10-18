import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Express, Request, Response } from "express";
import { eq } from "drizzle-orm";
import { createDatabase, type DatabaseHandle } from "@emby-task-center/database/client";
import { libraryItems, mediaRoots } from "@emby-task-center/database/schema";
import { registerLibraryPages } from "../routes/library-pages";
import { readInventory } from "./inventory-reader";
import { createLibraryService, type LibraryRootConfig, type LibraryService } from "./service";
import { createWorkSummaryStore } from "./work-summaries";

const stamp = "2026-10-07T00:00:00Z";
const root: LibraryRootConfig = { id: "test", name: "测试库", mediaType: "movie", path: "emby:test" };
type Handler = (request: Request, response: Response) => void;

describe("inactive inventory read boundaries", () => {
  let handle: DatabaseHandle;
  let library: LibraryService;
  let rootId: number;
  beforeEach(() => {
    handle = createDatabase(":memory:");
    library = createLibraryService([root], undefined, handle.db);
    rootId = handle.db.select().from(mediaRoots).get()!.id;
    handle.db
      .insert(libraryItems)
      .values({
        mediaRootId: rootId,
        relativePath: "one.strm",
        sourceTitle: "保留的电影",
        createdAt: stamp,
        updatedAt: stamp,
      })
      .run();
  });
  afterEach(() => handle.close());

  function enabled(value: boolean) {
    // 不更新扫描或时间标记：停用状态本身必须绕过已经加载的缓存。
    handle.db.update(mediaRoots).set({ enabled: value }).where(eq(mediaRoots.id, rootId)).run();
  }

  it("rejects warm summaries, details and inventory after disable and restores stock after enable", () => {
    const store = createWorkSummaryStore(handle.db);
    const first = store.get(root)!;
    const key = first.works[0]!.key;
    expect(store.page(root, first.works)).toHaveLength(1);
    expect(store.details(root, key)).toHaveLength(1);
    expect(library.getInventoryPayload(root.id)).not.toBeNull();
    enabled(false);
    expect(store.get(root)).toBeNull();
    expect(store.page(root, first.works)).toEqual([]);
    expect(store.details(root, key)).toBeNull();
    expect(readInventory(handle.db, root)).toEqual([]);
    expect(library.listRoots()).toEqual([]);
    expect(library.getInventory(root.id)).toBeNull();
    expect(library.getInventoryPayload(root.id)).toBeNull();
    expect(handle.db.select().from(libraryItems).all()).toHaveLength(1);
    enabled(true);
    expect(store.get(root)!.summary.totalFiles).toBe(1);
    expect(store.details(root, key)).toHaveLength(1);
    expect(library.getInventory(root.id)!.items).toHaveLength(1);
  });

  it("omits disabled roots from summary and refuses direct work URLs even with a stale root provider", () => {
    const routes = new Map<string, Handler>();
    const app = { get: (path: string, handler: Handler) => routes.set(path, handler) } as unknown as Express;
    library.listRoots = () => [root];
    registerLibraryPages(app, handle.db, library);
    function request(path: string, query = {}) {
      let status = 200;
      let body: unknown;
      const response = {
        status(value: number) {
          status = value;
          return this;
        },
        json(value: unknown) {
          body = value;
          return this;
        },
      } as unknown as Response;
      routes.get(path)!({ params: { rootId: root.id }, query } as unknown as Request, response);
      return { status, body };
    }
    const summaryPath = "/api/library/summary";
    const worksPath = "/api/library/roots/:rootId/works";
    expect(request(summaryPath).body).toMatchObject({ summary: { totalFiles: 1 } });
    const first = request(worksPath).body as { works: Array<{ key: string }> };
    enabled(false);
    expect(request(summaryPath).body).toMatchObject({ roots: [], summary: { totalFiles: 0 }, unmatchedReport: [] });
    expect(request(worksPath).status).toBe(404);
    expect(request(`${worksPath}/items`, { key: first.works[0]!.key }).status).toBe(404);
    enabled(true);
    expect(request(summaryPath).body).toMatchObject({ roots: [{ id: root.id }], summary: { totalFiles: 1 } });
    expect(request(worksPath).status).toBe(200);
  });
});
