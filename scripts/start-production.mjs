import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const localDataDirectory = resolve(".local");
mkdirSync(localDataDirectory, { recursive: true });

process.env.NODE_ENV = "production";
process.env.PORT ??= "3000";
process.env.DATABASE_PATH ??= resolve(localDataDirectory, "emby-task-center.db");
process.env.MIGRATIONS_PATH ??= resolve("packages/database/drizzle");
process.env.WEB_DIST_PATH ??= resolve("apps/web/dist");

await import("../dist/server/index.mjs");
