import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

import { createDatabase } from "@emby-task-center/database/client";
import { mediaTasks } from "@emby-task-center/database/schema";
import {
  createManualTask,
  createTask,
  getTask,
  listTaskSeasons,
  updateTaskSchedule,
} from "@emby-task-center/task-domain/task-service";
import type { TmdbClient } from "../tmdb/client";
import { applyScheduledAirProgressCycle, refreshAirProgressCycle } from "./progress-cycle";

/** 只实现被调用到的两个方法；其它方法不该被走到，走到就抛错（避免用例悄悄依赖多余调用）。 */
function tmdbStub(overrides: Partial<TmdbClient>): TmdbClient {
  return {
    search: async () => [],
    details: async () => {
      throw new Error("not used");
    },
    seasonProgress: async () => {
      throw new Error("not used");
    },
    seasonEpisodes: async () => {
      throw new Error("not used");
    },
    airedEpisodeCount: async () => {
      throw new Error("not used");
    },
    ...overrides,
  };
}

describe("progress refresh cycles", () => {
  it("aligns the aired episode count of an unfinished ingest task with TMDB", async () => {
    const handle = createDatabase(":memory:");
    const task = createTask(handle.db, {
      mediaType: "tv",
      taskType: "ingest",
      title: "TMDB Show",
      tmdbId: 101,
    });
    const tmdb = tmdbStub({ airedEpisodeCount: vi.fn().mockResolvedValue(2) });

    await refreshAirProgressCycle(handle.db, tmdb);

    // 结果：已播数跟着 TMDB 走，已存仍为 0 → 缺集看得见（这就是入库任务的缺集检查）。
    expect(getTask(handle.db, task.id)).toMatchObject({
      airProgress: 2,
      storedProgress: null,
      missingEpisodes: [1, 2],
    });
    handle.close();
  });

  it("refreshes per-season progress and skips already completed tasks", async () => {
    const handle = createDatabase(":memory:");
    const running = createTask(handle.db, {
      mediaType: "tv",
      taskType: "ingest",
      title: "分季剧集",
      tmdbId: 555,
      seasonNumber: 1,
    });
    const done = createTask(handle.db, { mediaType: "tv", taskType: "ingest", title: "已完结", tmdbId: 202 });
    handle.db
      .update(mediaTasks)
      .set({ status: "completed", airProgress: 1, storedProgress: 1 })
      .where(eq(mediaTasks.id, done.id))
      .run();
    const airedEpisodeCount = vi.fn().mockResolvedValue(99);
    const tmdb = tmdbStub({
      airedEpisodeCount,
      seasonProgress: vi.fn().mockResolvedValue({ seasonNumber: 1, airedEpisodes: 12 }),
    });

    await refreshAirProgressCycle(handle.db, tmdb);

    // 已完成的任务不再轮询（追更整体下线后只剩"入库未完成前检查"这一半）。
    expect(airedEpisodeCount).not.toHaveBeenCalled();
    expect(getTask(handle.db, done.id)).toMatchObject({ airProgress: 1, storedProgress: 1, status: "completed" });
    // 未完成的分季任务：整剧口径与分季行都要跟着更新。
    expect(getTask(handle.db, running.id)).toMatchObject({ airProgress: 12 });
    expect(listTaskSeasons(handle.db, running.id)).toMatchObject([{ seasonNumber: 1, airProgress: 12 }]);
    handle.close();
  });

  it("bumps the aired count on the configured weekly schedule", () => {
    const handle = createDatabase(":memory:");
    const now = new Date(2026, 7, 14, 10, 0);
    const task = createManualTask(handle.db, {
      mediaType: "tv",
      taskType: "ingest",
      title: "Scheduled Show",
      releaseYear: 2022,
    });
    updateTaskSchedule(handle.db, task.id, [now.getDay()], "10:00");

    const result = applyScheduledAirProgressCycle(handle.db, now);

    expect(result.updated).toBe(1);
    expect(getTask(handle.db, task.id)).toMatchObject({ airProgress: 1 });
    // 同一天再跑一次不重复加（schedule_applied_key 记住今天已经加过）。
    expect(applyScheduledAirProgressCycle(handle.db, now).updated).toBe(0);
    handle.close();
  });
});
