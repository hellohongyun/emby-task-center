import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";

import { createDatabase, type DatabaseHandle } from "@emby-task-center/database/client";
import { logs } from "@emby-task-center/database/schema";
import { createApp } from "../app";
import { staticCredentialVerifier } from "../auth/test-session";
import { createLibraryService } from "../library/service";
import { createLogger } from "../logging/logger";
import { createTmdbClient } from "../tmdb/client";

const sharedPassword = "family-password";
const sessionSecret = "session-signing-secret";

describe("logs API", () => {
  let directory: string;
  let database: DatabaseHandle;
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "emby-logs-"));
    database = createDatabase(join(directory, "logs.sqlite"));
    const app = createApp({
      database: database.db,
      auth: { sessionSecret, verifyCredentials: staticCredentialVerifier(sharedPassword) },
      tmdb: createTmdbClient({ token: "tmdb-server-token" }),
      library: createLibraryService([], undefined),
      logger: createLogger(database.db, { retentionDays: 30, maxRows: 1_000 }),
    });
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("rejects unauthenticated log reads and writes", async () => {
    const read = await fetch(`${baseUrl}/api/logs`);
    expect(read.status).toBe(401);

    const write = await fetch(`${baseUrl}/api/logs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ logs: [{ level: "info", source: "web", message: "hello" }] }),
    });
    expect(write.status).toBe(401);
  });

  it("accepts a web log batch, truncates long fields, and stores rows", async () => {
    const cookie = await login();
    const response = await fetch(`${baseUrl}/api/logs`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        logs: [
          { level: "info", source: "web", message: "a".repeat(600) },
          {
            level: "warn",
            source: "web",
            message: "task slow",
            method: "GET",
            path: "/api/tasks",
            status: 400,
            durationMs: 123,
            detail: "b".repeat(2_500),
          },
        ],
      }),
    });

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ accepted: 2 });

    const rows = database.db.select().from(logs).where(eq(logs.source, "web")).orderBy(asc(logs.id)).all();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      level: "info",
      source: "web",
      message: "a".repeat(500),
      createdAt: expect.any(String),
    });
    expect(rows[1]).toMatchObject({
      level: "warn",
      method: "GET",
      path: "/api/tasks",
      status: 400,
      durationMs: 123,
      detail: "b".repeat(2_000),
    });
  });

  it("rejects invalid batches with 400", async () => {
    const cookie = await login();
    const response = await fetch(`${baseUrl}/api/logs`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ logs: [{ level: "info", source: "server", message: "wrong source" }] }),
    });
    expect(response.status).toBe(400);
  });

  it("filters and paginates logs", async () => {
    const cookie = await login();
    for (let i = 0; i < 5; i++) {
      database.db
        .insert(logs)
        .values({
          level: i % 2 === 0 ? "info" : "error",
          source: i % 2 === 0 ? "server" : "web",
          message: `event ${i}`,
          path: `/api/tasks/${i}`,
          createdAt: new Date().toISOString(),
        })
        .run();
    }

    const byLevel = await (await fetch(`${baseUrl}/api/logs?level=info`, { headers: { cookie } })).json();
    expect(byLevel.logs.length).toBeGreaterThan(0);
    expect(byLevel.logs.every((row: { level: string }) => row.level === "info")).toBe(true);

    const bySource = await (await fetch(`${baseUrl}/api/logs?source=web`, { headers: { cookie } })).json();
    expect(bySource.logs.length).toBeGreaterThan(0);
    expect(bySource.logs.every((row: { source: string }) => row.source === "web")).toBe(true);

    const byQuery = await (await fetch(`${baseUrl}/api/logs?q=event%202`, { headers: { cookie } })).json();
    expect(byQuery.logs).toHaveLength(1);
    expect(byQuery.logs[0]).toMatchObject({ message: "event 2", path: "/api/tasks/2" });

    const firstPage = await (await fetch(`${baseUrl}/api/logs?limit=2`, { headers: { cookie } })).json();
    expect(firstPage.logs).toHaveLength(2);
    const before = firstPage.logs.at(-1).id as number;
    const secondPage = await (
      await fetch(`${baseUrl}/api/logs?limit=2&before=${before}`, { headers: { cookie } })
    ).json();
    expect(secondPage.logs).toHaveLength(2);
    expect(secondPage.logs.every((row: { id: number }) => row.id < before)).toBe(true);

    const capped = await (await fetch(`${baseUrl}/api/logs?limit=9999`, { headers: { cookie } })).json();
    expect(capped.logs.length).toBeLessThanOrEqual(500);
  });

  it("records authenticated api requests but skips the logs endpoint itself", async () => {
    const cookie = await login();
    await fetch(`${baseUrl}/api/tasks`, { headers: { cookie } });
    await fetch(`${baseUrl}/api/logs`, { headers: { cookie } });

    const taskLogs = database.db.select().from(logs).where(eq(logs.path, "/api/tasks")).all();
    expect(taskLogs).toHaveLength(1);
    expect(taskLogs[0]).toMatchObject({
      source: "server",
      method: "GET",
      path: "/api/tasks",
      status: 200,
      message: "读取任务列表",
      level: "info",
    });

    const logEndpointRows = database.db.select().from(logs).where(eq(logs.path, "/api/logs")).all();
    expect(logEndpointRows).toHaveLength(0);
  });

  async function login(): Promise<string> {
    const response = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: sharedPassword }),
    });
    const cookie = response.headers.get("set-cookie");

    expect(response.status).toBe(200);
    return cookie!.split(";", 1)[0];
  }
});
