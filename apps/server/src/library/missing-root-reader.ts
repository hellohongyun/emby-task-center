import { existsSync } from "node:fs";
import { Worker } from "node:worker_threads";
import type BetterSqlite3 from "better-sqlite3";
import type { AppDatabase } from "@emby-task-center/database/client";
import { readRootMissingEpisodes, resolveMissingEpisodeRoot, type MissingEpisodeRoot } from "./missing-root-scope";

export type MissingRootReadOptions = NonNullable<Parameters<typeof readRootMissingEpisodes>[2]>;
export type MissingRootReadResult = ReturnType<typeof readRootMissingEpisodes>;
export interface MissingRootReadRequest {
  id: number;
  root: MissingEpisodeRoot;
  options: MissingRootReadOptions;
}

/** One transaction keeps inventory, metadata and enabled-root validation in the same snapshot. */
export function readMissingRootSnapshot(
  database: AppDatabase,
  root: MissingEpisodeRoot,
  options: MissingRootReadOptions,
) {
  return database.transaction((tx) => {
    const current = resolveMissingEpisodeRoot(tx, root.rootId);
    if (!current || current.id !== root.id || current.containerPath !== root.containerPath) {
      throw new Error("missing_root_changed");
    }
    return readRootMissingEpisodes(tx, current, options);
  });
}

/** Reuses one readonly worker, without caching finished results. */
export function createMissingRootReader(
  database: AppDatabase,
  workerUrl = new URL("./missing-root-worker.mjs", import.meta.url),
) {
  const raw = (database as unknown as { $client: BetterSqlite3.Database }).$client;
  const useWorker = raw.name !== ":memory:" && existsSync(workerUrl);
  let worker: Worker | null = null;
  let closing: Promise<void> | undefined;
  let closed = false;
  let sequence = 0;
  let idleTimer: NodeJS.Timeout | undefined;
  const inflight = new Map<string, Promise<MissingRootReadResult>>();
  const pending = new Map<
    number,
    { resolve(value: MissingRootReadResult): void; reject(error: Error): void; timer: NodeJS.Timeout }
  >();

  function rejectPending(error: Error) {
    for (const job of pending.values()) {
      clearTimeout(job.timer);
      job.reject(error);
    }
    pending.clear();
  }
  function retire(current: Worker, error?: Error) {
    if (worker === current) {
      worker = null;
      clearTimeout(idleTimer);
      if (error) rejectPending(error);
    }
    return current.terminate().then(() => {});
  }
  function getWorker() {
    if (worker) return worker;
    const current = new Worker(workerUrl, { workerData: { databasePath: raw.name } });
    worker = current;
    current.on("message", (message: { id: number; value?: MissingRootReadResult; error?: string }) => {
      if (worker !== current) return;
      const job = pending.get(message.id);
      if (!job) return;
      pending.delete(message.id);
      clearTimeout(job.timer);
      if (message.error) job.reject(new Error(message.error));
      else if (Array.isArray(message.value)) job.resolve(message.value);
      else job.reject(new Error("missing_root_worker_invalid_result"));
      if (!pending.size) {
        current.unref();
        idleTimer = setTimeout(() => void retire(current), 30_000);
        idleTimer.unref();
      }
    });
    current.on("error", (error) => {
      if (worker === current) void retire(current, error);
    });
    current.on("exit", (code) => {
      if (worker === current) {
        worker = null;
        rejectPending(new Error(`missing_root_worker_exited:${code}`));
      }
    });
    current.unref();
    return current;
  }
  function request(root: MissingEpisodeRoot, options: MissingRootReadOptions): Promise<MissingRootReadResult> {
    if (!useWorker)
      return Promise.resolve().then(() => {
        if (closed) throw new Error("missing_root_reader_closed");
        if (!raw.open) throw new Error("missing_root_database_closed");
        return readMissingRootSnapshot(database, root, options);
      });
    return new Promise((resolve, reject) => {
      clearTimeout(idleTimer);
      const current = getWorker();
      const id = ++sequence;
      const timer = setTimeout(() => void retire(current, new Error("missing_root_worker_timeout")), 30_000);
      timer.unref();
      pending.set(id, { resolve, reject, timer });
      current.ref();
      try {
        current.postMessage({ id, root, options } satisfies MissingRootReadRequest);
      } catch (error) {
        void retire(current, error instanceof Error ? error : new Error(String(error)));
      }
    });
  }
  async function close() {
    if (closing) return closing;
    closed = true;
    clearTimeout(idleTimer);
    rejectPending(new Error("missing_root_reader_closed"));
    const current = worker;
    worker = null;
    closing = current ? current.terminate().then(() => {}) : Promise.resolve();
    return closing;
  }
  return {
    read(root: MissingEpisodeRoot, options: MissingRootReadOptions = {}): Promise<MissingRootReadResult> {
      if (closed) return Promise.reject(new Error("missing_root_reader_closed"));
      if (!raw.open) {
        void close();
        return Promise.reject(new Error("missing_root_database_closed"));
      }
      // data_version tracks other connections; total_changes tracks this connection, even within one timestamp.
      const version = [
        raw.pragma("data_version", { simple: true }),
        raw.prepare("SELECT total_changes()").pluck().get(),
      ];
      const key = JSON.stringify([root, options, version]);
      const existing = inflight.get(key);
      if (existing) return existing;
      const result = request(root, structuredClone(options));
      inflight.set(key, result);
      const clear = () => {
        if (inflight.get(key) === result) inflight.delete(key);
      };
      void result.then(clear, clear);
      return result;
    },
    close,
  };
}

const readers = new WeakMap<AppDatabase, ReturnType<typeof createMissingRootReader>>();
export function readRootMissingEpisodesAsync(
  database: AppDatabase,
  root: MissingEpisodeRoot,
  options: MissingRootReadOptions = {},
) {
  let reader = readers.get(database);
  if (!reader) readers.set(database, (reader = createMissingRootReader(database)));
  return reader.read(root, options);
}
export async function closeMissingRootReader(database: AppDatabase) {
  await readers.get(database)?.close();
}
