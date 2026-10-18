import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabase } from "@emby-task-center/database/client";
import { libraryItems, mediaRoots, mediaTasks, taskRuns } from "@emby-task-center/database/schema";
import {
  applyScheduledAirProgress,
  claimTask,
  completeTask,
  completeSyncedTasks,
  createManualTask,
  createTask,
  deleteTask,
  failTask,
  getTask,
  listTasks,
  setTaskFolderMapping,
  clearTaskFolderMapping,
  sweepExpiredCompletedIngestTasks,
  updateTaskSchedule,
  updateTaskAirProgress,
  updateTaskSeason,
} from "./task-service";

const taskInput = {
  mediaType: "tv" as const,
  taskType: "ingest" as const,
  title: "The Expanse",
  tmdbId: 63639,
  contentKind: "series" as const,
};

describe("task service", () => {
  let directory: string;
  let database: ReturnType<typeof createDatabase>;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "emby-task-center-"));
    database = createDatabase(join(directory, "tasks.sqlite"));
  });

  afterEach(() => {
    database.close();
    rmSync(directory, { force: true, recursive: true });
  });

  it("creates required schema tables in a temporary SQLite database", () => {
    expect(listTasks(database.db)).toEqual([]);
  });

  it("returns the existing task for a duplicate idempotency key", () => {
    const created = createTask(database.db, taskInput);
    const duplicate = createTask(database.db, { ...taskInput, title: "Renamed title" });

    expect(duplicate).toMatchObject({ id: created.id, title: "The Expanse", status: "pending" });
    expect(listTasks(database.db)).toHaveLength(1);
  });

  it("allows only one worker to hold an active task lease", () => {
    const task = createTask(database.db, taskInput);
    const firstClaim = claimTask(database.db, task.id, "worker-a", new Date("2026-08-10T00:00:00Z"));
    const secondClaim = claimTask(database.db, task.id, "worker-b", new Date("2026-08-10T00:01:00Z"));

    expect(firstClaim).toMatchObject({ id: task.id, status: "claimed", leaseOwner: "worker-a" });
    expect(secondClaim).toBeNull();
  });

  it("allows a new worker to claim a task after its lease expires", () => {
    const task = createTask(database.db, taskInput);
    claimTask(database.db, task.id, "worker-a", new Date("2026-08-10T00:00:00Z"));

    const recoveredClaim = claimTask(database.db, task.id, "worker-b", new Date("2026-08-10T00:16:00Z"));

    expect(recoveredClaim).toMatchObject({
      id: task.id,
      status: "claimed",
      leaseOwner: "worker-b",
    });
  });

  it("extends the lease when a series ingest task has many missing episodes", () => {
    const task = createTask(database.db, {
      mediaType: "tv",
      taskType: "ingest",
      title: "长篇",
      tmdbId: 900,
      contentKind: "series",
    });
    updateTaskAirProgress(database.db, task.id, 30);
    const claimed = claimTask(database.db, task.id, "worker-a", new Date("2026-08-10T00:00:00Z"))!;
    expect(claimed.leaseExpiresAt).toBe("2026-08-10T01:00:00.000Z");
    const stillHeld = claimTask(database.db, task.id, "worker-b", new Date("2026-08-10T00:30:00Z"));
    expect(stillHeld).toBeNull();
    const recovered = claimTask(database.db, task.id, "worker-b", new Date("2026-08-10T01:01:00Z"));
    expect(recovered).toMatchObject({ id: task.id, status: "claimed", leaseOwner: "worker-b" });
  });

  it("extends the lease for a finished series ingest task with many missing episodes", () => {
    const task = createTask(database.db, {
      mediaType: "tv",
      taskType: "ingest",
      title: "完结长篇",
      tmdbId: 901,
      contentKind: "series",
    });
    updateTaskAirProgress(database.db, task.id, 30);
    const claimed = claimTask(database.db, task.id, "worker-a", new Date("2026-08-10T00:00:00Z"))!;
    expect(claimed.leaseExpiresAt).toBe("2026-08-10T01:00:00.000Z");
    const recovered = claimTask(database.db, task.id, "worker-b", new Date("2026-08-10T01:01:00Z"));
    expect(recovered).toMatchObject({ id: task.id, status: "claimed", leaseOwner: "worker-b" });
  });

  it("completes a task claimed by its lease owner", () => {
    const task = createTask(database.db, taskInput);
    const claimed = claimTask(database.db, task.id, "worker-a", new Date("2026-08-10T00:00:00Z"))!;

    const completed = completeTask(database.db, task.id, "worker-a", claimed.version, new Date("2026-08-10T00:01:00Z"));

    expect(completed).toMatchObject({ id: task.id, status: "completed", leaseOwner: null });
    expect(listTasks(database.db)[0]).toMatchObject({ status: "completed" });
  });

  it("rejects completion by a worker that does not own the lease", () => {
    const task = createTask(database.db, taskInput);
    const claimed = claimTask(database.db, task.id, "worker-a", new Date("2026-08-10T00:00:00Z"))!;

    const completed = completeTask(database.db, task.id, "worker-b", claimed.version, new Date("2026-08-10T00:01:00Z"));

    expect(completed).toBeNull();
    expect(listTasks(database.db)[0]).toMatchObject({ status: "claimed", leaseOwner: "worker-a" });
  });

  it("writes claim and completion transitions to task run audit rows", () => {
    const task = createTask(database.db, taskInput);
    const claimed = claimTask(database.db, task.id, "worker-a", new Date("2026-08-10T00:00:00Z"))!;
    completeTask(database.db, task.id, "worker-a", claimed.version, new Date("2026-08-10T00:01:00Z"));

    const runs = database.db
      .select({
        phase: taskRuns.phase,
        workerId: taskRuns.workerId,
        beforeStatus: taskRuns.beforeStatus,
        afterStatus: taskRuns.afterStatus,
      })
      .from(taskRuns)
      .orderBy(taskRuns.id)
      .all();

    expect(runs).toEqual([
      { phase: "claim", workerId: "worker-a", beforeStatus: "pending", afterStatus: "claimed" },
      { phase: "completed", workerId: "worker-a", beforeStatus: "claimed", afterStatus: "completed" },
    ]);
  });

  it("increments the optimistic version for each lifecycle transition", () => {
    const task = createTask(database.db, taskInput);
    const claimed = claimTask(database.db, task.id, "worker-a", new Date("2026-08-10T00:00:00Z"))!;
    completeTask(database.db, task.id, "worker-a", claimed.version, new Date("2026-08-10T00:01:00Z"));

    const row = database.db
      .select({ version: mediaTasks.version })
      .from(mediaTasks)
      .where(eq(mediaTasks.id, task.id))
      .get();

    expect(row?.version).toBe(3);
  });

  it("rejects completion by the lease owner after the lease expires", () => {
    const task = createTask(database.db, taskInput);
    const claimed = claimTask(database.db, task.id, "worker-a", new Date("2026-08-10T00:00:00Z"))!;

    const completed = completeTask(database.db, task.id, "worker-a", claimed.version, new Date("2026-08-10T00:16:00Z"));

    expect(completed).toBeNull();
    expect(listTasks(database.db)[0]).toMatchObject({ status: "claimed", leaseOwner: "worker-a" });
  });

  it("records a failure from the active lease owner", () => {
    const task = createTask(database.db, taskInput);
    const claimed = claimTask(database.db, task.id, "worker-a", new Date("2026-08-10T00:00:00Z"))!;

    const failed = failTask(
      database.db,
      task.id,
      "worker-a",
      claimed.version,
      "provider unavailable",
      new Date("2026-08-10T00:01:00Z"),
    );

    expect(failed).toMatchObject({
      id: task.id,
      status: "failed",
      leaseOwner: null,
      statusMessage: "provider unavailable",
    });
  });

  it("rejects failure by the lease owner after the lease expires", () => {
    const task = createTask(database.db, taskInput);
    const claimed = claimTask(database.db, task.id, "worker-a", new Date("2026-08-10T00:00:00Z"))!;

    const failed = failTask(
      database.db,
      task.id,
      "worker-a",
      claimed.version,
      "provider unavailable",
      new Date("2026-08-10T00:16:00Z"),
    );

    expect(failed).toBeNull();
    expect(listTasks(database.db)[0]).toMatchObject({ status: "claimed", leaseOwner: "worker-a" });
  });

  it("stores the source counting mode and keeps it when clearing the folder mapping", () => {
    const handle = createDatabase(":memory:");
    const task = createManualTask(handle.db, {
      mediaType: "tv",
      taskType: "ingest",
      title: "仙逆",
      releaseYear: 2023,
      contentKind: "series",
    });
    expect(task.sourceMode).toBe("auto");

    const mapped = setTaskFolderMapping(handle.db, task.id, "tv", "仙逆 (2023)/Season 01", 3, "mapped");
    expect(mapped).toMatchObject({
      sourceMode: "mapped",
      mappedRootId: "tv",
      mappedFolderPath: "仙逆 (2023)/Season 01",
      storedProgress: 3,
    });

    // 映射任务即使无自动匹配文件，也按已存数计算缺集
    updateTaskAirProgress(handle.db, task.id, 5);
    expect(getTask(handle.db, task.id)).toMatchObject({ libraryMatched: true, missingEpisodes: [4, 5] });

    const cleared = clearTaskFolderMapping(handle.db, task.id);
    expect(cleared).toMatchObject({ mappedRootId: null, mappedFolderPath: null, sourceMode: "mapped" });
    handle.close();
  });
});
it("auto-completes pending series ingest tasks whose gaps are fully synced", () => {
  const handle = createDatabase(":memory:");
  const synced = createTask(handle.db, {
    mediaType: "tv",
    taskType: "ingest",
    title: "Synced Show",
    tmdbId: 110,
    contentKind: "series",
  });
  updateTaskAirProgress(handle.db, synced.id, 3);
  handle.db
    .update(mediaTasks)
    .set({ storedProgress: 3, status: "pending", statusMessage: "stale gap hint" })
    .where(eq(mediaTasks.id, synced.id))
    .run();
  const gapped = createTask(handle.db, {
    mediaType: "tv",
    taskType: "ingest",
    title: "Gapped Show",
    tmdbId: 111,
    contentKind: "series",
  });
  updateTaskAirProgress(handle.db, gapped.id, 3);
  handle.db.update(mediaTasks).set({ storedProgress: 2 }).where(eq(mediaTasks.id, gapped.id)).run();
  const unknown = createTask(handle.db, {
    mediaType: "tv",
    taskType: "ingest",
    title: "Unknown Air Progress",
    tmdbId: 112,
    contentKind: "series",
  });

  const completed = completeSyncedTasks(handle.db, new Date("2026-08-15T04:00:00.000Z"));
  expect(completed.map((task) => task.title)).toEqual(["Synced Show"]);
  expect(getTask(handle.db, synced.id)).toMatchObject({ status: "completed", statusMessage: null, leaseOwner: null });
  expect(getTask(handle.db, gapped.id)).toMatchObject({ status: "pending", missingEpisodes: [3] });
  expect(getTask(handle.db, unknown.id)).toMatchObject({ status: "pending" });
  handle.close();
});
it("tracks season numbers independently and updates the tracked season", () => {
  const handle = createDatabase(":memory:");
  const seasonFive = createTask(handle.db, {
    mediaType: "tv",
    taskType: "ingest",
    title: "Battle Through the Heavens",
    tmdbId: 79481,
    seasonNumber: 5,
    contentKind: "series",
  });
  const wholeSeries = createTask(handle.db, {
    mediaType: "tv",
    taskType: "ingest",
    title: "Battle Through the Heavens",
    tmdbId: 79481,
    contentKind: "series",
  });
  expect(seasonFive.seasonNumber).toBe(5);
  expect(wholeSeries.seasonNumber).toBeNull();
  expect(seasonFive.id).not.toBe(wholeSeries.id);
  const updated = updateTaskSeason(handle.db, seasonFive.id, 4);
  expect(updated?.seasonNumber).toBe(4);
  const cleared = updateTaskSeason(handle.db, seasonFive.id, null);
  expect(cleared?.seasonNumber).toBeNull();
  handle.close();
});
it("creates a manual task and applies the weekly air-progress schedule once per occurrence", () => {
  const handle = createDatabase(":memory:");
  const task = createManualTask(handle.db, {
    mediaType: "tv",
    taskType: "ingest",
    title: "斗破苍穹：年番",
    releaseYear: 2022,
    contentKind: "series",
  });
  expect(task.tmdbId).toBeNull();
  expect(task.title).toBe("斗破苍穹：年番");

  const now = new Date(2026, 7, 14, 10, 0);
  const day = now.getDay();
  updateTaskSchedule(handle.db, task.id, [day], "10:00");
  expect(getTask(handle.db, task.id)?.scheduleDays).toEqual([day]);
  expect(getTask(handle.db, task.id)?.scheduleTime).toBe("10:00");

  const before = new Date(now);
  before.setDate(now.getDate() - 1);
  expect(applyScheduledAirProgress(handle.db, before)).toBe(0);
  expect(applyScheduledAirProgress(handle.db, now)).toBe(1);
  expect(getTask(handle.db, task.id)?.airProgress).toBe(1);
  expect(applyScheduledAirProgress(handle.db, new Date(now.getTime() + 60_000))).toBe(0);
  const nextWeek = new Date(now);
  nextWeek.setDate(now.getDate() + 7);
  expect(applyScheduledAirProgress(handle.db, nextWeek)).toBe(1);
  expect(getTask(handle.db, task.id)?.airProgress).toBe(2);
  handle.close();
});

