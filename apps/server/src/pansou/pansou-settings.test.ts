import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDatabase, type DatabaseHandle } from "@emby-task-center/database/client";
import { DEFAULT_ENABLED_PLATFORMS } from "./pansou-filter";
import { pansouPlatformSettings } from "@emby-task-center/database/schema";
import { writeSettings } from "../settings/store";
import {
  listPansouPlatformSettings,
  readEnabledPansouPlatforms,
  saveEnabledPansouPlatforms,
  savePansouPlatformEnabled,
} from "./pansou-settings";

describe("pansou platform settings", () => {
  let directory: string;
  let database: DatabaseHandle;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "emby-pansou-settings-"));
    database = createDatabase(join(directory, "app.sqlite"));
  });

  afterEach(() => {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("seeds defaults with 115/磁力 enabled and 123/光鸭 disabled", () => {
    const platforms = listPansouPlatformSettings(database.db);
    expect(platforms.find((p) => p.platform === "115")?.enabled).toBe(true);
    expect(platforms.find((p) => p.platform === "magnet")?.enabled).toBe(true);
    expect(platforms.find((p) => p.platform === "123")?.enabled).toBe(false);
    expect(platforms.find((p) => p.platform === "other")?.enabled).toBe(false);
  });

  it("seeded defaults agree with the in-code fallback constant", () => {
    // 防止 migrate.ts 种子行与 DEFAULT_ENABLED_PLATFORMS 再次漂移（两者曾长期矛盾）。
    expect(readEnabledPansouPlatforms(database.db)).toEqual(expect.arrayContaining(DEFAULT_ENABLED_PLATFORMS));
    for (const key of ["123", "other"]) {
      expect(DEFAULT_ENABLED_PLATFORMS).not.toContain(key);
      expect(readEnabledPansouPlatforms(database.db)).not.toContain(key);
    }
  });

  it("disables a platform and reflects in enabled list", () => {
    savePansouPlatformEnabled(database.db, "115", false);
    const enabled = readEnabledPansouPlatforms(database.db);
    expect(enabled).toContain("magnet");
    expect(enabled).not.toContain("115");
  });
});

describe("pansou settings source of truth", () => {
  let directory: string;
  let database: DatabaseHandle;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "emby-pansou-source-"));
    database = createDatabase(join(directory, "app.sqlite"));
  });

  afterEach(() => {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("reads the enabled platforms from the settings store, not the legacy table", () => {
    // 直接写设置项（等价于后台配置页保存）
    writeSettings(database.db, { "pansou.enabledPlatforms": ["123", "quark"] });
    expect(readEnabledPansouPlatforms(database.db)).toEqual(["123", "quark"]);

    // 旧表怎么改都不再影响结果（它只在启动时一次性导入）
    database.db.update(pansouPlatformSettings).set({ enabled: true }).run();
    expect(readEnabledPansouPlatforms(database.db)).toEqual(["123", "quark"]);
  });

  it("ignores unknown platform keys and falls back to defaults when nothing is enabled", () => {
    writeSettings(database.db, { "pansou.enabledPlatforms": ["nonsense"] });
    expect(readEnabledPansouPlatforms(database.db)).toEqual([...DEFAULT_ENABLED_PLATFORMS]);
  });

  it("keeps the admin read-only view in sync with the setting", () => {
    saveEnabledPansouPlatforms(database.db, ["magnet"]);
    const rows = listPansouPlatformSettings(database.db);
    expect(rows.find((row) => row.platform === "magnet")?.enabled).toBe(true);
    expect(rows.find((row) => row.platform === "115")?.enabled).toBe(false);
  });
});
