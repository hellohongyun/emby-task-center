import { describe, expect, it } from "vitest";

import {
  SECRET_SETTING_KEYS,
  SETTING_GROUP_LABELS,
  SETTING_GROUP_ORDER,
  SETTING_KEYS,
  defaultSettingValue,
  isSettingKey,
  settingDefinition,
} from "./registry";

describe("settings registry", () => {
  it("leaves deployment-specific upstream addresses unconfigured by default", () => {
    for (const key of ["emby.baseUrl", "emby.webUrl", "pansou.baseUrl"] as const) {
      expect(defaultSettingValue(key)).toBe("");
    }
  });

  it("gives every key a group, a label and a usable default", () => {
    for (const key of SETTING_KEYS) {
      const definition = settingDefinition(key);
      expect(definition.label.length, key).toBeGreaterThan(0);
      expect(SETTING_GROUP_ORDER, key).toContain(definition.group);
      expect(SETTING_GROUP_LABELS[definition.group], key).toBeTruthy();
      // 每个键都必须有默认值，否则首次启动读不到值
      expect(() => defaultSettingValue(key), key).not.toThrow();
    }
  });

  it("labels every group used by the roadmap", () => {
    for (const group of SETTING_GROUP_ORDER) {
      expect(SETTING_GROUP_LABELS[group]).toBeTruthy();
    }
  });

  it("maps each environment variable at most once", () => {
    const envNames = SETTING_KEYS.map((key) => settingDefinition(key).env).filter((name): name is string =>
      Boolean(name),
    );
    const duplicates = envNames.filter((name, index) => envNames.indexOf(name) !== index);
    expect(duplicates).toEqual([]);
  });

  it("marks exactly the credential-bearing keys as secret", () => {
    const expected = [
      "admin.passwordHash",
      "session.secret",
      "tmdb.token",
      "emby.apiKey",
      "email.password",
      "tgto.password",
      // AI 文案的 API Key：只由服务端使用，接口回掩码、日志脱敏
      "ai.apiKey",
    ];
    expect([...SECRET_SETTING_KEYS].sort()).toEqual(expected.sort());
  });

  it("recognises known keys only", () => {
    expect(isSettingKey("email.host")).toBe(true);
    expect(isSettingKey("nope.key")).toBe(false);
  });

  it("keeps bootstrap-only variables out of the registry", () => {
    const envNames = SETTING_KEYS.map((key) => settingDefinition(key).env);
    for (const bootstrap of ["PORT", "DATABASE_PATH", "MIGRATIONS_PATH", "WEB_DIST_PATH", "NODE_ENV", "TZ"]) {
      expect(envNames).not.toContain(bootstrap);
    }
  });
});
