import express from "express";
import { build } from "esbuild";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createDatabase } from "@emby-task-center/database/client";
import { submissionUsers } from "@emby-task-center/database/schema";
import { staticCredentialVerifier } from "../auth/test-session";
import { loginAsMember } from "./member-login";
import type { TmdbClient } from "../tmdb/client";

export function gate() {
  let release!: () => void;
  const promise = new Promise<void>((done) => (release = done));
  return { promise, release };
}
export async function compileScanFixture() {
  const repo = fileURLToPath(new URL("../../../../", import.meta.url));
  mkdirSync(join(repo, ".local"), { recursive: true });
  const directory = mkdtempSync(join(repo, ".local/deep-scan-linkage-"));
  const external = Object.keys(JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).dependencies).filter(
    (name) => !name.startsWith("@emby-task-center/"),
  );
  const options = { bundle: true, platform: "node" as const, target: "node24", format: "esm" as const, external };
  await build({
    ...options,
    stdin: {
      contents: [
        'export { createApp } from "./apps/server/src/app";',
        'export { createLibraryService } from "./apps/server/src/library/service";',
        'export { createEmbyScan } from "./apps/server/src/library/emby-scanner";',
        'export { createEmbyClient } from "./apps/server/src/integrations/emby-client";',
        'export { createLogger } from "./apps/server/src/logging/logger";',
      ].join("\n"),
      resolveDir: repo,
      loader: "ts",
    },
    outfile: join(directory, "fixture.mjs"),
    logLevel: "silent",
  });
  await build({
    ...options,
    entryPoints: ["library/scan-worker", "routes/public-library-worker"].map((name) =>
      join(repo, `apps/server/src/${name}.ts`),
    ),
    outdir: directory,
    entryNames: "[name]",
    outExtension: { ".js": ".mjs" },
    logLevel: "silent",
  });
  const modules = (await import(pathToFileURL(join(directory, "fixture.mjs")).href)) as {
    createApp: typeof import("../app").createApp;
    createLibraryService: typeof import("../library/service").createLibraryService;
    createEmbyScan: typeof import("../library/emby-scanner").createEmbyScan;
    createEmbyClient: typeof import("../integrations/emby-client").createEmbyClient;
    createLogger: typeof import("../logging/logger").createLogger;
  };
  return {
    directory,
    modules,
    remove() {
      if (!resolve(directory).startsWith(resolve(repo, ".local") + sep)) throw new Error("invalid_cleanup_path");
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

async function listen(app: ReturnType<typeof express>) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((done) => server.once("listening", done));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}
async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((done) => server.close(() => done()));
}

export async function createDeepScanFixture(compiled: Awaited<ReturnType<typeof compileScanFixture>>) {
  const databasePath = join(compiled.directory, `${crypto.randomUUID()}.sqlite`);
  const handle = createDatabase(databasePath);
  let changed = false;
  let mode: "complete" | "truncated" | "failure" | "empty" = "complete";
  let held: ReturnType<typeof gate> | undefined;
  let entered: ReturnType<typeof gate> | undefined;
  const offsets: number[] = [];
  const upstream = express();
  upstream.get("/emby/Items", async (request, response) => {
    const offset = Number(request.query.StartIndex);
    offsets.push(offset);
    if (offset === 500 && held) {
      entered?.release();
      await held.promise;
    }
    if (mode === "failure" && offset > 0) return void response.status(503).end();
    if (mode === "empty") return void response.json({ Items: [], TotalRecordCount: 0 });
    const size = Math.min(Number(request.query.Limit), 501 - offset);
    const Items =
      mode === "truncated" && offset > 0
        ? []
        : Array.from({ length: size }, (_, index) => {
            const id = offset + index === 500 && changed ? 501 : offset + index;
            return { Id: `m${id}`, Name: `Work ${String(id).padStart(3, "0")}`, Type: "Movie", ProductionYear: 2024 };
          });
    response.json({ Items, TotalRecordCount: 501 });
  });
  upstream.use((_request, response) => response.status(500).json({ error: "unexpected_upstream_request" }));
  const embyServer = await listen(upstream);
  const { modules } = compiled;
  const emby = modules.createEmbyClient({ baseUrl: embyServer.url, apiKey: "fixture-only" });
  const library = modules.createLibraryService(
    [{ id: "fixture", name: "联动测试库", mediaType: "movie", path: "emby:fixture" }],
    modules.createEmbyScan(emby),
    handle.db,
    { databasePath, workerUrl: pathToFileURL(join(compiled.directory, "scan-worker.mjs")) },
  );
  const tmdb = {
    search: async () => [],
    details: async () => {
      throw new Error("unexpected_tmdb");
    },
  } as unknown as TmdbClient;
  const logger = modules.createLogger(handle.db, { databasePath });
  const app = modules.createApp({
    database: handle.db,
    auth: {
      sessionSecret: "deep-linkage-fixture-secret",
      verifyCredentials: staticCredentialVerifier("fixture-password"),
    },
    library,
    tmdb,
    logger,
  });
  const application = await listen(app);
  const login = await fetch(`${application.url}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "fixture-password" }),
  });
  if (!login.ok) throw new Error(`admin_login_${login.status}`);
  const admin = login.headers.get("set-cookie")!.split(";")[0]!;
  const now = new Date().toISOString();
  handle.db
    .insert(submissionUsers)
    .values({ email: "fixture@example.com", enabled: true, createdAt: now, updatedAt: now })
    .run();
  const member = await loginAsMember(application.url, handle.db, "fixture@example.com");
  return {
    handle,
    library,
    offsets,
    databasePath,
    async request(path: string, method = "GET") {
      const response = await fetch(`${application.url}${path}`, {
        method,
        headers: { cookie: path.startsWith("/api/public/") ? member : admin },
        signal: AbortSignal.timeout(5000),
      });
      return { status: response.status, body: await response.json() };
    },
    change() {
      changed = true;
    },
    mode(value: typeof mode) {
      mode = value;
    },
    holdSecondPage() {
      held = gate();
      entered = gate();
      return { entered: entered.promise, release: () => held?.release() };
    },
    async close() {
      held?.release();
      await close(application.server);
      await app.locals.closePublicLibrary();
      await library.close?.();
      logger.close?.();
      handle.close();
      await close(embyServer.server);
    },
  };
}
