import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildSync } from "esbuild";

/** Compile the actual database initializer for a separate process, avoiding Playwright's CJS transform. */
export function seedTemporaryDatabase(
  work: string,
  databasePath: string,
  environment: NodeJS.ProcessEnv,
  missingEpisodes = false,
) {
  const outfile = join(work, "seed.cjs");
  buildSync({
    stdin: {
      resolveDir: resolve("."),
      contents: `import { createDatabase } from '@emby-task-center/database/client';
import { trendingSourceConfigs } from '@emby-task-center/database/schema';
import { seedMissingEpisodes } from './tests/e2e/missing-fixture-seed';
const database = createDatabase(${JSON.stringify(databasePath)}, ${JSON.stringify(resolve("packages/database/drizzle"))});
try {
  if (${JSON.stringify(missingEpisodes)}) seedMissingEpisodes(database.db);
  for (const source of ['tmdb', 'imdb', 'douban']) {
    database.db.insert(trendingSourceConfigs).values({ source, enabled: false, ttlMinutes: 60, refreshMinutes: 60, updatedAt: new Date().toISOString() }).run();
  }
} finally { database.close(); }`,
    },
    outfile,
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["better-sqlite3", "drizzle-orm", "drizzle-orm/*"],
    define: { "import.meta.url": JSON.stringify(pathToFileURL(resolve("packages/database/src/migrate.ts")).href) },
    banner: { js: `require = require('node:module').createRequire(${JSON.stringify(resolve("package.json"))});` },
  });
  const result = spawnSync(process.execPath, [outfile], { env: environment, encoding: "utf8", timeout: 15_000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Isolated database seed failed: ${result.stderr}`);
}
