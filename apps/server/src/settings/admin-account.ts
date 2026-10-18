/**
 * 管理员账号（P1）：口令哈希 + 首次启动写入默认 admin/admin123。
 *
 * 决策（2026-09-10 用户）：默认口令 `admin123` 落库，首次登录只**提示**修改、不强制。
 * 口令用 scrypt 加盐哈希存储；接口只回掩码，校验走 timingSafeEqual。
 */
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

import type { AppDatabase } from "@emby-task-center/database/client";
import { SETTINGS_ACTOR_GENERATED, readSettings, writeSettings } from "./store";

export const DEFAULT_ADMIN_USERNAME = "admin";
export const DEFAULT_ADMIN_PASSWORD = "admin123";

const KEY_LENGTH = 64;
const HASH_PREFIX = "scrypt";

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("base64url");
  const hash = scryptSync(password, salt, KEY_LENGTH).toString("base64url");
  return `${HASH_PREFIX}$${salt}$${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== HASH_PREFIX) return false;
  const [, salt, expected] = parts;
  if (!salt || !expected) return false;
  const actual = scryptSync(password, salt, KEY_LENGTH).toString("base64url");
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

export interface AdminAccountState {
  username: string;
  hasPassword: boolean;
  mustChangePassword: boolean;
}

export function readAdminAccount(database: AppDatabase): AdminAccountState {
  const { values } = readSettings(database);
  return {
    username: values["admin.username"] || DEFAULT_ADMIN_USERNAME,
    hasPassword: values["admin.passwordHash"].length > 0,
    mustChangePassword: values["admin.mustChangePassword"],
  };
}

/**
 * 首次启动初始化：DB 缺用户名/口令时写入默认 admin + admin123 并标记需修改。
 * 幂等：已有口令（管理员已改过）时绝不覆盖。
 */
export function ensureDefaultAdminAccount(
  database: AppDatabase,
  options: { username?: string; password?: string } = {},
): { created: boolean; username: string } {
  const state = readAdminAccount(database);
  if (state.hasPassword) return { created: false, username: state.username };

  const username = options.username ?? (state.username || DEFAULT_ADMIN_USERNAME);
  const password = options.password ?? DEFAULT_ADMIN_PASSWORD;
  writeSettings(
    database,
    {
      "admin.username": username,
      "admin.passwordHash": hashPassword(password),
      "admin.mustChangePassword": true,
    },
    SETTINGS_ACTOR_GENERATED,
  );
  return { created: true, username };
}

export type AdminLoginResult = { status: "ok"; username: string; mustChangePassword: boolean } | { status: "invalid" };

/** 校验管理员凭据（用户名 + 口令）。用户名留空时按旧行为只校验口令，兼容存量前端。 */
export function verifyAdminCredentials(
  database: AppDatabase,
  username: string | undefined,
  password: string,
): AdminLoginResult {
  const { values } = readSettings(database);
  const storedHash = values["admin.passwordHash"];
  if (!storedHash) return { status: "invalid" };
  if (username !== undefined && username !== "" && username !== values["admin.username"]) {
    return { status: "invalid" };
  }
  if (!verifyPassword(password, storedHash)) return { status: "invalid" };
  return {
    status: "ok",
    username: values["admin.username"],
    mustChangePassword: values["admin.mustChangePassword"],
  };
}

export type ChangePasswordResult = { status: "ok" } | { status: "invalid_current" } | { status: "too_short" };

/** 修改管理员口令（需旧口令）；成功后清除"仍需修改默认口令"标记。 */
export function changeAdminPassword(
  database: AppDatabase,
  currentPassword: string,
  nextPassword: string,
  minimumLength = 8,
): ChangePasswordResult {
  const { values } = readSettings(database);
  if (!values["admin.passwordHash"] || !verifyPassword(currentPassword, values["admin.passwordHash"])) {
    return { status: "invalid_current" };
  }
  if (nextPassword.length < minimumLength) return { status: "too_short" };
  writeSettings(database, {
    "admin.passwordHash": hashPassword(nextPassword),
    "admin.mustChangePassword": false,
  });
  return { status: "ok" };
}