it("records the completion time when a movie task completes", () => {
  const handle = createDatabase(":memory:");
  const task = createTask(handle.db, { mediaType: "movie", taskType: "ingest", title: "钢铁侠", tmdbId: 101 });
  const claimed = claimTask(handle.db, task.id, "worker-a", new Date("2026-08-10T00:00:00Z"));
  const completed = completeTask(
    handle.db,
    task.id,
    "worker-a",
    claimed!.version,
    new Date("2026-08-10T00:05:00Z"),
    "done",
  );
  expect(completed?.status).toBe("completed");
  expect(completed?.completedAt).toBe("2026-08-10T00:05:00.000Z");
  handle.close();
});

it("sweeps expired completed movie ingest tasks but keeps others", () => {
  const handle = createDatabase(":memory:");
  const movieInput = { mediaType: "movie" as const, taskType: "ingest" as const };
  const old = createTask(handle.db, { ...movieInput, title: "老片", tmdbId: 101 });
  const fresh = createTask(handle.db, { ...movieInput, title: "新片", tmdbId: 102 });
  const incomplete = createTask(handle.db, { ...movieInput, title: "未完成", tmdbId: 103 });
  const series = createTask(handle.db, {
    mediaType: "tv" as const,
    taskType: "ingest" as const,
    title: "仙逆",
    tmdbId: 3,
    contentKind: "series" as const,
  });
  const tvIngest = createTask(handle.db, {
    mediaType: "tv" as const,
    taskType: "ingest" as const,
    title: "剧集入库",
    tmdbId: 4,
  });

  const completeAt = (id: number, at: Date) => {
    const claimed = claimTask(handle.db, id, "worker-a", at);
    completeTask(handle.db, id, "worker-a", claimed!.version, at, "done");
  };
  completeAt(old.id, new Date("2026-08-10T00:00:00Z"));
  completeAt(fresh.id, new Date("2026-08-10T12:00:00Z"));
  for (const id of [series.id, tvIngest.id]) completeAt(id, new Date("2026-08-10T00:00:00Z"));
  for (const id of [old.id, fresh.id, tvIngest.id])
    handle.db.update(mediaTasks).set({ storedProgress: 1 }).where(eq(mediaTasks.id, id)).run();

  const now = new Date("2026-08-11T01:00:00Z"); // 距完成 25 小时
  const removed = sweepExpiredCompletedIngestTasks(handle.db, 24, now);
  expect(removed).toBe(2);
  expect(getTask(handle.db, old.id)).toBeNull();
  expect(getTask(handle.db, tvIngest.id)).toBeNull();
  expect(getTask(handle.db, fresh.id)).not.toBeNull();
  expect(getTask(handle.db, incomplete.id)).not.toBeNull();
  expect(getTask(handle.db, series.id)).not.toBeNull();
  handle.close();
});

