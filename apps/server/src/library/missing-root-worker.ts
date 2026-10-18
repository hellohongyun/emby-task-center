import { parentPort, workerData } from "node:worker_threads";
import BetterSqlite3 from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { schema } from "@emby-task-center/database/schema";
import { readMissingRootSnapshot, type MissingRootReadRequest } from "./missing-root-reader";

const sqlite = new BetterSqlite3((workerData as { databasePath: string }).databasePath, {
  readonly: true,
  timeout: 1000,
});
sqlite.pragma("query_only = ON");
const database = drizzle(sqlite, { schema });
parentPort!.on("message", (request: MissingRootReadRequest) => {
  try {
    const value = readMissingRootSnapshot(database, request.root, request.options);
    parentPort!.postMessage({ id: request.id, value });
  } catch (error) {
    parentPort!.postMessage({ id: request.id, error: error instanceof Error ? error.message : String(error) });
  }
});
parentPort!.on("close", () => sqlite.close());
