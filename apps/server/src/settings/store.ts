/**
 * 应用设置读写（P1 配置后台化）。
 *
 * 读取优先级：DB → env（仅当 DB 无该键）→ 注册表默认值。
 *  - env 只在"首次启动/键缺失"时作为种子，写入 DB 后一律以 DB 为准。
 *  - 密钥在 DB 中为明文（与 .env 同属一个信任边界，2026-09-10 用户决策），
 *    但接口一律返回掩码、日志需调用 redactSecrets 脱敏。
 */
import { randomBytes } from "node:crypto";

import { eq } from "drizzle-orm";

import type { AppDatabase } from "@emby-task-center/database/client";
import { appSettings } from "@emby-task-center/database/schema";
import {
  SECRET_SETTING_KEYS,
  SETTINGS,
  SETTING_KEYS,
  isSettingKey,
  settingDefinition,
  type SettingDefinition,
  type SettingKey,
  type SettingsSnapshot,
} from "./registry";

export type SettingSource = "db" | "env" | "default";

export interface SettingsReadResult {
  values: SettingsSnapshot;
  sources: Record<SettingKey, SettingSource>;
  /** 非法 DB 值 / 非法 env 值的告警（不阻断启动，读取时回落）。 */
  warnings: string[];
}

export interface SettingsWriteResult {
  updated: SettingKey[];
  rejected: Array<{ key: string; error: string }>;
}

export interface PublicSettingEntry {
  key: SettingKey;
  group: string;
  label: string;
  help?: string;
  /** 枚举/多选候选（后台配置页据此渲染开关）。 */
  choices?: ReadonlyArray<{ value: string; label: string; help?: string }>;
  /** 多行长文本：配置页渲染成 textarea（邮件正文、会员端提示文案等）。 */
  multiline?: boolean;
  secret: boolean;
  /** 密钥是否已有值（前端用于显示"已配置/未配置"，不回明文）。 */
  hasValue: boolean;
  source: SettingSource;
  value: unknown;
}

export const SECRET_MASK = "****";
export const SETTINGS_ACTOR_ADMIN = "admin";
export const SETTINGS_ACTOR_ENV_SEED = "env-seed";
export const SETTINGS_ACTOR_GENERATED = "generated";

function decodeEnvValue(key: SettingKey, raw: string): unknown {
  const definition: SettingDefinition = SETTINGS[key];
  if (definition.parseEnv) return definition.parseEnv(raw);
  const trimmed = raw.trim();
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return trimmed;
  }
}

export function readSettings(database: AppDatabase, env: NodeJS.ProcessEnv = process.env): SettingsReadResult {
  const rows = database.select().from(appSettings).all();
  const stored = new Map(rows.map((row) => [row.key, row.value]));
  const values = {} as Record<string, unknown>;
  const sources = {} as Record<SettingKey, SettingSource>;
  const warnings: string[] = [];

  for (const key of SETTING_KEYS) {
    const definition: SettingDefinition = SETTINGS[key];
    const rawStored = stored.get(key);
    if (rawStored !== undefined && rawStored !== null) {
      let decoded: unknown;
      try {
        decoded = JSON.parse(rawStored) as unknown;
      } catch {
        warnings.push(`设置项 ${key} 在数据库中的值不是合法 JSON，已回落`);
        decoded = undefined;
      }
      if (decoded !== undefined) {
        const parsed = definition.schema.safeParse(decoded);
        if (parsed.success) {
          values[key] = parsed.data;
          sources[key] = "db";
          continue;
        }
        warnings.push(`设置项 ${key} 的数据库值不合法（${parsed.error.issues[0]?.message ?? "unknown"}），已回落`);
      }
    }

    const envName = definition.env;
    const rawEnv = envName ? env[envName] : undefined;
    if (envName && rawEnv !== undefined && rawEnv.trim() !== "") {
      const parsed = definition.schema.safeParse(decodeEnvValue(key, rawEnv));
      if (parsed.success) {
        values[key] = parsed.data;
        sources[key] = "env";
        continue;
      }
      warnings.push(`环境变量 ${envName} 的值不合法（${parsed.error.issues[0]?.message ?? "unknown"}），已使用默认值`);
    }

    const fallback = definition.schema.safeParse(undefined);
    if (!fallback.success) {
      warnings.push(`设置项 ${key} 缺少默认值，已跳过`);
      continue;
    }
    values[key] = fallback.data;
    sources[key] = "default";
  }

  return { values: values as unknown as SettingsSnapshot, sources, warnings };
}

/** 读取单个设置项（等价于 readSettings(...).values[key]，便于业务代码按需取值）。 */
export function readSetting<K extends SettingKey>(
  database: AppDatabase,
  key: K,
  env: NodeJS.ProcessEnv = process.env,
): SettingsSnapshot[K] {
  const parsed = SETTINGS[key].schema.safeParse(readSettings(database, env).values[key]);
  if (!parsed.success) throw new Error(`设置项 ${key} 读取失败：${parsed.error.issues[0]?.message ?? "unknown"}`);
  return parsed.data as SettingsSnapshot[K];
}

