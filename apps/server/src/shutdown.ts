import type { Server } from "node:http";

export interface ShutdownOptions {
  server: Pick<Server, "close">;
  stopRuntime(): void;
  /** The database must be last; exit follows its synchronous close without another await. */
  cleanup: Array<{ name: string; close(): void | Promise<void> }>;
  closeDatabase(): void;
  exit(code: number): void;
  report(event: "shutdown_timeout" | "shutdown_failed" | "shutdown_forced", detail: string): void;
  timeoutMs?: number;
  signals?: {
    on(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
    removeListener(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  };
}

/** One deadline covers HTTP draining and all resource cleanup. */
export function installShutdown(options: ShutdownOptions) {
  let started = false;
  let finished = false;
  let stage = "runtime";
  let deadline: ReturnType<typeof setTimeout> | undefined;

  function finish(code: number) {
    if (finished) return;
    finished = true;
    clearTimeout(deadline);
    options.exit(code);
  }

  function fail(event: "shutdown_timeout" | "shutdown_failed" | "shutdown_forced") {
    // Reporting must not prevent process termination, including after logger shutdown.
    try {
      options.report(event, stage);
    } catch {
      // Diagnostics are best effort; a failed sink must not escape a timer callback.
    } finally {
      finish(1);
    }
  }

  async function drain() {
    try {
      options.stopRuntime();
      stage = "http";
      await new Promise<void>((resolve, reject) => {
        options.server.close((error) => (error ? reject(error) : resolve()));
      });
      for (const resource of options.cleanup) {
        if (finished) return;
        stage = resource.name;
        await resource.close();
      }
      if (finished) return;
      // Runtime stop prevents future scheduling, but pending jobs may still own this DB.
      // Keep it open throughout awaited cleanup, then close and exit in the same turn.
      stage = "database";
      options.closeDatabase();
      finish(0);
    } catch {
      if (!finished) fail("shutdown_failed");
    }
  }

  function shutdown() {
    if (finished) return;
    if (started) {
      fail("shutdown_forced");
      return;
    }
    started = true;
    deadline = setTimeout(() => fail("shutdown_timeout"), options.timeoutMs ?? 25_000);
    // Keep the deadline referenced even after the listener socket has closed.
    void drain().catch(() => finish(1));
  }

  options.signals?.on("SIGINT", shutdown);
  options.signals?.on("SIGTERM", shutdown);
  return {
    shutdown,
    removeSignalListeners() {
      options.signals?.removeListener("SIGINT", shutdown);
      options.signals?.removeListener("SIGTERM", shutdown);
    },
  };
}
