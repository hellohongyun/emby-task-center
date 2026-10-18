/** Manual and scheduled callers sharing a database join the same in-flight work. */
export function createDatabaseSingleFlight<Key extends object, Args extends unknown[], Result>(
  task: (key: Key, ...args: Args) => Promise<Result>,
): (key: Key, ...args: Args) => Promise<Result> {
  const pending = new WeakMap<Key, Promise<Result>>();
  return (key, ...args) => {
    const existing = pending.get(key);
    if (existing) return existing;
    const promise = task(key, ...args).finally(() => {
      if (pending.get(key) === promise) pending.delete(key);
    });
    pending.set(key, promise);
    return promise;
  };
}
