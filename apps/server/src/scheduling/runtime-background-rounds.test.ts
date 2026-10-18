import { afterEach, describe, expect, it, vi } from "vitest";
import { createDatabase, type DatabaseHandle } from "@emby-task-center/database/client";
import { createLibraryService } from "../library/service";
import { readSettings } from "../settings/store";
import { startRuntime, type RuntimeDeps, type RuntimeHandle } from "./runtime";

const { activity, link } = vi.hoisted(() => ({ activity: vi.fn(), link: vi.fn() }));
vi.mock("../usage/activity-log", () => ({ syncEmbyActivityLog: activity }));
vi.mock("../subscriptions/emby-member-sync", () => ({ linkOrphanEmbyUsers: link }));

function deferred() {
  let resolve!: (value: unknown) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe("runtime activity and member binding rounds", () => {
  let database: DatabaseHandle;
  let runtime: RuntimeHandle;
  const activityResult = { unsupported: false, fetched: 0, inserted: 0, unknown: 0 };
  const linkResult = { linked: [], adopted: [], skipped: [] };

  function start() {
    database = createDatabase(":memory:");
    const settings = readSettings(database.db, {}).values;
    settings["library.scanIntervalMinutes"] = 0;
    settings["library.airProgressRefreshMinutes"] = 0;
    settings["library.missingEpisodeScanIntervalMinutes"] = 0;
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), request: vi.fn() };
    runtime = startRuntime({
      database: database.db,
      settings,
      library: createLibraryService([], undefined, database.db),
      logger,
      tmdb: {} as RuntimeDeps["tmdb"],
      emby: { configured: false } as RuntimeDeps["emby"],
      email: { retryPending: vi.fn(async () => undefined) } as unknown as RuntimeDeps["email"],
      trending: { stop: vi.fn() } as unknown as RuntimeDeps["trending"],
      missingEpisodeScanner: {} as RuntimeDeps["missingEpisodeScanner"],
      embyEnabled: true,
      movieTaskRetentionHours: 0,
    });
    return logger;
  }

  afterEach(() => {
    runtime?.stop();
    database?.close();
    vi.useRealTimers();
    vi.resetAllMocks();
  });

  for (const [name, task, result] of [
    ["activity", activity, activityResult],
    ["link", link, linkResult],
  ] as const) {
    it(`${name} drops slow ticks and resumes only on the next interval`, async () => {
      vi.useFakeTimers();
      activity.mockResolvedValue(activityResult);
      link.mockResolvedValue(linkResult);
      const pending = deferred();
      task.mockReturnValueOnce(pending.promise);
      start();
      await vi.advanceTimersByTimeAsync(25 * 60_000);
      expect(task).toHaveBeenCalledTimes(1);
      pending.resolve(result);
      await vi.advanceTimersByTimeAsync(0);
      expect(task).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(task).toHaveBeenCalledTimes(2);
    });

    it(`${name} releases a failed round for the next interval`, async () => {
      vi.useFakeTimers();
      activity.mockResolvedValue(activityResult);
      link.mockResolvedValue(linkResult);
      const pending = deferred();
      task.mockReturnValueOnce(pending.promise);
      const logger = start();
      await vi.advanceTimersByTimeAsync(15 * 60_000);
      expect(task).toHaveBeenCalledTimes(1);
      pending.reject(new Error("upstream failure"));
      await vi.advanceTimersByTimeAsync(0);
      if (name === "activity")
        expect(logger.warn).toHaveBeenCalledWith(
          expect.objectContaining({ event: "member_usage_activity_sync_failed" }),
        );
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(task).toHaveBeenCalledTimes(2);
    });

    it.each(["resolve", "reject"])(`${name} never restarts after stop and late %s`, async (outcome) => {
      vi.useFakeTimers();
      activity.mockResolvedValue(activityResult);
      link.mockResolvedValue(linkResult);
      const pending = deferred();
      task.mockReturnValueOnce(pending.promise);
      start();
      runtime.stop();
      if (outcome === "resolve") pending.resolve(result);
      else pending.reject(new Error("late failure"));
      await vi.advanceTimersByTimeAsync(30 * 60_000);
      expect(task).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    });
  }

  it("warns only once and stops requesting unsupported activity logs", async () => {
    vi.useFakeTimers();
    activity.mockResolvedValue({ ...activityResult, unsupported: true });
    link.mockResolvedValue(linkResult);
    const logger = start();
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(activity).toHaveBeenCalledTimes(1);
    expect(
      logger.warn.mock.calls.filter(([entry]) => entry.event === "member_usage_activity_log_unsupported"),
    ).toHaveLength(1);
  });
});
