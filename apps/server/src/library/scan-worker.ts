import { parentPort, workerData } from "node:worker_threads";
import BetterSqlite3 from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { schema } from "@emby-task-center/database/schema";
import { persistScan } from "./scan-persistence";
import type { ScanWriteRequest } from "./scan-writer";

// The main process has already migrated this database. Never run migrations here.
const sqlite = new BetterSqlite3(workerData.databasePath, { fileMustExist: true, timeout: 5_000 });
sqlite.pragma("foreign_keys = ON");
const database = drizzle(sqlite, { schema });
parentPort!.on("message", (request: ScanWriteRequest) => {
  try {
    persistScan(database, request.root, request.items, request.startedAt, request.roots, request.complete);
    parentPort!.postMessage({ id: request.id });
  } catch (error) {
    parentPort!.postMessage({ id: request.id, error: error instanceof Error ? error.message : "scan_write_failed" });
  }
});
