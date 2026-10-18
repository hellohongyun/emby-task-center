import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

import { createDatabase } from "@emby-task-center/database/client";
import { mediaTasks, taskSeasons } from "@emby-task-center/database/schema";
import { createTask, getTask } from "@emby-task-center/task-domain/task-service";
import type { TmdbClient } from "../tmdb/client";
import { refreshTvTaskAirProgress } from "./air-progress";

describe("refreshTvTaskAirProgress", () => {
  it("refreshes a season-scoped task from its season aired count", async () => {
    const handle = createDatabase(":memory:");
    const task = createTask(handle.db, {
      mediaType: "tv",
      taskType: "ingest",
      title: "Battle Through the Heavens",
      tmdbId: 79481,
      seasonNumber: 5,
    });
    const seasonProgress = vi.fn<TmdbClient["seasonProgress"]>().mockResolvedValue({
      seasonNumber: 5,
      airedEpisodes: 207,
      totalEpisodes: 219,
      lastAirDate: "2026-08-08",
      nextAirDate: "2026-08-15",
    });
    const airedEpisodeCount = vi.fn<TmdbClient["airedEpisodeCount"]>();
    const tmdb: TmdbClient = {
      search: async () => [],
      details: async () => {
        throw new Error("not used");
      },
      seasonProgress,
      seasonEpisodes: async () => {
        throw new Error("not used");
      },
      airedEpisodeCount,
    };

    await refreshTvTaskAirProgress(handle.db, tmdb);

    // 后两个入参是「今日更新」宽限期：判定时刻 + 宽限小时数（设置项 library.missingGraceHours 默认 24）。
    expect(seasonProgress).toHaveBeenCalledWith(79481, 5, expect.any(Date), 24);
    expect(airedEpisodeCount).not.toHaveBeenCalled();
    expect(getTask(handle.db, task.id)?.airProgress).toBe(207);
    handle.close();
  });

  it("refreshes every season row of a whole-series task", async () => {
    const handle = createDatabase(":memory:");
    const task = createTask(handle.db, { mediaType: "tv", taskType: "ingest", title: "凡人修仙传", tmdbId: 106449 });
    const timestamp = "2026-09-15T00:00:00.000Z";
    // 整剧任务的分季行（建任务时按 TMDB 分季写好）：旧实现只刷新 season 0，这两行会一直停在旧值。
    handle.db
      .insert(taskSeasons)
      .values([
        {
          taskId: task.id,
          seasonNumber: 1,
          status: "tracking",
          airProgress: 191,
          lastCheckAt: timestamp,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
        {
          taskId: task.id,
          seasonNumber: 2,
          status: "tracking",
          airProgress: 30,
          lastCheckAt: timestamp,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      ])
      .run();
    const seasonProgress = vi.fn<TmdbClient["seasonProgress"]>().mockImplementation(async (_tvId, seasonNumber) => ({
      seasonNumber,
      airedEpisodes: seasonNumber === 1 ? 192 : 31,
      totalEpisodes: 206,
      lastAirDate: null,
      nextAirDate: null,
    }));
    const airedEpisodeCount = vi.fn<TmdbClient["airedEpisodeCount"]>();
    const tmdb: TmdbClient = {
      search: async () => [],
      details: async () => ({
        id: 106449,
        mediaType: "tv",
        title: "凡人修仙传",
        originalTitle: "凡人修仙传",
        releaseYear: 2020,
        overview: "",
        posterUrl: null,
        backdropUrl: null,
        seasons: [
          { seasonNumber: 1, name: "第 1 季", episodeCount: 206, airDate: "2020-07-25" },
          { seasonNumber: 2, name: "第 2 季", episodeCount: 30, airDate: "2027-01-01" },
        ],
      }),
      seasonProgress,
      seasonEpisodes: async () => [],
      airedEpisodeCount,
    };

    await refreshTvTaskAirProgress(handle.db, tmdb);

    // 任务总数 = 各季之和；两行分季进度都要跟上
    expect(getTask(handle.db, task.id)?.airProgress).toBe(223);
    const rows = handle.db.select().from(taskSeasons).where(eq(taskSeasons.taskId, task.id)).all();
    expect(rows.find((row) => row.seasonNumber === 1)).toMatchObject({ airProgress: 192 });
    expect(rows.find((row) => row.seasonNumber === 2)).toMatchObject({ airProgress: 31 });
    expect(airedEpisodeCount).not.toHaveBeenCalled();
    handle.close();
  });

  it("updates aired progress for every unfinished task and tolerates one failing series", async () => {
    const handle = createDatabase(":memory:");
    const first = createTask(handle.db, { mediaType: "tv", taskType: "ingest", title: "仙逆", tmdbId: 1 });
    const second = createTask(handle.db, { mediaType: "tv", taskType: "ingest", title: "斗罗", tmdbId: 2 });
    // 已完成的任务不再轮询：追更整体下线（2026-09）后，播出进度检查只服务"入库未完成前"。
    const done = createTask(handle.db, { mediaType: "tv", taskType: "ingest", title: "已入库", tmdbId: 3 });
    handle.db.update(mediaTasks).set({ status: "completed" }).where(eq(mediaTasks.id, done.id)).run();
    const airedEpisodeCount = vi
      .fn()
      .mockResolvedValueOnce(153)
      .mockRejectedValueOnce(new Error("tmdb down"))
      .mockResolvedValueOnce(999);
    const tmdb: TmdbClient = {
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
      airedEpisodeCount,
    };

    await refreshTvTaskAirProgress(handle.db, tmdb);

    expect(getTask(handle.db, first.id)?.airProgress).toBe(153);
    // 一部剧查不通不能挡住其它任务。
    expect(getTask(handle.db, second.id)?.airProgress).toBeNull();
    expect(getTask(handle.db, done.id)?.airProgress).toBeNull();
    handle.close();
  });
});
