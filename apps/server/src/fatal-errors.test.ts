import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { buildSync } from "esbuild";
import { describe, expect, it, vi } from "vitest";
import { installFatalErrorHandlers } from "./fatal-errors";

function setup(overrides: Partial<Parameters<typeof installFatalErrorHandlers>[0]> = {}) {
  const target = new EventEmitter();
  const logger = { error: vi.fn(), close: vi.fn() };
  const exit = vi.fn();
  const writeStderr = vi.fn();
  const dispose = installFatalErrorHandlers({
    logger,
    redact: (text) => text.replaceAll("private-key", "[已隐藏]"),
    process: target as unknown as NodeJS.Process,
    exit,
    writeStderr,
    ...overrides,
  });
  return { target, logger, exit, writeStderr, dispose };
}

describe("fatal process error policy", () => {
  it.each(["uncaughtException", "unhandledRejection"])(
    "%s records safely and exits after synchronous close",
    (name) => {
      const state = setup();
      const error = new Error("private-key https://host/path?secret=credential\nfailed token=abc");
      state.target.emit(name, error);
      expect(state.exit).toHaveBeenCalledWith(1);
      expect(state.logger.close).toHaveBeenCalledOnce();
      expect(state.logger.error.mock.invocationCallOrder[0]).toBeLessThan(
        state.logger.close.mock.invocationCallOrder[0]!,
      );
      expect(state.logger.close.mock.invocationCallOrder[0]).toBeLessThan(state.exit.mock.invocationCallOrder[0]!);
      const logged = JSON.stringify(state.logger.error.mock.calls);
      expect(logged).not.toContain("private-key");
      expect(logged).not.toContain("credential");
      expect(logged).not.toContain("token=abc");
      expect(logged).not.toContain("fatal-errors.test.ts");
      expect(state.writeStderr.mock.calls[0]![0]).not.toContain("failed");
    },
  );

  it("exits even when stderr, logger, and logger close all throw", () => {
    const error = vi.fn(() => {
      throw new Error("logger broken");
    });
    const close = vi.fn(() => {
      throw new Error("close broken");
    });
    const state = setup({
      logger: { error, close },
      writeStderr: () => {
        throw new Error("stderr broken");
      },
    });
    expect(() => state.target.emit("unhandledRejection", new Error("private-key"))).not.toThrow();
    expect(state.exit).toHaveBeenCalledWith(1);
    expect(error).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it("suppresses errors whose conversion or redaction fails", () => {
    const state = setup({
      redact: () => {
        throw new Error("secret in redact error");
      },
    });
    state.target.emit("unhandledRejection", {
      toString: () => {
        throw new Error("private-key");
      },
    });
    expect(JSON.stringify(state.logger.error.mock.calls)).toContain("错误详情不可用");
    expect(JSON.stringify(state.logger.error.mock.calls)).not.toContain("private-key");
    expect(state.exit).toHaveBeenCalledWith(1);
  });

  it("does not recurse into logging when the handler is reentered", () => {
    const target = new EventEmitter();
    const error = vi.fn(() => target.emit("unhandledRejection", new Error("nested")));
    const state = setup({ process: target as unknown as NodeJS.Process, logger: { error } });
    target.emit("unhandledRejection", new Error("first"));
    expect(error).toHaveBeenCalledOnce();
    expect(state.exit).toHaveBeenCalledWith(1);
  });

  it("removes only installed listeners on disposal", () => {
    const state = setup();
    const other = vi.fn();
    state.target.on("unhandledRejection", other);
    state.dispose();
    state.target.emit("unhandledRejection", new Error("ordinary test"));
    expect(other).toHaveBeenCalledOnce();
    expect(state.exit).not.toHaveBeenCalled();
  });

  it.each(["throw", "reject", "broken-logger"])(
    "real child process %s exits 1 and cannot keep serving health",
    (mode) => {
      const directory = mkdtempSync(join(tmpdir(), "emby-fatal-policy-"));
      const fixture = join(directory, "fixture.ts");
      const output = join(directory, "fixture.mjs");
      try {
        writeFileSync(
          fixture,
          `
        import { createServer } from "node:http";
        import { installFatalErrorHandlers } from ${JSON.stringify(resolve("apps/server/src/fatal-errors.ts"))};
        const mode = process.argv[2];
        const logger = { error() { if (mode === "broken-logger") throw new Error("private-key"); }, close() {} };
        installFatalErrorHandlers({ logger, redact: text => text.replaceAll("private-key", "[hidden]") });
        const server = createServer((_request, response) => response.end("healthy"));
        server.listen(0, "127.0.0.1", () => {
          process.stdout.write("listening\\n");
          setTimeout(() => process.stdout.write("still-serving-health\\n"), 120);
          setImmediate(() => {
            if (mode === "throw") throw new Error("private-key");
            void Promise.reject(new Error("private-key"));
          });
        });
      `,
        );
        buildSync({
          entryPoints: [fixture],
          outfile: output,
          bundle: true,
          platform: "node",
          format: "esm",
          logLevel: "silent",
        });
        const result = spawnSync(process.execPath, [output, mode], { encoding: "utf8", timeout: 5_000, env: {} });
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(1);
        expect(result.stdout).toContain("listening");
        expect(result.stdout).not.toContain("still-serving-health");
        expect(result.stderr).toContain(mode === "throw" ? "uncaught_exception" : "unhandled_rejection");
        expect(result.stderr).not.toContain("private-key");
        expect(result.stderr).not.toContain("fixture.ts");
      } finally {
        // This path is created by mkdtemp above and contains only this test's fixture.
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );
});
