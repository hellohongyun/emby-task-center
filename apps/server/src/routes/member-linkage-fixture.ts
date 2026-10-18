import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { request as httpRequest, type Server } from "node:http";
import express from "express";
import { createDatabase } from "@emby-task-center/database/client";
import { createApp } from "../app";
import { staticCredentialVerifier } from "../auth/test-session";
import { createEmbyClient, type EmbyUser } from "../integrations/emby-client";
import { createLibraryService } from "../library/service";
import type { TmdbClient } from "../tmdb/client";

let fixtureNumber = 1;
async function listen(app: ReturnType<typeof express>) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}
async function close(server: Server) {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

/** Real application HTTP and SQLite; only external Emby/TMDB/mail are controlled fixtures. */
export async function memberLinkageFixture() {
  const directory = mkdtempSync(join(tmpdir(), "emby-member-linkage-"));
  const database = createDatabase(join(directory, "app.sqlite"));
  const users: EmbyUser[] = [];
  const writes: Array<{ path: string; body: unknown }> = [];
  const mail: Array<{ to: string; text: string }> = [];
  const upstream = express();
  upstream.use(express.json());
  upstream.use((request, response, next) => {
    if (request.headers["x-emby-token"] !== "fixture-key") return void response.sendStatus(401);
    next();
  });
  upstream.get("/emby/Users", (_request, response) => response.json(users));
  upstream.get("/emby/Sessions", (_request, response) => response.json([]));
  upstream.post("/emby/Users/New", (request, response) => {
    const user = {
      Id: `fixture-user-${users.length + 1}`,
      Name: String(request.body.Name),
      Policy: { IsDisabled: false, PlaybackEnabled: true, EnableAllDevices: false, EnabledDevices: ["kept-device"] },
    };
    users.push(user);
    writes.push({ path: request.path, body: request.body });
    response.json(user);
  });
  upstream.post("/emby/Users/:id/Password", (request, response) => {
    writes.push({ path: request.path, body: request.body });
    response.sendStatus(204);
  });
  upstream.post("/emby/Users/:id/Policy", (request, response) => {
    const user = users.find((entry) => entry.Id === request.params.id);
    if (!user) return void response.sendStatus(404);
    writes.push({ path: request.path, body: request.body });
    // Emby replaces the entire policy; this deliberately exposes missing-field writes.
    user.Policy = request.body;
    response.sendStatus(204);
  });
  const embyServer = await listen(upstream);
  const tmdb: TmdbClient = {
    search: async () => [],
    details: async () => {
      throw new Error("unexpected TMDB detail request");
    },
    seasonProgress: async () => ({
      seasonNumber: 1,
      airedEpisodes: 0,
      totalEpisodes: 0,
      lastAirDate: null,
      nextAirDate: null,
    }),
    airedEpisodeCount: async () => 0,
    seasonEpisodes: async () => [],
  };
  const app = createApp({
    database: database.db,
    auth: { sessionSecret: "linkage-only-secret", verifyCredentials: staticCredentialVerifier("linkage-password") },
    tmdb,
    library: createLibraryService([]),
    integrationServices: {
      emby: createEmbyClient({ baseUrl: embyServer.url, apiKey: "fixture-key" }),
      email: {
        configured: true,
        sendTest: async () => undefined,
        retryPending: async () => undefined,
        sendNotification: async (to, _subject, text) => {
          mail.push({ to, text });
        },
      },
    },
  });
  const application = await listen(app);
  // 独立的真实连接来源，避免各夹具共享进程级 IP 限流；不依赖转发头。
  const localAddress = `127.0.0.${++fixtureNumber}`;
  const request = (path: string, body?: unknown, cookie?: string, method = body === undefined ? "GET" : "POST") =>
    new Promise<Response>((resolve, reject) => {
      const outgoing = httpRequest(
        `${application.url}${path}`,
        {
          method,
          localAddress,
          headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
          signal: AbortSignal.timeout(10_000),
        },
        (incoming) => {
          const chunks: Buffer[] = [];
          incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
          incoming.on("error", reject);
          incoming.on("end", () => {
            const headers = new Headers();
            for (const [name, values] of Object.entries(incoming.headers)) {
              for (const value of Array.isArray(values) ? values : values === undefined ? [] : [values]) {
                headers.append(name, value);
              }
            }
            const status = incoming.statusCode ?? 500;
            resolve(new Response(status === 204 ? null : Buffer.concat(chunks), { status, headers }));
          });
        },
      );
      outgoing.on("error", reject);
      outgoing.end(body === undefined ? undefined : JSON.stringify(body));
    });
  return {
    database,
    users,
    writes,
    mail,
    request,
    async dispose() {
      await close(application.server);
      await app.locals.closePublicLibrary?.();
      await close(embyServer.server);
      database.close();
      // Only the exact temporary directory created by this fixture is removed.
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
