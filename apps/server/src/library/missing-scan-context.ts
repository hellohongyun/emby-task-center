import { existsSync } from "node:fs";
import { Worker } from "node:worker_threads";
import type BetterSqlite3 from "better-sqlite3";
import type { AppDatabase } from "@emby-task-center/database/client";
import { loadMissingScanData, type MissingScanCandidate, type MissingScanItem } from "./missing-scan-data";

/** Each run owns an immutable read snapshot. Only one show's episodes cross the worker boundary at a time. */
export async function createMissingScanContext(
  database: AppDatabase,
  workerUrl = new URL("./missing-scan-worker.mjs", import.meta.url),
) {
  const raw = (database as unknown as { $client: BetterSqlite3.Database }).$client;
  if (raw.name === ":memory:" || !existsSync(workerUrl)) {
    const direct = loadMissingScanData(database);
    let closed = false;
    return {
      candidates: direct.candidates,
      read: async (id: number) => {
        if (closed) throw new Error("missing_scan_context_closed");
        return direct.read(id);
      },
      close: async () => {
        closed = true;
      },
    };
  }
  const worker = new Worker(workerUrl, { workerData: { databasePath: raw.name } });
  let sequence = 0;
  let failure: Error | null = null;
  const pending = new Map<
    number,
    { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }
  >();
  function fail(error: Error) {
    failure ??= error;
    for (const job of pending.values()) {
      clearTimeout(job.timer);
      job.reject(failure);
    }
    pending.clear();
    worker.unref();
  }
  worker.on("error", fail);
  worker.on("exit", (code) => fail(new Error(`missing_scan_worker_exited:${code}`)));
  worker.on("message", (message: { id: number; value?: unknown; error?: string }) => {
    const job = pending.get(message.id);
    if (!job) return;
    pending.delete(message.id);
    clearTimeout(job.timer);
    if (message.error) job.reject(new Error(message.error));
    else job.resolve(message.value);
    if (!pending.size) worker.unref();
  });
  worker.unref();
  async function close() {
    fail(new Error("missing_scan_context_closed"));
    await worker.terminate();
  }
  function request<T>(mediaItemId?: number): Promise<T> {
    if (failure) return Promise.reject(failure);
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => {
        fail(new Error("missing_scan_worker_timeout"));
        void worker.terminate();
      }, 30_000);
      pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
      worker.ref();
      try {
        worker.postMessage({ id, mediaItemId });
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
        void worker.terminate();
      }
    });
  }
  try {
    const candidates = await request<MissingScanCandidate[]>();
    return { candidates, read: (id: number) => request<MissingScanItem>(id), close };
  } catch (error) {
    await close();
    throw error;
  }
}
