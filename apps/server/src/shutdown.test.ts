import { EventEmitter } from "node:events";
import { createServer, request, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installShutdown, type ShutdownOptions } from "./shutdown";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function fixture(overrides: Partial<ShutdownOptions> = {}) {
  const events: string[] = [];
  const exited = deferred<number>();
  const signals = new EventEmitter();
  const options: ShutdownOptions = {
    server: {
      close: vi.fn((callback) => {
        callback?.();
        return {} as Server;
      }),
    },
    stopRuntime: vi.fn(() => {
      events.push("stop");
    }),
    cleanup: ["public", "library", "logger"].map((name) => ({
      name,
      close: vi.fn(() => {
        events.push(name);
      }),
    })),
    closeDatabase: vi.fn(() => {
      events.push("database");
    }),
    exit: vi.fn((code) => {
      events.push(`exit:${code}`);
      exited.resolve(code);
    }),
    report: vi.fn(),
    signals,
    timeoutMs: 1_000,
    ...overrides,
  };
  const shutdown = installShutdown(options);
  return { options, events, exited, signals, shutdown };
}

describe("bounded server shutdown", () => {
  const servers: Server[] = [];
  afterEach(() => {
    for (const server of servers.splice(0)) {
      server.closeAllConnections();
      server.close();
    }
    vi.useRealTimers();
  });

  async function busyServer() {
    const entered = deferred<void>();
    const release = deferred<void>();
    const server = createServer(async (_req, res) => {
      entered.resolve();
      await release.promise;
      res.end("completed");
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing test port");
    const response = new Promise<string>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port: address.port, agent: false }, (res) => {
        let body = "";
        res.on("data", (chunk) => {
          body += String(chunk);
        });
        res.on("end", () => resolve(body));
        res.on("error", reject);
      });
      req.on("error", reject);
      req.end();
    });
    // Attach a rejection handler before force-close teardown, while preserving assertions.
    void response.catch(() => undefined);
    await entered.promise;
    return { server, release, response };
  }

  it("stops scheduling immediately, then lets a real HTTP request finish before cleanup", async () => {
    const { server, release, response } = await busyServer();
    const f = fixture({ server });
    f.signals.emit("SIGTERM");
    expect(f.events).toEqual(["stop"]);
    expect(server.listening).toBe(false);
    release.resolve();
    expect(await response).toBe("completed");
    expect(await f.exited.promise).toBe(0);
    expect(f.events).toEqual(["stop", "public", "library", "logger", "database", "exit:0"]);
  });

  it("forces exit when a real HTTP request never drains, without closing its live DB", async () => {
    const { server } = await busyServer();
    const f = fixture({ server, timeoutMs: 30 });
    f.shutdown.shutdown();
    expect(await f.exited.promise).toBe(1);
    expect(f.events).toEqual(["stop", "exit:1"]);
    expect(f.options.report).toHaveBeenCalledWith("shutdown_timeout", "http");
    expect(f.options.closeDatabase).not.toHaveBeenCalled();
  });

  it("uses one deadline for awaited cleanup and consumes its late rejection", async () => {
    vi.useFakeTimers();
    const pending = deferred<void>();
    const f = fixture({ cleanup: [{ name: "public", close: () => pending.promise }], timeoutMs: 100 });
    f.shutdown.shutdown();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(100);
    expect(await f.exited.promise).toBe(1);
    expect(f.options.report).toHaveBeenCalledWith("shutdown_timeout", "public");
    pending.reject(new Error("late worker failure"));
    await Promise.resolve();
    await Promise.resolve();
    expect(f.options.exit).toHaveBeenCalledTimes(1);
    expect(f.options.closeDatabase).not.toHaveBeenCalled();
  });

  it("a second signal forces exit without starting cleanup again", async () => {
    const pending = deferred<void>();
    const f = fixture({ cleanup: [{ name: "library", close: vi.fn(() => pending.promise) }] });
    f.signals.emit("SIGINT");
    await Promise.resolve();
    f.signals.emit("SIGTERM");
    expect(await f.exited.promise).toBe(1);
    pending.resolve();
    await Promise.resolve();
    f.signals.emit("SIGINT");
    expect(f.options.stopRuntime).toHaveBeenCalledTimes(1);
    expect(f.options.cleanup[0].close).toHaveBeenCalledTimes(1);
    expect(f.options.closeDatabase).not.toHaveBeenCalled();
    expect(f.options.exit).toHaveBeenCalledTimes(1);
  });

  it.each(["runtime", "worker", "database"])("exits 1 on %s cleanup failure", async (stage) => {
    const fail = () => {
      throw new Error("cleanup failed");
    };
    const f = fixture({
      ...(stage === "runtime" ? { stopRuntime: fail } : {}),
      ...(stage === "worker" ? { cleanup: [{ name: "worker", close: fail }] } : {}),
      ...(stage === "database" ? { closeDatabase: fail } : {}),
    });
    f.shutdown.shutdown();
    expect(await f.exited.promise).toBe(1);
    expect(f.options.report).toHaveBeenCalledWith("shutdown_failed", stage);
    expect(f.options.exit).toHaveBeenCalledTimes(1);
  });

  it("still exits when diagnostic reporting throws, without a timer exception", async () => {
    vi.useFakeTimers();
    const f = fixture({
      server: { close: vi.fn(() => ({}) as Server) },
      report: () => {
        throw new Error("stderr failed");
      },
      timeoutMs: 10,
    });
    f.shutdown.shutdown();
    await vi.advanceTimersByTimeAsync(10);
    expect(await f.exited.promise).toBe(1);
  });
});
