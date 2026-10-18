import type { EmbyClient } from "./emby-client";

/** Link decoration must not hold up a locally available snapshot. */
export function createCachedEmbyServerId(emby: EmbyClient | undefined, connection: () => string) {
  let key: string | undefined;
  let generation = 0;
  let value: string | null = null;
  let retryAt = 0;
  let pending = false;
  return (): string | null => {
    if (!emby?.configured) return null;
    const currentKey = connection();
    if (key !== currentKey) {
      key = currentKey;
      generation += 1;
      value = null;
      retryAt = 0;
      pending = false;
    }
    if (!pending && Date.now() >= retryAt) {
      const current = generation;
      pending = true;
      void Promise.resolve()
        .then(() => emby.systemInfo())
        .then((info) => {
          if (current !== generation) return;
          const id = typeof info.id === "string" && info.id.trim() ? info.id : null;
          if (id) value = id;
          retryAt = Date.now() + (id ? 10 * 60_000 : 30_000);
        })
        .catch(() => {
          if (current === generation) retryAt = Date.now() + 30_000;
        })
        .finally(() => {
          if (current === generation) pending = false;
        });
    }
    return value;
  };
}
