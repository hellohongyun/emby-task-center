/**
 * env 卫生守卫（P1 配置后台化之后的边界）。
 *
 * 背景：业务配置的唯一权威是数据库 `app_settings`（系统设置页）。env 只剩三类：
 *   ① 启动引导（bootstrap）：打开数据库之前就要有值，只能来自 env；
 *   ② compose 自己的变量（发布端口/挂载卷/容器时区），应用根本不读；
 *   ③ 老部署的迁移种子：注册表里带 env 名的设置项，只在"库里还没有该键"时写入一次。
 *
 * 这份测试把三条边界钉死，防止以后又出现"以为改 .env 生效、其实早就不读了"的坑
 * （典型：SHARED_PASSWORD / SESSION_SECRET / MEDIA_ROOTS_JSON / LIBRARY_BACKEND 这些历史键）。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { SETTINGS } from "./registry";

/** 应用启动时**直接读**的 env（见 bootstrap/env.ts）：这些键改了要重启进程。 */
const BOOTSTRAP_ENV = ["PORT", "DATABASE_PATH", "MIGRATIONS_PATH", "WEB_DIST_PATH"];

/** compose 用的部署变量：应用不读，Docker 用来发布端口/挂载数据目录/设容器时区。 */
const COMPOSE_ENV = ["APP_BIND_ADDRESS", "APP_PORT", "DATA_PATH", "TZ"];

/**
 * 已确认失效的历史键：写了也不会被读取。
 * 谁要是把它们加回注册表（或写回部署模板），这条测试会红——因为"配了不生效"比"没地方配"更难排查。
 */
const DEAD_LEGACY_ENV = [
  "SHARED_PASSWORD",
  "SESSION_SECRET",
  "MEDIA_ROOTS_JSON",
  "STRM_PATH",
  "LIBRARY_BACKEND",
  "EMBY_PROXY_ENABLED",
  "EMBY_PROXY_UPSTREAM",
  "TG_API_ID",
  "TG_API_HASH",
  "TG_SESSION",
  "TGTO_BOT_USERNAME",
  "TGTO_INGEST_SOURCE",
  "TGTO_INGEST_DRY_RUN",
  "PANSOU_MAGNET_TARGET",
];

function registryEnvNames(): string[] {
  return Object.values(SETTINGS)
    .map((definition) => (definition as { env?: string }).env)
    .filter((name): name is string => typeof name === "string" && name.length > 0);
}

/** 解析一个 dotenv 风格文件里的**生效键**（忽略注释与空行）。 */
function activeKeysOf(path: string): string[] {
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#") && line.includes("="))
    .map((line) => line.slice(0, line.indexOf("=")).trim());
}

describe("env 边界（业务配置一律在数据库里）", () => {
  it("bootstrap 变量不属于任何设置项：不会被后台设置悄悄覆盖", () => {
    const registryEnv = registryEnvNames();
    for (const name of BOOTSTRAP_ENV) {
      expect(registryEnv, `${name} 是启动引导变量，不该同时是某个设置项的 env`).not.toContain(name);
    }
  });

  it("失效的历史键没有回到注册表里（避免「配了不生效」）", () => {
    const registryEnv = registryEnvNames();
    for (const name of DEAD_LEGACY_ENV) {
      expect(registryEnv, `${name} 已废弃：要么删掉，要么明确恢复成设置项`).not.toContain(name);
    }
  });

  it("源码部署模板里只有部署变量，没有业务配置", () => {
    const keys = activeKeysOf(resolve(".env.example"));
    const allowed = new Set(COMPOSE_ENV);
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(allowed, `.env.example 里的 ${key} 不是部署变量；业务配置请放系统设置页`).toContain(key);
    }
  });
});
