import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDatabase, type DatabaseHandle } from "@emby-task-center/database/client";
import { startMediaRequestRetention, MEDIA_REQUEST_RETENTION_INTERVAL_MS as HOUR } from "./media-request-retention";
import { startRuntime, type RuntimeDeps } from "./runtime";
import { createLibraryService } from "../library/service";
import { readSettings } from "../settings/store";

const { sweep } = vi.hoisted(() => ({ sweep: vi.fn() }));
vi.mock("../media-requests/retention", () => ({ sweepExpiredMediaRequests: sweep }));

describe("media request retention scheduling", () => {
  let database: DatabaseHandle;
  let stop: (() => void) | undefined;
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), request: vi.fn() };
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    database = createDatabase(":memory:");
    sweep.mockReset().mockReturnValue(0);
    vi.mocked(logger.info).mockReset();
    vi.mocked(logger.error).mockReset();
  });
  afterEach(() => {
    stop?.();
    stop = undefined;
    database.close();
    vi.useRealTimers();
  });
  it("sweeps immediately and hourly, logs only positive deletion counts, and clears its timer", async () => {
    sweep.mockReturnValueOnce(2);
    stop = startMediaRequestRetention(database.db, logger);
    expect(sweep).toHaveBeenCalledWith(database.db, new Date("2030-01-01T00:00:00.000Z"));
    await vi.advanceTimersByTimeAsync(0);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "media_request_retention_completed",
        detail: JSON.stringify({ deleted: 2 }),
      }),
    );
    await vi.advanceTimersByTimeAsync(HOUR - 1);
    expect(sweep).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sweep).toHaveBeenCalledTimes(2);
    expect(logger.info).toHaveBeenCalledTimes(1);
    stop();
    stop();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(HOUR * 2);
    expect(sweep).toHaveBeenCalledTimes(2);
  });
  it("records a failed startup round without throwing and tries again on the next hour", async () => {
    sweep.mockImplementationOnce(() => {
      throw new Error("fixture SQLite unavailable");
    });
    expect(() => {
      stop = startMediaRequestRetention(database.db, logger);
    }).not.toThrow();
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ event: "media_request_retention_failed" }));
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(sweep).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalledTimes(1);
  });
  it("drops overlapping ticks while a round is pending instead of queuing more cleanup", async () => {
    let finish!: (value: number) => void;
    sweep.mockImplementationOnce(
      () =>
        new Promise<number>((resolve) => {
          finish = resolve;
        }),
    );
    stop = startMediaRequestRetention(database.db, logger);
    await vi.advanceTimersByTimeAsync(HOUR * 3);
    expect(sweep).toHaveBeenCalledTimes(1);
    finish(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(sweep).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(sweep).toHaveBeenCalledTimes(2);
  });
  it.each(["resolve", "reject"])("does not log or reschedule after stop and a late %s", async (outcome) => {
    let finish!: (value: number) => void;
    let fail!: (error: Error) => void;
    sweep.mockImplementationOnce(
      () =>
        new Promise<number>((resolve, reject) => {
          finish = resolve;
          fail = reject;
        }),
    );
    stop = startMediaRequestRetention(database.db, logger);
    stop();
    if (outcome === "resolve") finish(4);
    else fail(new Error("late fixture failure"));
    await vi.advanceTimersByTimeAsync(HOUR * 2);
    expect(sweep).toHaveBeenCalledTimes(1);
    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("is started by the production runtime and stopped with the runtime handle", async () => {
    const settings = readSettings(database.db, {}).values;
    settings["library.scanIntervalMinutes"] = 0;
    settings["library.airProgressRefreshMinutes"] = 0;
    settings["library.missingEpisodeScanIntervalMinutes"] = 0;
    const runtime = startRuntime({
      database: database.db,
      settings,
      logger,
      library: createLibraryService([], undefined, database.db),
      tmdb: {} as RuntimeDeps["tmdb"],
      emby: { configured: false } as RuntimeDeps["emby"],
      email: { retryPending: vi.fn(async () => undefined) } as unknown as RuntimeDeps["email"],
      trending: { stop: vi.fn() } as unknown as RuntimeDeps["trending"],
      missingEpisodeScanner: {} as RuntimeDeps["missingEpisodeScanner"],
      embyEnabled: false,
      movieTaskRetentionHours: 0,
    });
    stop = () => runtime.stop();
    expect(sweep).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(sweep).toHaveBeenCalledTimes(2);
    runtime.stop();
    runtime.stop();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(sweep).toHaveBeenCalledTimes(2);
  });
});
