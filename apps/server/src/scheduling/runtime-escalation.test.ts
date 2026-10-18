import { afterEach, describe, expect, it, vi } from "vitest";
import { createDatabase, type DatabaseHandle } from "@emby-task-center/database/client";
import { createLibraryService } from "../library/service";
import { readSettings } from "../settings/store";
import type { EscalationOutcome } from "../subscriptions/concurrency-escalation";
import { startRuntime, type RuntimeDeps, type RuntimeHandle } from "./runtime";

const { enforce } = vi.hoisted(() => ({ enforce: vi.fn() }));
vi.mock("../subscriptions/concurrency-escalation", () => ({
  ESCALATION_TICK_MS: 10_000,
  enforceConcurrencyEscalation: enforce,
}));

const emptyOutcome = (): EscalationOutcome => ({
  reminded: [],
  frozen: [],
  released: [],
  terminated: 0,
  failures: [],
  reasserted: [],
});

function deferred() {
  let resolve!: (value: EscalationOutcome) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<EscalationOutcome>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe("runtime escalation scheduling", () => {
  let database: DatabaseHandle;
  let runtime: RuntimeHandle;

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
      missingEpisodeScanner: {
        run: vi.fn(async () => undefined),
        status: () => ({ missingShows: 0, missingEpisodes: 0 }),
      } as unknown as RuntimeDeps["missingEpisodeScanner"],
      embyEnabled: true,
      movieTaskRetentionHours: 0,
    });
    return logger;
  }

  afterEach(() => {
    runtime?.stop();
    database?.close();
    vi.useRealTimers();
    enforce.mockReset();
  });

  it("drops three ticks during a slow round without queuing another round", async () => {
    vi.useFakeTimers();
    const pending = deferred();
    enforce.mockReturnValueOnce(pending.promise).mockResolvedValue(emptyOutcome());
    const logger = start();
    await vi.advanceTimersByTimeAsync(35_000);
    expect(enforce).toHaveBeenCalledTimes(1);
    pending.resolve({ ...emptyOutcome(), reminded: ["member@example.test"] });
    await vi.advanceTimersByTimeAsync(0);
    expect(enforce).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith({
      event: "concurrency_escalation",
      message: "提醒 member@example.test",
    });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(enforce).toHaveBeenCalledTimes(2);
  });

  it("allows the next scheduled tick after a failed round", async () => {
    vi.useFakeTimers();
    const pending = deferred();
    enforce.mockReturnValueOnce(pending.promise).mockResolvedValue(emptyOutcome());
    start();
    await vi.advanceTimersByTimeAsync(25_000);
    expect(enforce).toHaveBeenCalledTimes(1);
    pending.reject(new Error("upstream failed"));
    await vi.advanceTimersByTimeAsync(0);
    expect(enforce).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(enforce).toHaveBeenCalledTimes(2);
  });

  it.each(["resolve", "reject"])("does not restart after stopping a pending round that later %s", async (result) => {
    vi.useFakeTimers();
    const pending = deferred();
    enforce.mockReturnValue(pending.promise);
    start();
    expect(enforce).toHaveBeenCalledTimes(1);
    runtime.stop();
    runtime.stop();
    if (result === "resolve") pending.resolve(emptyOutcome());
    else pending.reject(new Error("late upstream failed"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(enforce).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