/** 局部写入：未知键与非法值一律拒绝并回报，不写半套。 */
export function writeSettings(
  database: AppDatabase,
  patch: Record<string, unknown>,
  actor: string = SETTINGS_ACTOR_ADMIN,
): SettingsWriteResult {
  const updated: SettingKey[] = [];
  const rejected: Array<{ key: string; error: string }> = [];
  const timestamp = new Date().toISOString();

  for (const [key, value] of Object.entries(patch)) {
    if (!isSettingKey(key)) {
      rejected.push({ key, error: "未知设置项" });
      continue;
    }
    // 读取接口对密钥只回掩码 "****"。只要有人（脚本、手写请求、复制粘贴）把掩码当成新值写回来，
    // 就会把真密钥覆盖成四个星号——曾经真的发生过（会话密钥被写成 "****"）。这里直接拒绝。
    if (SECRET_SETTING_KEYS.has(key) && value === SECRET_MASK) {
      rejected.push({ key, error: "这是密钥掩码，不是真实值；留空表示不修改" });
      continue;
    }
    const parsed = SETTINGS[key].schema.safeParse(value);
    if (!parsed.success) {
      rejected.push({ key, error: parsed.error.issues[0]?.message ?? "取值不合法" });
      continue;
    }
    const row = { key, value: JSON.stringify(parsed.data), updatedAt: timestamp, updatedBy: actor };
    database
      .insert(appSettings)
      .values({ ...row, isSecret: SECRET_SETTING_KEYS.has(key) })
      .onConflictDoUpdate({
        target: appSettings.key,
        set: { value: row.value, updatedAt: timestamp, updatedBy: actor },
      })
      .run();
    updated.push(key);
  }

  return { updated, rejected };
}

/** 接口视图：密钥只回掩码 + hasValue，绝不回明文。 */
export function toPublicSettings(read: SettingsReadResult): PublicSettingEntry[] {
  // hidden 的设置项交给专属面板维护，不进「配置项」表单（同一条设置只有一个入口）。
  return SETTING_KEYS.filter((key) => settingDefinition(key).hidden !== true).map((key) => {
    const definition: SettingDefinition = settingDefinition(key);
    const secret = definition.secret === true;
    const value = read.values[key];
    const hasValue = secret ? String(value ?? "").length > 0 : value !== undefined && value !== null && value !== "";
    return {
      key,
      group: definition.group,
      label: definition.label,
      ...(definition.help ? { help: definition.help } : {}),
      ...(definition.choices ? { choices: definition.choices } : {}),
      ...(definition.multiline ? { multiline: true } : {}),
      secret,
      hasValue,
      source: read.sources[key],
      value: secret ? (hasValue ? SECRET_MASK : "") : value,
    };
  });
}

/** 把 DB 中缺席、但 env 有值的设置项导入 DB（存量部署升级用；已有值不覆盖）。 */
export function seedSettingsFromEnv(
  database: AppDatabase,
  env: NodeJS.ProcessEnv = process.env,
): { seeded: SettingKey[] } {
  const rows = new Set(
    database
      .select({ key: appSettings.key })
      .from(appSettings)
      .all()
      .map((row) => row.key),
  );
  const seeded: SettingKey[] = [];
  const timestamp = new Date().toISOString();

  for (const key of SETTING_KEYS) {
    const definition: SettingDefinition = SETTINGS[key];
    const envName = definition.env;
    if (!envName || rows.has(key)) continue;
    const raw = env[envName];
    if (raw === undefined || raw.trim() === "") continue;
    const parsed = definition.schema.safeParse(decodeEnvValue(key, raw));
    if (!parsed.success) continue;
    database
      .insert(appSettings)
      .values({
        key,
        value: JSON.stringify(parsed.data),
        isSecret: SECRET_SETTING_KEYS.has(key),
        updatedAt: timestamp,
        updatedBy: SETTINGS_ACTOR_ENV_SEED,
      })
      .onConflictDoNothing()
      .run();
    seeded.push(key);
  }

  return { seeded };
}

/** 首启生成会话签名密钥（避免固定默认值，且重启后会话不失效）。 */
export function ensureSessionSecret(database: AppDatabase): { generated: boolean } {
  const row = database.select().from(appSettings).where(eq(appSettings.key, "session.secret")).get();
  if (row?.value) {
    const parsed = SETTINGS["session.secret"].schema.safeParse(JSON.parse(row.value) as unknown);
    if (parsed.success && parsed.data) return { generated: false };
  }
  const secret = randomBytes(32).toString("base64url");
  writeSettings(database, { "session.secret": secret }, SETTINGS_ACTOR_GENERATED);
  return { generated: true };
}

/** 日志脱敏：把当前设置里的密钥明文从文本中抹掉（P1.2 接入 logger）。 */
export function redactSecrets(values: SettingsSnapshot, text: string): string {
  let result = text;
  for (const key of SECRET_SETTING_KEYS) {
    const secret = values[key];
    if (typeof secret !== "string" || secret.length < 4) continue;
    result = result.split(secret).join(SECRET_MASK);
  }
  return result;
}
