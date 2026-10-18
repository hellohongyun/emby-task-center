import { parentPort, workerData } from "node:worker_threads";
import BetterSqlite3 from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { schema } from "@emby-task-center/database/schema";
import { loadMissingScanData } from "./missing-scan-data";

const sqlite = new BetterSqlite3((workerData as { databasePath: string }).databasePath, {
  readonly: true,
  timeout: 1000,
});
const context = loadMissingScanData(drizzle(sqlite, { schema }));
parentPort!.on("message", (request: { id: number; mediaItemId?: number }) => {
  try {
    parentPort!.postMessage({
      id: request.id,
      value: request.mediaItemId == null ? context.candidates : context.read(request.mediaItemId),
    });
  } catch (error) {
    parentPort!.postMessage({ id: request.id, error: error instanceof Error ? error.message : String(error) });
  }
});
parentPort!.on("close", () => sqlite.close());
