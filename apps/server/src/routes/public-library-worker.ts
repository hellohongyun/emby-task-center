import { parentPort, workerData } from "node:worker_threads";
import BetterSqlite3 from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { schema } from "@emby-task-center/database/schema";
import type { LibraryService } from "../library/service";
import { createPublicLibraryReader } from "./public-library-reader";
import type { LibraryPageRequest } from "./public-library-worker-client";

const data = workerData as { databasePath: string; watchUrl: string | null };
const sqlite = new BetterSqlite3(data.databasePath, { readonly: true, timeout: 1000 });
let roots: Record<string, string | null> = {};
const reader = createPublicLibraryReader(
  {
    database: drizzle(sqlite, { schema }),
    library: { rootIdForPath: (path: string) => roots[path] ?? null } as LibraryService,
  },
  data.watchUrl,
);
parentPort!.on("message", (request: LibraryPageRequest) => {
  try {
    roots = request.roots;
    const page = reader.list(request.filters, request.sort, request.limit, request.offset);
    parentPort!.postMessage({ id: request.id, page });
  } catch (error) {
    parentPort!.postMessage({ id: request.id, error: error instanceof Error ? error.message : String(error) });
  }
});
parentPort!.on("close", () => sqlite.close());
