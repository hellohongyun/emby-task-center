export interface ScanCoordinatorOptions {
  scan: () => Promise<void>;
  recordScan: () => void;
  recordFailure?: (error: unknown) => void;
}

export interface ScanCoordinator {
  run(force?: boolean): Promise<void>;
  isRunning(): boolean;
}

/**
 * Serializes complete-library scans without treating a concurrent request as
 * success. Every caller awaits the same physical scan and observes its error.
 */
export function createScanCoordinator(options: ScanCoordinatorOptions): ScanCoordinator {
  let running: Promise<void> | null = null;
  let queued: Promise<void> | null = null;

  function run(force = false): Promise<void> {
    // 强制请求合并成至多一轮后续扫描；多个 .then(startScan) 会在当前轮完成时并发起扫。
    if (force && running) {
      if (!queued) {
        const next = () => {
          queued = null;
          return run();
        };
        queued = running.then(next, next);
      }
      return queued;
    }
    if (running) return running;
    return startScan();
  }

  function startScan(): Promise<void> {
    const scan = (async () => {
      try {
        await options.scan();
      } catch (error) {
        options.recordFailure?.(error);
        throw error;
      }
      // Record the physical scan as soon as it succeeds. Follow-up metadata or
      // notification failures must not make the scheduler repeat disk IO.
      options.recordScan();
    })();
    const shared = scan.finally(() => {
      if (running === shared) running = null;
    });
    running = shared;
    return shared;
  }

  return { run, isRunning: () => running !== null };
}