it("disables the sweep when retention hours is zero", () => {
  const handle = createDatabase(":memory:");
  const movie = createTask(handle.db, { mediaType: "movie", taskType: "ingest", title: "钢铁侠", tmdbId: 101 });
  const claimed = claimTask(handle.db, movie.id, "worker-a", new Date("2026-08-10T00:00:00Z"));
  completeTask(handle.db, movie.id, "worker-a", claimed!.version, new Date("2026-08-10T00:00:00Z"), "done");
  handle.db.update(mediaTasks).set({ storedProgress: 1 }).where(eq(mediaTasks.id, movie.id)).run();
  expect(sweepExpiredCompletedIngestTasks(handle.db, 0, new Date("2026-08-11T01:00:00Z"))).toBe(0);
  expect(getTask(handle.db, movie.id)).not.toBeNull();
  handle.close();
});

it("stores contentKind for finished series/variety ingest tasks", () => {
  const handle = createDatabase(":memory:");
  const series = createTask(handle.db, {
    mediaType: "tv",
    taskType: "ingest",
    title: "剧集完结",
    tmdbId: 401,
    contentKind: "series",
  });
  const variety = createTask(handle.db, {
    mediaType: "tv",
    taskType: "ingest",
    title: "综艺完结",
    tmdbId: 402,
    contentKind: "variety",
  });
  const manual = createManualTask(handle.db, {
    mediaType: "tv",
    taskType: "ingest",
    title: "手动综艺",
    contentKind: "variety",
  });
  expect(series.contentKind).toBe("series");
  expect(variety.contentKind).toBe("variety");
  expect(manual.contentKind).toBe("variety");
  handle.close();
});

