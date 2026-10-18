import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { createDatabase, type DatabaseHandle } from "@emby-task-center/database/client";
import { libraryItems, mediaItems, mediaRoots, mediaTasks } from "@emby-task-center/database/schema";
import { getDashboardSummary } from "./dashboard";

describe("getDashboardSummary", () => {
  let directory: string;
  let database: DatabaseHandle;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "dashboard-"));
    database = createDatabase(join(directory, "app.sqlite"));
    const ts = new Date().toISOString();

    const home = database.db
      .insert(mediaItems)
      .values({ mediaType: "movie", title: "甲", createdAt: ts, updatedAt: ts })
      .returning()
      .get();
    const series = database.db
      .insert(mediaItems)
      .values({ mediaType: "tv", title: "乙", createdAt: ts, updatedAt: ts })
      .returning()
      .get();
    const root = database.db
      .insert(mediaRoots)
      .values({ name: "电影库", mediaType: "movie", containerPath: "/movies", createdAt: ts, updatedAt: ts })
      .returning()
      .get();

    // STRM 清单：2 条未匹配条目（mediaItemId 为空）。
    database.db
      .insert(libraryItems)
      .values({ mediaRootId: root.id, relativePath: "a.mkv", sourceTitle: "a", createdAt: ts, updatedAt: ts })
      .run();
    database.db
      .insert(libraryItems)
      .values({ mediaRootId: root.id, relativePath: "b.mkv", sourceTitle: "b", createdAt: ts, updatedAt: ts })
      .run();

    // 任务：pending / running / completed
    database.db
      .insert(mediaTasks)
      .values({
        mediaItemId: home.id,
        taskType: "ingest",
        status: "pending",
        idempotencyKey: "t1",
        createdAt: ts,
        updatedAt: ts,
      })
      .run();
    database.db
      .insert(mediaTasks)
      .values({
        mediaItemId: home.id,
        taskType: "ingest",
        status: "running",
        idempotencyKey: "t2",
        createdAt: ts,
        updatedAt: ts,
      })
      .run();
    database.db
      .insert(mediaTasks)
      .values({
        mediaItemId: series.id,
        taskType: "ingest",
        status: "completed",
        idempotencyKey: "t3",
        createdAt: ts,
        updatedAt: ts,
      })
      .run();
    database.db
      .insert(mediaTasks)
      .values({
        mediaItemId: home.id,
        taskType: "ingest",
        status: "failed",
        idempotencyKey: "t4",
        createdAt: ts,
        updatedAt: ts,
      })
      .run();
  });

  afterEach(() => {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("aggregates task/library/member counts", () => {
    const summary = getDashboardSummary(database.db);
    expect(summary.tasks.total).toBe(4);
    expect(summary.tasks.pending).toBe(1);
    expect(summary.tasks.processing).toBe(1);
    expect(summary.tasks.completed).toBe(1);
    expect(summary.tasks.failed).toBe(1);
    expect(summary.library.roots).toBe(1);
    expect(summary.library.items).toBe(2);
    expect(summary.library.matched).toBe(0);
    expect(summary.library.unmatched).toBe(2);
    expect(summary.recentTasks.length).toBeGreaterThan(0);
  });

  it("counts only enabled inventory and restores it without deleting stored rows", () => {
    const ts = new Date().toISOString();
    const active = database.db.select().from(mediaRoots).get()!;
    const media = database.db.select().from(mediaItems).get()!;
    const disabled = database.db
      .insert(mediaRoots)
      .values({
        name: "历史库",
        mediaType: "movie",
        containerPath: "/disabled",
        enabled: false,
        createdAt: ts,
        updatedAt: ts,
      })
      .returning()
      .get();
    for (const root of [active, disabled]) {
      database.db
        .insert(libraryItems)
        .values({
          mediaRootId: root.id,
          mediaItemId: media.id,
          relativePath: "matched.mkv",
          sourceTitle: media.title,
          createdAt: ts,
          updatedAt: ts,
        })
        .run();
    }
    database.db
      .insert(libraryItems)
      .values({
        mediaRootId: disabled.id,
        relativePath: "unmatched.mkv",
        sourceTitle: "未匹配",
        createdAt: ts,
        updatedAt: ts,
      })
      .run();

    expect(getDashboardSummary(database.db).library).toEqual({ roots: 1, items: 3, matched: 1, unmatched: 2 });
    database.db.update(mediaRoots).set({ enabled: false }).where(eq(mediaRoots.id, active.id)).run();
    expect(getDashboardSummary(database.db).library).toEqual({ roots: 0, items: 0, matched: 0, unmatched: 0 });
    expect(database.db.select().from(libraryItems).all()).toHaveLength(5);
    expect(getDashboardSummary(database.db).tasks.total).toBe(4);

    database.db.update(mediaRoots).set({ enabled: true }).where(eq(mediaRoots.id, disabled.id)).run();
    expect(getDashboardSummary(database.db).library).toEqual({ roots: 1, items: 2, matched: 1, unmatched: 1 });
    expect(database.db.select().from(libraryItems).all()).toHaveLength(5);
  });
});
