import { describe, expect, it, vi } from "vitest";

import { createScanCoordinator } from "./scan-coordinator";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

describe("scan coordinator", () => {
  it("shares one running scan with every concurrent caller", async () => {
    const pending = deferred();
    const scan = vi.fn(() => pending.promise);
    const recordScan = vi.fn();
    const coordinator = createScanCoordinator({ scan, recordScan });

    const interval = coordinator.run();
    const automation = coordinator.run();

    expect(interval).toBe(automation);
    expect(scan).toHaveBeenCalledTimes(1);
    expect(coordinator.isRunning()).toBe(true);
    pending.resolve();
    await expect(automation).resolves.toBeUndefined();
    expect(recordScan).toHaveBeenCalledTimes(1);
    expect(coordinator.isRunning()).toBe(false);
  });

  it("propagates a shared scan failure to automation and does not record it", async () => {
    const pending = deferred();
    const recordScan = vi.fn();
    const coordinator = createScanCoordinator({ scan: () => pending.promise, recordScan });
    const scheduled = coordinator.run();
    const automation = coordinator.run();

    pending.reject(new Error("disk unavailable"));
    await expect(scheduled).rejects.toThrow("disk unavailable");
    await expect(automation).rejects.toThrow("disk unavailable");
    expect(recordScan).not.toHaveBeenCalled();
  });

  it("records a successful disk scan before unrelated follow-up work", async () => {
    const events: string[] = [];
    const coordinator = createScanCoordinator({
      scan: async () => {
        events.push("scan");
      },
      recordScan: () => {
        events.push("record");
      },
    });

    await coordinator.run();
    events.push("follow-up failed");
    expect(events).toEqual(["scan", "record", "follow-up failed"]);
  });

  it("allows a new scan after the shared scan settles", async () => {
    const scan = vi.fn(async () => undefined);
    const coordinator = createScanCoordinator({ scan, recordScan: () => undefined });
    await coordinator.run();
    await coordinator.run();
    expect(scan).toHaveBeenCalledTimes(2);
  });

  it("forces a fresh scan after an in-flight scan when run(true)", async () => {
    const pending = deferred();
    const scan = vi
      .fn()
      .mockImplementationOnce(() => pending.promise)
      .mockResolvedValue(undefined);
    const recordScan = vi.fn();
    const coordinator = createScanCoordinator({ scan, recordScan });

    const first = coordinator.run();
    const forced = coordinator.run(true);
    expect(scan).toHaveBeenCalledTimes(1); // 在途时先复用/等待，不重复起新扫
    pending.resolve();
    await first;
    await forced; // 等待在途结束后重新扫一遍
    expect(scan).toHaveBeenCalledTimes(2);
    expect(recordScan).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])("coalesces a burst of forced requests after an in-flight failure=%s", async (fail) => {
    const firstScan = deferred();
    const secondScan = deferred();
    const scan = vi
      .fn()
      .mockImplementationOnce(() => firstScan.promise)
      .mockImplementationOnce(() => secondScan.promise);
    const recordScan = vi.fn();
    const recordFailure = vi.fn();
    const coordinator = createScanCoordinator({ scan, recordScan, recordFailure });
    const first = coordinator.run();
    const observedFirst = first.catch(() => undefined);
    const forced = Array.from({ length: 10 }, () => coordinator.run(true));
    expect(forced.every((promise) => promise === forced[0])).toBe(true);
    if (fail) firstScan.reject(new Error("upstream unavailable"));
    else firstScan.resolve();
    await observedFirst;
    await Promise.resolve();
    expect(scan).toHaveBeenCalledTimes(2);
    expect(coordinator.isRunning()).toBe(true);
    secondScan.resolve();
    await Promise.all(forced);
    expect(recordScan).toHaveBeenCalledTimes(fail ? 1 : 2);
    expect(recordFailure).toHaveBeenCalledTimes(fail ? 1 : 0);
    expect(coordinator.isRunning()).toBe(false);
  });

  it("records one failure when many scheduled callers share the same scan", async () => {
    const pending = deferred();
    const recordFailure = vi.fn();
    const coordinator = createScanCoordinator({
      scan: () => pending.promise,
      recordScan: vi.fn(),
      recordFailure,
    });
    const results = Promise.allSettled(Array.from({ length: 10 }, () => coordinator.run()));
    pending.reject(new Error("upstream unavailable"));
    expect((await results).every((result) => result.status === "rejected")).toBe(true);
    expect(recordFailure).toHaveBeenCalledTimes(1);
  });
});
