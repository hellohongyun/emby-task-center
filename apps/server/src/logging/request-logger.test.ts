import { mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express, { type Response } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDatabase, type DatabaseHandle } from "@emby-task-center/database/client";
import { logs } from "@emby-task-center/database/schema";
import { createLogger, type Logger } from "./logger";

describe("HTTP request completion logs", () => {
  let directory: string;
  let database: DatabaseHandle;
  let logger: Logger;
  let server: Server;
  let baseUrl: string;
  let app: ReturnType<typeof express>;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "emby-request-logger-"));
    database = createDatabase(join(directory, "logger.sqlite"));
    logger = createLogger(database.db);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    app = express();
    app.use(logger.request);
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test_address_missing");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    logger.close?.();
    database.close();
    rmSync(directory, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it.each([
    [200, "info"],
    [403, "warn"],
    [503, "error"],
  ])("records a completed %i response once when the connection closes", async (status, level) => {
    app.get("/api/completed", (_request, response) => response.status(status).json({ ok: true }));
    const response = await fetch(`${baseUrl}/api/completed?token=private-query`, {
      headers: { Connection: "close", Cookie: "private-cookie" },
    });
    await response.json();
    await vi.waitFor(() => expect(readRows()).toHaveLength(1));
    expect(readRows()[0]).toMatchObject({ level, method: "GET", path: "/api/completed", status });
    expect(readRows()[0].durationMs).toEqual(expect.any(Number));
    expect(console[level as "info" | "warn" | "error"]).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(readRows())).not.toContain("private");
  });

  it("records a real client cancellation once without secrets or a misleading success status", async () => {
    let finishResponse!: Response;
    let entered!: () => void;
    const routeEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    app.post("/api/pending", (_request, response) => {
      finishResponse = response;
      entered();
    });
    const request = httpRequest(`${baseUrl}/api/pending?token=private-query`, {
      method: "POST",
      headers: { Cookie: "private-cookie" },
    });
    request.on("error", () => undefined);
    request.end("private-body");
    await routeEntered;
    expect(readRows()).toHaveLength(0);
    request.destroy();
    await vi.waitFor(() => expect(readRows()).toHaveLength(1));
    expect(readRows()[0]).toMatchObject({
      level: "warn",
      source: "server",
      method: "POST",
      path: "/api/pending",
      status: null,
      detail: null,
    });
    expect(readRows()[0].durationMs).toEqual(expect.any(Number));
    expect(console.warn).toHaveBeenCalledTimes(1);
    const output = JSON.parse(vi.mocked(console.warn).mock.calls[0][0] as string);
    expect(output.event).toBe("request_aborted");
    expect(JSON.stringify(output)).not.toContain("private");
    finishResponse.end("late-success");
    // A late handler completion must not turn an aborted connection into another success event.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(readRows()).toHaveLength(1);
    expect(console.info).not.toHaveBeenCalled();
  });

  it.each(["/health", "/api/logs", "/asset.js"])("keeps %s excluded", async (path) => {
    app.get(path, (_request, response) => response.json({ ok: true }));
    await (await fetch(`${baseUrl}${path}`, { headers: { Connection: "close" } })).json();
    expect(readRows()).toHaveLength(0);
    expect(console.info).not.toHaveBeenCalled();
    expect(console.warn).not.toHaveBeenCalled();
  });

  function readRows() {
    return database.db.select().from(logs).all();
  }
});
