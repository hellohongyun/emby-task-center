import { afterEach, describe, expect, it, vi } from "vitest";
import { createDatabase, type DatabaseHandle } from "@emby-task-center/database/client";
import { createLibraryService } from "../library/service";
import { readSettings } from "../settings/store";
import { startRuntime, type RuntimeDeps, type RuntimeHandle } from "./runtime";

describe("runtime scan scheduling", () => {
  let database: DatabaseHandle | undefined;
  let runtime: RuntimeHandle | undefined;

  afterEach(() => {
    runtime?.stop();
    database?.close();
    vi.useRealTimers();
  });

  function start(scan: () => Promise<void>) {
    database = createDatabase(":memory:");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-30T00:00:00Z"));
    const settings = readSettings(database.db, {}).values;
    settings["library.scanMode"] = "fixed";
    settings["library.scanIntervalMinutes"] = 1;
    settings["library.airProgressRefreshMinutes"] = 0;
    settings["library.missingEpisodeScanIntervalMinutes"] = 0;
    const scanEnabledRoots = vi.fn(scan);
    const refreshRoots = vi.fn(async () => ({ plan: { added: [], updated: [], removed: [] } }));
    runtime = startRuntime({
      database: database.db,
      settings,
      library: { ...createLibraryService([], undefined, database.db), scanEnabledRoots, refreshRoots },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), request: (_req, _res, next) => next() },
      // Emby/缺集扫描均关闭；空数据库没有需要请求 TMDB 的任务或库存。
      tmdb: {} as RuntimeDeps["tmdb"],
      emby: {} as RuntimeDeps["emby"],
      email: { retryPending: vi.fn(async () => undefined) } as unknown as RuntimeDeps["email"],
      trending: { stop: vi.fn() } as unknown as RuntimeDeps["trending"],
      missingEpisodeScanner: {} as RuntimeDeps["missingEpisodeScanner"],
      embyEnabled: false,
      movieTaskRetentionHours: 0,
    });
    return { scanEnabledRoots, refreshRoots };
  }

  it("does not queue more scans or root refreshes while a slow scan spans multiple ticks", async () => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const { scanEnabledRoots, refreshRoots } = start(() => pending);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(scanEnabledRoots).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(scanEnabledRoots).toHaveBeenCalledTimes(1);
    expect(refreshRoots).toHaveBeenCalledTimes(1);
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(scanEnabledRoots).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(scanEnabledRoots).toHaveBeenCalledTimes(2);
  });

  it("backs off failed physical scans even though the normal schedule remains due", async () => {
    const scan = vi
      .fn()
      .mockRejectedValueOnce(new Error("timeout"))
      .mockRejectedValueOnce(new Error("timeout"))
      .mockRejectedValueOnce(new Error("timeout"))
      .mockResolvedValue(undefined);
    const { scanEnabledRoots, refreshRoots } = start(scan);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(scanEnabledRoots).toHaveBeenCalledTimes(1);
    await runtime!.runLibraryScan("interval");
    expect(scanEnabledRoots).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(scanEnabledRoots).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(scanEnabledRoots).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(scanEnabledRoots).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect(scanEnabledRoots).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(scanEnabledRoots).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(scanEnabledRoots).toHaveBeenCalledTimes(5);
    expect(refreshRoots).toHaveBeenCalledTimes(5);
  });
});
