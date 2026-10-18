import { describe, expect, it } from "vitest";

import { createScanScheduler, type ScanScheduleTask } from "./scan-scheduler";

function clock(iso = "2026-08-16T10:00:00+08:00") {
  let value = new Date(iso);
  return {
    now: () => value,
    advance: (minutes: number) => {
      value = new Date(value.getTime() + minutes * 60_000);
    },
  };
}

const gap = (overrides: Partial<ScanScheduleTask> = {}): ScanScheduleTask => ({ id: 1, missingCount: 1, ...overrides });

describe("adaptive scan scheduler", () => {
  it("scans a newly observed gap immediately, then follows the active interval", () => {
    const time = clock();
    const scheduler = createScanScheduler({ mode: "adaptive", now: time.now });

    expect(scheduler.decide([gap()])).toMatchObject({ shouldScan: true, reason: "new_gap" });
    scheduler.recordScan();
    expect(scheduler.decide([gap()]).shouldScan).toBe(false);
    time.advance(30);
    expect(scheduler.decide([gap()])).toMatchObject({ shouldScan: true, reason: "active_interval" });
  });

  it("after the first gap scan waits for the release gate when only one episode is missing", () => {
    const time = clock("2026-08-16T17:00:00+08:00"); // Sunday, before release
    const scheduler = createScanScheduler({ mode: "adaptive", episodeDelayHours: 4, now: time.now });
    const task = gap({ releaseDays: [0], releaseTime: "18:00" });

    expect(scheduler.decide([task]).reason).toBe("new_gap");
    scheduler.recordScan();
    time.advance(30);
    expect(scheduler.decide([task]).shouldScan).toBe(false);
    time.advance(270);
    expect(scheduler.decide([task])).toMatchObject({ shouldScan: true, reason: "active_interval" });
  });

  it("does not gate two missing episodes or a task without release settings", () => {
    const time = clock();
    const scheduler = createScanScheduler({ mode: "adaptive", now: time.now });
    scheduler.decide([gap({ missingCount: 2, releaseDays: [0], releaseTime: "23:00" })]);
    scheduler.recordScan();
    time.advance(30);
    expect(scheduler.decide([gap({ missingCount: 2, releaseDays: [0], releaseTime: "23:00" })]).shouldScan).toBe(true);

    scheduler.recordScan();
    time.advance(30);
    expect(scheduler.decide([gap({ releaseTime: null })]).shouldScan).toBe(true);
  });

  it("stops active scans after synchronization and uses the idle fallback", () => {
    const time = clock();
    const scheduler = createScanScheduler({ mode: "adaptive", idleFallbackMinutes: 120, now: time.now });
    scheduler.decide([gap()]);
    scheduler.recordScan();
    time.advance(119);
    expect(scheduler.decide([]).shouldScan).toBe(false);
    time.advance(1);
    expect(scheduler.decide([])).toMatchObject({ shouldScan: true, reason: "idle_fallback" });
  });

  it("treats a later gap on the same task as new after it was synchronized", () => {
    const time = clock();
    const scheduler = createScanScheduler({ mode: "adaptive", now: time.now });
    scheduler.decide([gap()]);
    scheduler.recordScan();
    expect(scheduler.decide([]).shouldScan).toBe(false);
    expect(scheduler.decide([gap()]).reason).toBe("new_gap");
  });
});

describe("fixed scan scheduler", () => {
  it("preserves a fixed interval regardless of task state", () => {
    const time = clock();
    const scheduler = createScanScheduler({ mode: "fixed", fixedIntervalMinutes: 30, now: time.now });
    time.advance(29);
    expect(scheduler.decide([gap()]).shouldScan).toBe(false);
    time.advance(1);
    expect(scheduler.decide([])).toMatchObject({ shouldScan: true, reason: "fixed_interval" });
    scheduler.recordScan();
    expect(scheduler.decide([]).shouldScan).toBe(false);
  });
});
