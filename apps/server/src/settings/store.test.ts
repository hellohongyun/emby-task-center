import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDatabase, type DatabaseHandle } from "@emby-task-center/database/client";
import { SETTING_KEYS } from "./registry";
import {
  SECRET_MASK,
  ensureSessionSecret,
  readSetting,
  readSettings,
  redactSecrets,
  seedSettingsFromEnv,
  toPublicSettings,
  writeSettings,
} from "./store";

describe("settings store", () => {
  let directory: string;
  let database: DatabaseHandle;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "emby-settings-"));
    database = createDatabase(join(directory, "app.sqlite"));
  });

  afterEach(() => {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("falls back to registry defaults on an empty database", () => {
    const read = readSettings(database.db, {});
    expect(read.warnings).toEqual([]);
    expect(read.values["library.scanIntervalMinutes"]).toBe(30);
    expect(read.values["email.port"]).toBe(587);
    expect(read.values["admin.username"]).toBe("admin");
    expect(read.values["pansou.enabledPlatforms"]).toEqual(["115", "magnet"]);
    for (const key of SETTING_KEYS) expect(read.sources[key], key).toBe("default");
  });

  it("round-trips a write and reports the database as the source", () => {
    const result = writeSettings(database.db, {
      "email.host": "smtp.example.com",
      "email.secure": true,
      "library.scanIntervalMinutes": 15,
    });
    expect(result.rejected).toEqual([]);
    expect(result.updated.sort()).toEqual(["email.host", "email.secure", "library.scanIntervalMinutes"]);
    const read = readSettings(database.db, {});
    expect(read.values["email.host"]).toBe("smtp.example.com");
    expect(read.values["email.secure"]).toBe(true);
    expect(read.values["library.scanIntervalMinutes"]).toBe(15);
    expect(read.sources["email.host"]).toBe("db");
  });

  it("rejects unknown keys and invalid values without writing the rest of the patch", () => {
    const result = writeSettings(database.db, {
      "nope.key": 1,
      "library.scanMode": "sideways",
      "email.port": "not-a-port",
    });
    expect(result.updated).toEqual([]);
    expect(result.rejected.map((item) => item.key).sort()).toEqual(["email.port", "library.scanMode", "nope.key"]);
    expect(readSettings(database.db, {}).sources["email.port"]).toBe("default");
  });

  it("imports env values only while the key is absent, then the database wins", () => {
    const env = { SMTP_HOST: "smtp.seed.test", PANSOU_ENABLED_PLATFORMS: "115,magnet,123", TMDB_TOKEN: "seed-token" };

    const seeded = seedSettingsFromEnv(database.db, env);
    expect(seeded.seeded).toContain("email.host");
    expect(seeded.seeded).toContain("pansou.enabledPlatforms");
    expect(seeded.seeded).toContain("tmdb.token");

    const afterSeed = readSettings(database.db, env);
    expect(afterSeed.values["email.host"]).toBe("smtp.seed.test");
    expect(afterSeed.values["pansou.enabledPlatforms"]).toEqual(["115", "magnet", "123"]);
    expect(afterSeed.sources["tmdb.token"]).toBe("db");

    writeSettings(database.db, { "email.host": "smtp.admin.test" });
    expect(readSettings(database.db, env).values["email.host"]).toBe("smtp.admin.test");

    // 二次播种不覆盖已有值
    const secondSeeded = seedSettingsFromEnv(database.db, env);
    expect(secondSeeded.seeded).not.toContain("email.host");
  });

  it("uses env as fallback before any write and warns on unusable env values", () => {
    const read = readSettings(database.db, { SMTP_HOST: "smtp.env.test", LIBRARY_SCAN_INTERVAL_MINUTES: "-5" });
    expect(read.values["email.host"]).toBe("smtp.env.test");
    expect(read.sources["email.host"]).toBe("env");
    expect(read.warnings.join()).toContain("LIBRARY_SCAN_INTERVAL_MINUTES");
    expect(read.values["library.scanIntervalMinutes"]).toBe(30);
  });

  it("never exposes secret plaintext through the public view", () => {
    writeSettings(database.db, { "tmdb.token": "super-secret-token", "email.password": "super-secret-pass" });
    const entries = toPublicSettings(readSettings(database.db, {}));
    const serialised = JSON.stringify(entries);
    expect(serialised).not.toContain("super-secret-token");
    expect(serialised).not.toContain("super-secret-pass");

    const tmdb = entries.find((entry) => entry.key === "tmdb.token");
    expect(tmdb?.secret).toBe(true);
    expect(tmdb?.hasValue).toBe(true);
    expect(tmdb?.value).toBe(SECRET_MASK);

    const empty = entries.find((entry) => entry.key === "tgto.password");
    expect(empty?.hasValue).toBe(false);
    expect(empty?.value).toBe("");

    const plain = entries.find((entry) => entry.key === "email.host");
    expect(plain?.secret).toBe(false);
  });

  it("refuses to write the secret mask back as a value", () => {
    // 读取接口对密钥只回 "****"；万一有人把它当新值写回来，会把真密钥覆盖成四个星号。
    writeSettings(database.db, { "tmdb.token": "real-token" });
    const result = writeSettings(database.db, { "tmdb.token": SECRET_MASK });
    expect(result.updated).toEqual([]);
    expect(result.rejected[0]?.key).toBe("tmdb.token");
    expect(readSettings(database.db, {}).values["tmdb.token"]).toBe("real-token");
  });

  it("redacts secret values from log text", () => {
    writeSettings(database.db, { "tmdb.token": "super-secret-token" });
    const { values } = readSettings(database.db, {});
    expect(redactSecrets(values, "调用失败 token=super-secret-token 结束")).toBe(`调用失败 token=${SECRET_MASK} 结束`);
  });

  it("generates the session secret once and keeps it stable", () => {
    expect(ensureSessionSecret(database.db).generated).toBe(true);
    const first = readSetting(database.db, "session.secret", {});
    expect(first.length).toBeGreaterThanOrEqual(32);

    expect(ensureSessionSecret(database.db).generated).toBe(false);
    expect(readSetting(database.db, "session.secret", {})).toBe(first);

    const entry = toPublicSettings(readSettings(database.db, {})).find((item) => item.key === "session.secret");
    expect(entry?.value).toBe(SECRET_MASK);
  });
});
