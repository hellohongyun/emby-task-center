import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import type BetterSqlite3 from "better-sqlite3";
import { createDatabase, type DatabaseHandle } from "@emby-task-center/database/client";
import { appSettings, libraryItems, mediaItems, mediaRoots } from "@emby-task-center/database/schema";
import { createPublicLibraryReader, type LibraryFilters } from "./public-library-reader";

const filters: LibraryFilters = {
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
describe("bounded public library reads", () => {
  let directory: string;
  let handle: DatabaseHandle;
  let root: number;
  const now = "2026-01-01T00:00:00.000Z";
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "emby-library-reader-"));
    handle = createDatabase(join(directory, "app.sqlite"));
    root = handle.db
      .insert(mediaRoots)
      .values({
        name: "启用库",
        containerPath: "/old",
        mediaType: "mixed",
        enabled: true,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get().id;
  });
  afterEach(() => {
    vi.useRealTimers();
    handle.close();
    rmSync(directory, { recursive: true, force: true });
  });
  function add(title: string, year: number, tags: string[], overrides: Partial<typeof mediaItems.$inferInsert> = {}) {
    const media = handle.db
      .insert(mediaItems)
      .values({
        tmdbId: year,
        mediaType: "movie",
        title,
        releaseYear: year,
        genres: ["动作"],
        tmdbPayload: { cast: ["主演", ...Array.from({ length: 12 }, (_, i) => `配角${i}`)] },
        createdAt: now,
        updatedAt: now,
        ...overrides,
      })
      .returning()
      .get();
    handle.db
      .insert(libraryItems)
      .values({
        mediaRootId: root,
        mediaItemId: media.id,
        relativePath: `${title}.strm`,
        sourceTitle: title,
        sourceYear: year,
        tags,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    return media;
  }
  it("keeps global facets, tag union and locale sorting", () => {
    const media = add("阿凡达", 2009, ["1080p", "H264"]);
    add("中途岛", 2019, ["720p"], { mediaType: "tv", genres: ["战争"] });
    handle.db
      .insert(libraryItems)
      .values({
        mediaRootId: root,
        mediaItemId: media.id,
        relativePath: "Avatar2.strm",
        sourceTitle: "Avatar",
        tags: ["2160p", "HEVC"],
        createdAt: now,
        updatedAt: "2026-01-02",
      })
      .run();
    handle.db
      .insert(libraryItems)
      .values({
        mediaRootId: root,
        relativePath: "unknown.strm",
        sourceTitle: "未知",
        sourceYear: 2000,
        tags: [],
        createdAt: now,
        updatedAt: now,
      })
      .run();
    const reader = createPublicLibraryReader({ database: handle.db }, null);
    const page = reader.list(
      { ...filters, actor: "配角11", resolution: "2160p", codec: "HEVC", query: "阿凡达  2009" },
      "title",
      1,
      0,
    );
    expect(page.total).toBe(1);
    expect(page.items[0]).toMatchObject({ id: `mi:${media.id}`, fileCount: 2, resolution: "2160p" });
    expect(page.facets.types).toEqual({ all: 3, movie: 2, tv: 1 });
    expect(page.facets.statuses.unresolved).toBe(1);
    expect(page.facets.actors).not.toContain("配角11");
    const all = reader.list(filters, "title", 40, 0).items;
    expect(all.map((item) => item.title)).toEqual(
      ["阿凡达", "未知", "中途岛"].sort((a, b) => a.localeCompare(b, "zh-CN")),
    );
    expect(reader.list({ ...filters, yearFrom: 2010, genre: "战争" }, "year", 40, 0).items[0]?.title).toBe("中途岛");
  });
  it("only reads full metadata for the page and target detail", () => {
    const first = add("目标", 2020, []);
    for (let i = 0; i < 50; i++) add(`其他${i}`, 3000 + i, [], { overview: "x".repeat(10000) });
    const client = (handle.db as unknown as { $client: BetterSqlite3.Database }).$client;
    const prepare = vi.spyOn(client, "prepare");
    const reader = createPublicLibraryReader({ database: handle.db }, null);
    expect(reader.list(filters, "title", 1, 0).items).toHaveLength(1);
    const fullSelects = prepare.mock.calls.map(([query]) => query).filter((query) => query.includes('"overview"'));
    expect(fullSelects).toHaveLength(1);
    expect(fullSelects[0]).toContain('where "media_items"."id" in (?)');
    prepare.mockClear();
    expect(reader.detail(`mi:${first.id}`)?.title).toBe("目标");
    expect(prepare.mock.calls.some(([query]) => query.includes("json_group_array(DISTINCT li.tags_json)"))).toBe(false);
    expect(prepare.mock.calls.filter(([query]) => query.includes('"overview"'))[0]?.[0]).toContain(
      'where "media_items"."id" in (?)',
    );
    prepare.mockRestore();
  });
  it("keeps numeric unresolved ids, colon titles and legacy TMDB detail lookup", () => {
    const first = add("旧客户端", 9999, []);
    const row = handle.db
      .insert(libraryItems)
      .values({
        mediaRootId: root,
        relativePath: "unknown.strm",
        sourceTitle: "带:冒号",
        sourceYear: null,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
    const reader = createPublicLibraryReader({ database: handle.db }, null);
    expect(reader.detail("mi:9999")?.id).toBe(`mi:${first.id}`);
    expect(reader.detail(`li:${row.id}`)?.id).toBe("li:带:冒号:");
    expect(reader.detail("li:带:冒号:")?.fileCount).toBe(1);
  });
  it("invalidates same-connection edits and committed worker-connection edits", () => {
    vi.useFakeTimers();
    const first = add("旧标题", 2001, []);
    const reader = createPublicLibraryReader({ database: handle.db }, null);
    expect(reader.list(filters, "latest", 40, 0).items[0]?.title).toBe("旧标题");
    handle.db.update(mediaItems).set({ title: "本地修改" }).where(eq(mediaItems.id, first.id)).run();
    vi.advanceTimersByTime(1000);
    expect(reader.list({ ...filters, query: "本地修改" }, "latest", 40, 0).total).toBe(1);
    const worker = createDatabase(join(directory, "app.sqlite"));
    try {
      worker.db.update(mediaItems).set({ title: "扫描更新" }).where(eq(mediaItems.id, first.id)).run();
      vi.advanceTimersByTime(1000);
      expect(reader.list({ ...filters, query: "扫描更新" }, "latest", 40, 0).total).toBe(1);
    } finally {
      worker.close();
    }
  });
  it("supports connections that explicitly prohibit even temporary writes", () => {
    add("只读影片", 2020, ["1080p"]);
    handle.db.run(sql.raw("PRAGMA query_only = ON"));
    const reader = createPublicLibraryReader({ database: handle.db }, null);
    expect(reader.list(filters, "title", 1, 0).items[0]?.title).toBe("只读影片");
    expect(reader.list({ ...filters, resolution: "1080p" }, "year", 1, 0).total).toBe(1);
  });
  it("does not rebuild the group index for unrelated writes", () => {
    vi.useFakeTimers();
    add("影片", 2020, []);
    const client = (handle.db as unknown as { $client: BetterSqlite3.Database }).$client;
    const prepare = vi.spyOn(client, "prepare");
    const reader = createPublicLibraryReader({ database: handle.db }, null);
    reader.list(filters, "latest", 40, 0);
    prepare.mockClear();
    handle.db.insert(appSettings).values({ key: "test.unrelated", value: "value", updatedAt: now }).run();
    vi.advanceTimersByTime(1000);
    reader.list(filters, "latest", 40, 0);
    expect(prepare.mock.calls.some(([query]) => query.includes("json_group_array(DISTINCT li.tags_json)"))).toBe(false);
    const worker = createDatabase(join(directory, "app.sqlite"));
    try {
      worker.db.update(appSettings).set({ value: "new" }).where(eq(appSettings.key, "test.unrelated")).run();
      prepare.mockClear();
      vi.advanceTimersByTime(1000);
      reader.list(filters, "latest", 40, 0);
      expect(prepare.mock.calls.some(([query]) => query.includes("json_group_array(DISTINCT li.tags_json)"))).toBe(
        false,
      );
    } finally {
      worker.close();
      prepare.mockRestore();
    }
  });
});
