export type ScanScheduleMode = "adaptive" | "fixed";

export interface ScanScheduleTask {
  id: number;
  missingCount: number;
  releaseDays?: readonly number[] | null;
  releaseTime?: string | null;
}

export interface ScanSchedulerOptions {
  mode: ScanScheduleMode;
  activeIntervalMinutes?: number;
  idleFallbackMinutes?: number;
  fixedIntervalMinutes?: number;
  episodeDelayHours?: number;
  now?: () => Date;
}

export type ScanDecisionReason = "new_gap" | "active_interval" | "idle_fallback" | "fixed_interval";

export interface ScanDecision {
  shouldScan: boolean;
  reason: ScanDecisionReason | null;
  nextScanAt: Date | null;
}

export interface ScanScheduler {
  decide(tasks: readonly ScanScheduleTask[]): ScanDecision;
  recordScan(at?: Date): void;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/**
 * Decides when a single-root library should be scanned. It does not perform a
 * scan, so existing scanner, persistence, and manual-scan semantics stay intact.
 */
export function createScanScheduler(options: ScanSchedulerOptions): ScanScheduler {
  const now = options.now ?? (() => new Date());
  const activeIntervalMs = (options.activeIntervalMinutes ?? 30) * MINUTE_MS;
  const idleFallbackMs = (options.idleFallbackMinutes ?? 12 * 60) * MINUTE_MS;
  const fixedIntervalMs = (options.fixedIntervalMinutes ?? 30) * MINUTE_MS;
  const delayMs = (options.episodeDelayHours ?? 3) * HOUR_MS;
  validateInterval(activeIntervalMs, "activeIntervalMinutes");
  validateInterval(idleFallbackMs, "idleFallbackMinutes");
  validateInterval(fixedIntervalMs, "fixedIntervalMinutes");
  validateInterval(delayMs, "episodeDelayHours", true);

  let lastScanAt = now().getTime();
  let observedMissing = new Set<number>();
  const unscannedNewGaps = new Set<number>();

  function decide(tasks: readonly ScanScheduleTask[]): ScanDecision {
    const current = now();
    const currentMs = current.getTime();
    const missing = tasks.filter((task) => task.missingCount > 0);
    const missingIds = new Set(missing.map((task) => task.id));

    for (const task of missing) {
      if (!observedMissing.has(task.id)) unscannedNewGaps.add(task.id);
    }
    for (const id of [...unscannedNewGaps]) {
      if (!missingIds.has(id)) unscannedNewGaps.delete(id);
    }
    observedMissing = missingIds;

    if (options.mode === "fixed") {
      const dueAt = lastScanAt + fixedIntervalMs;
      return decision(currentMs >= dueAt, "fixed_interval", dueAt);
    }

    if (unscannedNewGaps.size > 0) return decision(true, "new_gap", currentMs);

    const activeDueTimes = missing.map((task) => {
      const gate = scanGateAt(current, task, delayMs);
      return gate && gate.getTime() > currentMs ? gate.getTime() : lastScanAt + activeIntervalMs;
    });
    if (activeDueTimes.length > 0) {
      const dueAt = Math.min(...activeDueTimes);
      return decision(currentMs >= dueAt, "active_interval", dueAt);
    }

    const fallbackAt = lastScanAt + idleFallbackMs;
    return decision(currentMs >= fallbackAt, "idle_fallback", fallbackAt);
  }

  function recordScan(at = now()): void {
    lastScanAt = at.getTime();
    unscannedNewGaps.clear();
  }

  return { decide, recordScan };
}

function decision(shouldScan: boolean, reason: ScanDecisionReason, dueAt: number): ScanDecision {
  return { shouldScan, reason: shouldScan ? reason : null, nextScanAt: new Date(dueAt) };
}

function scanGateAt(now: Date, task: ScanScheduleTask, delayMs: number): Date | null {
  if (task.missingCount >= 2 || !task.releaseTime) return null;
  const days = task.releaseDays?.length ? [...task.releaseDays] : [];
  if (days.length === 0) return null;

  const [hours, minutes] = task.releaseTime.split(":").map(Number);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return null;
  const todayPending = days
    .filter((weekday) => weekday === now.getDay())
    .map(() => new Date(now.getFullYear(), now.getMonth(), now.getDate(), hours, minutes, 0, 0))
    .filter((candidate) => candidate.getTime() > now.getTime())
    .sort((left, right) => left.getTime() - right.getTime());
  const release =
    todayPending[0] ??
    days
      .map((weekday) => {
        let dayOffset = weekday - now.getDay();
        if (dayOffset > 0) dayOffset -= 7;
        return new Date(now.getFullYear(), now.getMonth(), now.getDate() + dayOffset, hours, minutes, 0, 0);
      })
      .sort((left, right) => right.getTime() - left.getTime())[0];
  return release ? new Date(release.getTime() + delayMs) : null;
}

function validateInterval(value: number, name: string, allowZero = false): void {
  if (!Number.isFinite(value) || (allowZero ? value < 0 : value <= 0)) {
    throw new Error(`${name} must be ${allowZero ? "zero or greater" : "greater than zero"}.`);
  }
}
