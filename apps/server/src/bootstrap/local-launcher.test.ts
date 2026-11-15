import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { expect, it } from "vitest";

it("forces local preview email off even when the caller requests production delivery", () => {
  const temporaryRoot = resolve(tmpdir());
  const directory = mkdtempSync(join(temporaryRoot, "local-mail-launcher-"));
  if (dirname(resolve(directory)) !== temporaryRoot) throw new Error("unsafe_test_cleanup_path");
  try {
    mkdirSync(join(directory, "scripts"));
    mkdirSync(join(directory, "dist/server"), { recursive: true });
    copyFileSync(resolve("scripts/start-production.mjs"), join(directory, "scripts/start-production.mjs"));
    // Import a harmless stand-in, never the real app or its tasks/database.
    writeFileSync(
      join(directory, "dist/server/index.mjs"),
      `console.log(JSON.stringify({
      disabled: process.env.EMAIL_DELIVERY_DISABLED,
      developmentMode: process.env.DEVELOPMENT_MODE,
      nodeEnv: process.env.NODE_ENV,
      port: process.env.PORT
    }));`,
    );
    const environment: NodeJS.ProcessEnv = {
      NODE_ENV: "production",
      EMAIL_DELIVERY_DISABLED: "false",
      DEVELOPMENT_MODE: "false",
    };
    for (const key of ["PATH", "Path", "SystemRoot", "WINDIR", "TEMP", "TMP"]) {
      if (process.env[key]) environment[key] = process.env[key];
    }
    const output = execFileSync(process.execPath, ["scripts/start-production.mjs"], {
      cwd: directory,
      env: environment,
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(JSON.parse(output)).toEqual({
      disabled: "true",
      developmentMode: "true",
      nodeEnv: "production",
      port: "3000",
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
