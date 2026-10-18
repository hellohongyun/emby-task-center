export interface ProgressScanCycleOptions {
  scanEnabled: boolean;
  refreshProgress: () => Promise<void>;
  scanIfDue: () => Promise<void>;
  notifyPending: () => Promise<void>;
}

/** Runs a progress refresh while preserving scan-before-notify semantics. */
export async function runProgressScanCycle(options: ProgressScanCycleOptions): Promise<void> {
  await options.refreshProgress();
  if (options.scanEnabled) await options.scanIfDue();
  await options.notifyPending();
}
