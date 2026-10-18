import { existsSync } from "node:fs";
import { Worker } from "node:worker_threads";
import type BetterSqlite3 from "better-sqlite3";
import { mediaRoots } from "@emby-task-center/database/schema";
import type { PublicLibraryOptions } from "./public-library";
import { createPublicLibraryReader, type LibraryFilters } from "./public-library-reader";

type Page = ReturnType<ReturnType<typeof createPublicLibraryReader>["list"]>;
export interface LibraryPageRequest {
  id: number;
  filters: LibraryFilters;
  sort: string;
  limit: number;
  offset: number;
  roots: Record<string, string | null>;
}
export function createPublicLibraryWorkerReader(
  options: PublicLibraryOptions,
  watchUrl: string | null,
  workerUrl = new URL("./public-library-worker.mjs", import.meta.url),
) {
  const direct = createPublicLibraryReader(options, watchUrl);
  const raw = (options.database as unknown as { $client: BetterSqlite3.Database }).$client;
  const databasePath = raw.name;
  const useWorker = databasePath !== ":memory:" && existsSync(workerUrl);
  let worker: Worker | null = null;
  let closed = false;
  let sequence = 0;
  const pending = new Map<number, { resolve(page: Page): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  function rejectPending(error: Error) {
    for (const job of pending.values()) {
      clearTimeout(job.timer);
      job.reject(error);
    }
    pending.clear();
  }
  function getWorker() {
    if (closed) throw new Error("public_library_reader_closed");
    if (worker) return worker;
    const current = new Worker(workerUrl, { workerData: { databasePath, watchUrl } });
    worker = current;
    current.on("message", (result: { id: number; page?: Page; error?: string }) => {
      const job = pending.get(result.id);
      if (!job) return;
      pending.delete(result.id);
      clearTimeout(job.timer);
      if (result.error) job.reject(new Error(result.error));
      else if (result.page) job.resolve(result.page);
      else job.reject(new Error("public_library_worker_invalid_result"));
      if (!pending.size) current.unref();
    });
    const failed = (error: Error) => {
      if (worker !== current) return;
      worker = null;
      rejectPending(error);
    };
    current.on("error", (error) => {
      failed(error);
      void current.terminate();
    });
    current.on("exit", (code) => failed(new Error(`public_library_worker_exited:${code}`)));
    current.unref();
    return current;
  }
  return {
    async list(filters: LibraryFilters, sort: string, limit: number, offset: number): Promise<Page> {
      if (closed) throw new Error("public_library_reader_closed");
      if (!useWorker) return direct.list(filters, sort, limit, offset);
      const roots = Object.fromEntries(
        options.database
          .select({ path: mediaRoots.containerPath })
          .from(mediaRoots)
          .all()
          .map(({ path }) => [path, options.library?.rootIdForPath?.(path) ?? null]),
      );
      return new Promise((resolve, reject) => {
        const current = getWorker();
        const id = ++sequence;
        const timer = setTimeout(() => {
          if (worker === current) {
            worker = null;
            rejectPending(new Error("public_library_worker_timeout"));
          }
          void current.terminate();
        }, 30_000);
        timer.unref();
        pending.set(id, { resolve, reject, timer });
        current.ref();
        try {
          current.postMessage({ id, filters, sort, limit, offset, roots } satisfies LibraryPageRequest);
        } catch (error) {
          pending.delete(id);
          clearTimeout(timer);
          if (!pending.size) current.unref();
          reject(error);
        }
      });
    },
    detail: direct.detail,
    async close() {
      closed = true;
      rejectPending(new Error("public_library_reader_closed"));
      const current = worker;
      worker = null;
      if (current) await current.terminate();
    },
  };
}
