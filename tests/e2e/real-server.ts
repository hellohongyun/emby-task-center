import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { startEmbyFixture } from "./real-upstream";
import { seedTemporaryDatabase } from "./real-seed";

async function freePort() {
  const probe = createServer();
  await new Promise<void>((done, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      probe.off("error", reject);
      done();
    });
  });
  const address = probe.address();
  if (!address || typeof address === "string") throw new Error("port_address_missing");
  await new Promise<void>((done) => probe.close(() => done()));
  return address.port;
}

/** Explicit OS environment whitelist: never inherit application secrets or NODE_OPTIONS. */
function childEnvironment(): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "Path", "SystemRoot", "WINDIR", "TEMP", "TMP", "HOME", "USERPROFILE"]) {
    if (process.env[key]) result[key] = process.env[key];
  }
  return result;
}

async function terminate(child: ChildProcess) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((done) => child.once("exit", () => done()));
  child.kill("SIGTERM");
  const timeout = setTimeout(() => child.kill("SIGKILL"), 10_000);
  let finalTimeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      exited,
      new Promise<never>((_done, reject) => {
        finalTimeout = setTimeout(
          () => reject(new Error(`Test server ${child.pid} did not exit; temporary data retained.`)),
          15_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
    clearTimeout(finalTimeout);
  }
}

export async function startIsolatedServer(options: { missingEpisodes?: boolean } = {}) {
  const workspace = resolve(".");
  for (const file of ["dist/server/index.mjs", "apps/web/dist/index.html"]) {
    if (!existsSync(resolve(file))) throw new Error(`Missing ${file}; run pnpm build first.`);
  }
  const temporaryRoot = resolve(tmpdir());
  const work = mkdtempSync(join(temporaryRoot, "emby-isolated-e2e-"));
  const databasePath = join(work, "test.db");
  const logPath = join(work, "server.log");
  const blockedPath = join(work, "blocked-network.log");
  let child: ChildProcess | undefined;
  let logFd: number | undefined;
  let upstream: Awaited<ReturnType<typeof startEmbyFixture>> | undefined;
  async function close() {
    if (child) await terminate(child);
    if (logFd !== undefined) {
      closeSync(logFd);
      logFd = undefined;
    }
    if (upstream) {
      await upstream.close();
      upstream = undefined;
    }
    const inside = relative(temporaryRoot, work);
    if (!inside || inside.startsWith("..") || isAbsolute(inside) || dirname(work) !== temporaryRoot)
      throw new Error("unsafe_e2e_cleanup_path");
    rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  try {
    seedTemporaryDatabase(work, databasePath, childEnvironment(), options.missingEpisodes);
    upstream = await startEmbyFixture(options);
    const port = await freePort();
    const baseURL = `http://127.0.0.1:${port}`;
    const guardPath = join(work, "network-guard.mjs");
    writeFileSync(
      guardPath,
      `import { appendFileSync } from 'node:fs';
const original = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  // The client has a built-in TMDB key; route that upstream to explicit local fixtures.
  if (url.origin === 'https://api.themoviedb.org') {
    return original(${JSON.stringify(upstream.baseURL)} + '/tmdb' + url.pathname + url.search, init);
  }
  if (url.origin !== ${JSON.stringify(upstream.baseURL)}) {
    appendFileSync(${JSON.stringify(blockedPath)}, url.origin + url.pathname + '\\n');
    return Promise.reject(new Error('external_network_disabled_in_e2e'));
  }
  return original(input, init);
};`,
    );
    logFd = openSync(logPath, "w");
    child = spawn(process.execPath, ["--import", pathToFileURL(guardPath).href, "dist/server/index.mjs"], {
      cwd: workspace,
      stdio: ["ignore", logFd, logFd],
      env: {
        ...childEnvironment(),
        NODE_ENV: "test",
        PORT: String(port),
        DATABASE_PATH: databasePath,
        MIGRATIONS_PATH: resolve("packages/database/drizzle"),
        WEB_DIST_PATH: resolve("apps/web/dist"),
        EMBY_ENABLED: "true",
        EMBY_BASE_URL: upstream.baseURL,
        EMBY_API_KEY: "local-fixture-only",
        // Keep one intentional wrong-password assertion below the isolated test lockout threshold.
        AUTH_MAX_FAILED_ATTEMPTS: "10",
        TZ: "UTC",
      },
    });
    let spawnError: Error | undefined;
    child.once("error", (error) => {
      spawnError = error;
    });
    const deadline = Date.now() + 30_000;
    let healthy = false;
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null) throw new Error(`Server exited: ${readFileSync(logPath, "utf8")}`);
      try {
        const response = await fetch(`${baseURL}/health`, { signal: AbortSignal.timeout(1000) });
        await response.text();
        if (response.ok) {
          healthy = true;
          break;
        }
      } catch {
        /* readiness only */
      }
      await new Promise((done) => setTimeout(done, 100));
    }
    if (!healthy) throw new Error(`Server not ready: ${readFileSync(logPath, "utf8")}`);
    const fixture = upstream;
    return {
      baseURL,
      fixture,
      close,
      logs: () => readFileSync(logPath, "utf8"),
      blockedRequests: () => (existsSync(blockedPath) ? readFileSync(blockedPath, "utf8").trim().split("\n") : []),
    };
  } catch (error) {
    await close();
    throw error;
  }
}
