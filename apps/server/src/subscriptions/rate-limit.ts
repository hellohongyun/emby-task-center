/** 轻量内存限流器（重启清零；定向人群场景足够）。 */
export function createRateLimiter(limit: number, windowMs: number) {
  const hits = new Map<string, number[]>();
  // 防内存无限增长：超过该键数时强制清扫过期桶；到达上限后每次 check 都做一次窗口清扫。
  const MAX_KEYS = 10_000;
  let sweepedAt = 0;
  const SWEEP_INTERVAL_MS = 60_000;

  function prune(now: number): void {
    const cutoff = now - windowMs;
    for (const [key, times] of hits) {
      const recent = times.filter((t) => t > cutoff);
      if (recent.length > 0) hits.set(key, recent);
      else hits.delete(key);
    }
  }

  function check(key: string, now = Date.now()): boolean {
    const cutoff = now - windowMs;
    // 定期清扫 + 到达容量上限时强制清扫（O(n)，仅在容量边界触发，避免热路径退化）。
    if (now - sweepedAt >= SWEEP_INTERVAL_MS || hits.size >= MAX_KEYS) {
      prune(now);
      sweepedAt = now;
    }
    const recent = (hits.get(key) ?? []).filter((t) => t > cutoff);
    if (recent.length >= limit) {
      hits.set(key, recent);
      return false;
    }
    recent.push(now);
    hits.set(key, recent);
    return true;
  }

  return { check };
}
