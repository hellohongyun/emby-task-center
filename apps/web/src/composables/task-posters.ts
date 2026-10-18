import type { Task } from "../types";
import { fetchJsonWithTimeout } from "./request-timeout";

export class PosterUnauthorizedError extends Error {}

/** Per-session cache and bounded, shared requests; posters never hold up task rows. */
export function createTaskPosters(fetchImpl: typeof fetch) {
  const cache = new Map<string, { url: string | null; expires: number }>();
  const pending = new Map<string, Promise<string | null>>();
  const controllers = new Set<AbortController>();
  const queue: Array<() => void> = [];
  let active = 0;
  let stopped = false;
  const key = (task: Task) => `${task.mediaType}/${task.tmdbId}`;

  function cached(task: Task): string | null {
    const value = cache.get(key(task));
    return value && value.expires > Date.now() ? value.url : null;
  }

  function get(task: Task): Promise<string | null> {
    const id = key(task);
    const entry = cache.get(id);
    if (entry && entry.expires > Date.now()) return Promise.resolve(entry.url);
    if (pending.has(id)) return pending.get(id)!;
    const promise = new Promise<string | null>((resolve, reject) => {
      queue.push(() => {
        if (stopped) {
          resolve(null);
          return;
        }
        active += 1;
        const controller = new AbortController();
        controllers.add(controller);
        void fetchJsonWithTimeout<{ result?: { posterUrl?: string | null } }>(
          fetchImpl,
          `/api/tmdb/${id}`,
          {
            credentials: "include",
            signal: controller.signal,
          },
          8_000,
        )
          .then(({ response, body }) => {
            if (response.status === 401) throw new PosterUnauthorizedError();
            if (!response.ok) return null;
            return body?.result?.posterUrl ?? null;
          })
          .catch((error) => {
            if (error instanceof PosterUnauthorizedError) throw error;
            return null;
          })
          .then((url) => {
            cache.set(id, { url, expires: Date.now() + (url ? 3_600_000 : 60_000) });
            resolve(url);
          }, reject)
          .finally(() => {
            active -= 1;
            controllers.delete(controller);
            pending.delete(id);
            drain();
          });
      });
    });
    pending.set(id, promise);
    drain();
    return promise;
  }

  function drain() {
    while (active < 3 && queue.length) queue.shift()!();
  }

  function stop() {
    stopped = true;
    controllers.forEach((controller) => controller.abort());
    while (queue.length) queue.shift()!();
  }

  return { cached, get, stop };
}