it("auto-completes a fully-stored finished series ingest task and a stored movie", () => {
  const handle = createDatabase(":memory:");
  const series = createTask(handle.db, { mediaType: "tv", taskType: "ingest", title: "剧集完结", tmdbId: 401 });
  updateTaskAirProgress(handle.db, series.id, 5);
  handle.db.update(mediaTasks).set({ storedProgress: 5 }).where(eq(mediaTasks.id, series.id)).run();
  const movie = createTask(handle.db, { mediaType: "movie", taskType: "ingest", title: "电影", tmdbId: 402 });
  handle.db.update(mediaTasks).set({ storedProgress: 1 }).where(eq(mediaTasks.id, movie.id)).run();

  const completed = completeSyncedTasks(handle.db);
  expect(completed.map((task) => task.id).sort()).toEqual([series.id, movie.id].sort());
  expect(getTask(handle.db, series.id)?.status).toBe("completed");
  expect(getTask(handle.db, series.id)?.completedAt).not.toBeNull();
  expect(getTask(handle.db, movie.id)?.status).toBe("completed");
  handle.close();
});

it("releases matched source files when deleting the only task of a media item", () => {
  const handle = createDatabase(":memory:");
  const task = createTask(handle.db, {
    mediaType: "tv",
    taskType: "ingest",
    title: "Show",
    tmdbId: 1234,
    contentKind: "series",
  });
  const taskRow = handle.db
    .select({ mediaItemId: mediaTasks.mediaItemId })
    .from(mediaTasks)
    .where(eq(mediaTasks.id, task.id))
    .get();
  const root = handle.db
    .insert(mediaRoots)
    .values({
      name: "source-root",
      mediaType: "mixed",
      containerPath: "/media/strm",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .returning({ id: mediaRoots.id })
    .get();
  const timestamp = new Date().toISOString();
  handle.db
    .insert(libraryItems)
    .values({
      mediaRootId: root.id,
      mediaItemId: taskRow!.mediaItemId,
      relativePath: "Show/Season 01/Show.S01E01.strm",
      sourceTitle: "Show",
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    .run();

  expect(deleteTask(handle.db, task.id)).toBe(true);
  const after = handle.db
    .select({ mediaItemId: libraryItems.mediaItemId, recognitionStatus: libraryItems.recognitionStatus })
    .from(libraryItems)
    .get();
  expect(after?.mediaItemId).toBeNull();
  expect(after?.recognitionStatus).toBe("unresolved");
  handle.close();
});
