import { Worker } from "node:worker_threads";
import type { LibraryRootConfig } from "./service";
import type { ScannedMediaItem } from "./scan-types";

export interface ScanWriteRequest {
  id: number;
  root: LibraryRootConfig;
  items: readonly ScannedMediaItem[];
  startedAt: string;
  roots: readonly LibraryRootConfig[];
  complete: boolean;
}

export function createScanWriter(databasePath: string, workerUrl = new URL("./scan-worker.mjs", import.meta.url)) {
  let worker: Worker | null = null;
  let sequence = 0;
  let closed = false;
  const pending = new Map<number, { resolve(): void; reject(error: Error): void }>();
  function rejectPending(error: Error) {
    for (const job of pending.values()) job.reject(error);
    pending.clear();
  }
  function getWorker(): Worker {
    if (closed) throw new Error("scan_writer_closed");
    if (worker) return worker;
    const current = new Worker(workerUrl, { workerData: { databasePath } });
    worker = current;
    current.on("message", (result: { id: number; error?: string }) => {
      const job = pending.get(result.id);
      pending.delete(result.id);
      if (result.error) job?.reject(new Error(result.error));
      else job?.resolve();
      if (!pending.size) current.unref();
    });
    current.on("error", rejectPending);
    current.on("exit", (code) => {
      if (worker === current) worker = null;
      rejectPending(new Error(`scan_worker_exited:${code}`));
    });
    current.unref();
    return current;
  }
  return {
    persist(
      root: LibraryRootConfig,
      items: readonly ScannedMediaItem[],
      startedAt: string,
      roots: readonly LibraryRootConfig[],
      complete = false,
    ) {
      return new Promise<void>((resolve, reject) => {
        const current = getWorker();
        const id = ++sequence;
        pending.set(id, { resolve, reject });
        current.ref();
        try {
          current.postMessage({ id, root, items, startedAt, roots, complete } satisfies ScanWriteRequest);
        } catch (error) {
          pending.delete(id);
          if (!pending.size) current.unref();
          reject(error);
        }
      });
    },
    async close() {
      closed = true;
      rejectPending(new Error("scan_writer_closed"));
      if (worker) await worker.terminate();
      worker = null;
    },
  };
}
