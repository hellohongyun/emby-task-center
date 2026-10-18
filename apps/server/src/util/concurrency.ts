/**
 * 带并发上限的 map（P4：原为 routes/tasks.ts 里的私有工具）。
 *
 * 服务端多处需要"对一批条目并发调用外部接口，但不要打爆对端"，
 * 抽到 util 后路由可以复用同一份实现。
 */
export async function mapWithLimit<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  async function run(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => run()));
  return results;
}
