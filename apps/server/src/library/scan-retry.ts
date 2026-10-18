/** 全库扫描失败的退避与正常扫描周期分开；成功后恢复正常调度。 */
export function createScanRetryGate(now = Date.now) {
  let failures = 0;
  let retryAt = 0;
  return {
    canAttempt: () => now() >= retryAt,
    succeeded() {
      failures = 0;
      retryAt = 0;
    },
    failed() {
      failures += 1;
      retryAt = now() + Math.min(30 * 60_000, 60_000 * 2 ** Math.min(failures - 1, 5));
    },
  };
}
