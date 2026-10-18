import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Express, Request, Response } from "express";
import { createDatabase, type DatabaseHandle } from "@emby-task-center/database/client";
import { libraryEpisodes, libraryItems, mediaItems, mediaRoots } from "@emby-task-center/database/schema";
import { createLibraryService, type LibraryRootConfig } from "../library/service";
import type { InventorySummary, WorkSummary } from "../library/work-summaries";
import { registerLibraryPages } from "./library-pages";

const stamp = "2026-09-30T00:00:00.000Z";
const root: LibraryRootConfig = { id: "fixture", name: "测试库", mediaType: "mixed", path: "emby:fixture" };
type Handler = (request: Request, response: Response) => void;
interface Page {
  works: WorkSummary[];
  total: number;
  page: number;
  pageSize: number;
  summary: InventorySummary;
  facets: { resolutions: string[]; codecs: string[]; genres: string[]; years: number[] };
}

describe("library page routes without network", () => {
  let handle: DatabaseHandle;
  let rootId: number;
  let sequence: number;
  let routes: Map<string, Handler>;

  beforeEach(() => {
    handle = createDatabase(":memory:");
    const library = createLibraryService([root], undefined, handle.db);
    rootId = handle.db.select().from(mediaRoots).get()!.id;
    sequence = 0;
    routes = new Map();
    const app = { get: (path: string, callback: Handler) => routes.set(path, callback) } as unknown as Express;
    registerLibraryPages(app, handle.db, library);
  });
  afterEach(() => handle.close());

  function add(title: string, values: Partial<typeof libraryItems.$inferInsert> = {}, episode?: number) {
    const item = handle.db
      .insert(libraryItems)
      .values({
        mediaRootId: rootId,
        relativePath: `${++sequence}.strm`,
        sourceTitle: title,
        createdAt: stamp,
        updatedAt: stamp,
        ...values,
      })
      .returning()
      .get();
    if (episode != null)
      handle.db
        .insert(libraryEpisodes)
        .values({
          libraryItemId: item.id,
          parsedSeason: 1,
          episodeNumber: episode,
          numberingMode: "seasonal",
          createdAt: stamp,
        })
        .run();
    return item;
  }

  function request<T>(path: string, query: Record<string, string> = {}, rootId = root.id) {
    let status = 200;
    let body: T;
    const response = {
      status(value: number) {
        status = value;
        return this;
      },
      json(value: T) {
        body = value;
        return this;
      },
    } as unknown as Response;
    routes.get(path)!({ query, params: { rootId } } as unknown as Request, response);
    return { status, body: body! };
  }
  const worksPath = "/api/library/roots/:rootId/works";

  function seed() {
    const first = add(
      "Alpha",
      {
        sourceYear: 2024,
        recognitionStatus: "matched",
        tags: ["2160p", "HEVC"],
        genres: ["剧情"],
        posterPath: "emby:1",
        fileModifiedAt: "2026-09-29",
      },
      1,
    );
    const second = add("alpha", { sourceYear: 2024, tags: ["1080p", "AVC"], genres: ["科幻"] }, 2);
    add("Beta", { tags: ["720p", "AV1"], genres: ["喜剧"], fileModifiedAt: "2026-09-30" });
    add("Gamma", { sourceYear: 2022, recognitionStatus: "matched", tags: ["1080p", "HEVC"], genres: ["剧情"] });
    add("Delta", { sourceYear: 2020, tags: ["480p", "AVC"], genres: ["动画"] }, 1);
    return [first.id, second.id];
  }

  it("paginates work groups, gives one representative per card and loads full details separately", () => {
    const ids = seed();
    const first = request<Page>(worksPath, { page: "1", pageSize: "2", sort: "title" });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ total: 4, page: 1, pageSize: 2 });
    expect(first.body.works.map((w) => w.title)).toEqual(["Alpha", "Beta"]);
    expect(first.body.works[0]).toMatchObject({ fileCount: 2, matchedFiles: 1, unmatchedFiles: 1 });
    expect(first.body.works[0]!.items).toHaveLength(1);
    const second = request<Page>(worksPath, { page: "2", pageSize: "2", sort: "title" });
    expect(second.body.works.map((w) => w.title)).toEqual(["Delta", "Gamma"]);
    const details = request<{ items: Array<{ databaseId: number }> }>("/api/library/roots/:rootId/works/items", {
      key: first.body.works[0]!.key,
    });
    expect(details.status).toBe(200);
    expect(details.body.items.map((i) => i.databaseId).sort()).toEqual(ids.sort());
  });

  it("finds the same TMDB work by any source title and retains complete episode details", () => {
    const media = handle.db
      .insert(mediaItems)
      .values({
        title: "中文剧名",
        mediaType: "tv",
        tmdbId: 123,
        createdAt: stamp,
        updatedAt: stamp,
      })
      .returning()
      .get();
    const ids = [
      add("中文剧名", { mediaItemId: media.id, sourceYear: 2023, recognitionStatus: "matched" }, 1).id,
      add("Original Title", { mediaItemId: media.id, sourceYear: 2024, recognitionStatus: "matched" }, 2).id,
    ];
    add("Unrelated");
    const chinese = request<Page>(worksPath, { q: "中文", pageSize: "1" }).body;
    const original = request<Page>(worksPath, { q: "  ORIGINAL  ", pageSize: "1", sort: "latest" }).body;
    expect(chinese).toMatchObject({ total: 1, page: 1, pageSize: 1 });
    expect(original).toMatchObject({ total: 1, page: 1, pageSize: 1 });
    expect(chinese.works[0]!.key).toBe("tmdb|tv|123");
    expect(original.works[0]!.key).toBe(chinese.works[0]!.key);
    expect(chinese.works[0]!.fileCount).toBe(2);
    expect(chinese.works[0]!.items).toHaveLength(1);
    const details = request<{ items: Array<{ databaseId: number }> }>("/api/library/roots/:rootId/works/items", {
      key: original.works[0]!.key,
    });
    expect(details.body.items.map((row) => row.databaseId).sort()).toEqual(ids.sort());
  });

  it.each([
    [{ type: "tv" }, ["Alpha", "Delta"]],
    [{ type: "movie" }, ["Beta", "Gamma"]],
    [{ status: "matched" }, ["Alpha", "Gamma"]],
    [{ status: "unresolved" }, ["Beta", "Delta"]],
    [{ year: "2024" }, ["Alpha"]],
    [{ resolution: "2160p" }, ["Alpha"]],
    [{ codec: "AV1" }, ["Beta"]],
    [{ genre: "科幻" }, ["Alpha"]],
    [{ q: "  ALpHa " }, ["Alpha"]],
    [
      { type: "tv", status: "matched", year: "2024", resolution: "1080p", codec: "AVC", genre: "科幻", q: "alpha" },
      ["Alpha"],
    ],
  ])("filters %j while facets and summary still describe the complete root", (query, expected) => {
    seed();
    const result = request<Page>(worksPath, query);
    expect(result.body.works.map((w) => w.title)).toEqual(expected);
    expect(result.body.facets).toEqual({
      resolutions: ["2160p", "1080p", "720p", "480p"],
      codecs: ["HEVC", "AVC", "AV1"],
      genres: ["剧情", "科幻", "喜剧", "动画"].sort((a, b) => a.localeCompare(b, "zh-CN")),
      years: [2024, 2022, 2020],
    });
    expect(result.body.summary).toMatchObject({
      totalFiles: 5,
      workCount: 4,
      matchedFiles: 2,
      unmatchedFiles: 3,
      matchRatio: 40,
    });
  });

  it("sorts by year or latest date and returns an empty first page for unmatched filters", () => {
    seed();
    expect(request<Page>(worksPath, { sort: "year" }).body.works.map((w) => w.title)).toEqual([
      "Alpha",
      "Gamma",
      "Delta",
      "Beta",
    ]);
    expect(
      request<Page>(worksPath, { sort: "latest" })
        .body.works.slice(0, 2)
        .map((w) => w.title),
    ).toEqual(["Beta", "Alpha"]);
    expect(request<Page>(worksPath, { q: "missing", page: "999" }).body).toMatchObject({
      works: [],
      total: 0,
      page: 1,
    });
  });

  it("bounds page sizes, clamps the last page, and defaults invalid values", () => {
    for (let i = 0; i < 105; i += 1) add(`Work ${String(i).padStart(3, "0")}`);
    const first = request<Page>(worksPath, { pageSize: "99999" }).body;
    expect(first.works).toHaveLength(100);
    expect(first.pageSize).toBe(100);
    const last = request<Page>(worksPath, { pageSize: "99999", page: "99999999999" }).body;
    expect(last).toMatchObject({ page: 2, pageSize: 100, total: 105 });
    expect(last.works).toHaveLength(5);
    for (const invalid of ["0", "-1", "NaN", "Infinity"]) {
      const page = request<Page>(worksPath, { pageSize: invalid, page: invalid }).body;
      expect(page).toMatchObject({ page: 1, pageSize: 48 });
      expect(page.works).toHaveLength(48);
    }
    const fractional = request<Page>(worksPath, { pageSize: "0.5", page: "0.5" }).body;
    expect(fractional).toMatchObject({ page: 1, pageSize: 1 });
    expect(fractional.works).toHaveLength(1);
  });

  it("returns only configured roots in summary and validates detail keys", () => {
    seed();
    const result = request<{ roots: Array<{ id: string }>; summary: InventorySummary }>("/api/library/summary");
    expect(result.body.roots.map((r) => r.id)).toEqual([root.id]);
    expect(result.body.summary).toMatchObject({ totalFiles: 5, workCount: 4, posterFiles: 1 });
    expect(request(worksPath, {}, "missing").status).toBe(404);
    const detail = "/api/library/roots/:rootId/works/items";
    expect(request(detail).status).toBe(400);
    expect(request(detail, { key: "x".repeat(2049) }).status).toBe(400);
    expect(request(detail, { key: "unknown" }).status).toBe(404);
  });
});
