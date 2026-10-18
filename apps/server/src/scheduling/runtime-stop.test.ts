import { afterEach, describe, expect, it, vi } from "vitest";
import { createDatabase, type DatabaseHandle } from "@emby-task-center/database/client";
import { createLibraryService } from "../library/service";
import { writeSettings, readSettings } from "../settings/store";
import { startRuntime, type RuntimeDeps, type RuntimeHandle } from "./runtime";

const { enforce } = vi.hoisted(() => ({ enforce: vi.fn() }));
vi.mock("../subscriptions/stream-guard", () => ({ enforceStreamLimits: enforce }));

describe("runtime shutdown during a pending watchdog tick", () => {
  let database: DatabaseHandle;
  let runtime: RuntimeHandle;
  afterEach(() => {
    runtime?.stop();
    database?.close();
    vi.useRealTimers();
    enforce.mockReset();
  });

  it.each(["resolve", "reject"])("does not schedule another tick after a late %s", async (outcome) => {
    database = createDatabase(":memory:");
    writeSettings(database.db, { "concurrencyPolicy.interruptStreams": true });
    const settings = readSettings(database.db, {}).values;
    settings["library.scanIntervalMinutes"] = 0;
    settings["library.airProgressRefreshMinutes"] = 0;
    settings["library.missingEpisodeScanIntervalMinutes"] = 0;
    vi.useFakeTimers();
    let resolve!: (value: unknown) => void;
    let reject!: (error: Error) => void;
    enforce.mockImplementation(
      () =>
        new Promise((done, fail) => {
          resolve = done;
          reject = fail;
        }),
    );
    const shutdown = vi.fn();
    runtime = startRuntime({
      database: database.db,
      settings,
      library: createLibraryService([], undefined, database.db),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), request: (_req, _res, next) => next() },
      tmdb: {} as RuntimeDeps["tmdb"],
      emby: { configured: false } as RuntimeDeps["emby"],
      email: { retryPending: vi.fn(async () => undefined) } as unknown as RuntimeDeps["email"],
      trending: { stop: vi.fn() } as unknown as RuntimeDeps["trending"],
      missingEpisodeScanner: {
        run: vi.fn(async () => undefined),
        status: () => ({ missingShows: 0, missingEpisodes: 0 }),
      } as unknown as RuntimeDeps["missingEpisodeScanner"],
      embyEnabled: true,
      movieTaskRetentionHours: 0,
      onShutdown: [shutdown],
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(enforce).toHaveBeenCalledTimes(1);
    runtime.stop();
    runtime.stop();
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    if (outcome === "resolve") resolve({ stopped: 0, playingUsers: 0, stoppedSessions: [] });
    else reject(new Error("late upstream timeout"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(enforce).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
