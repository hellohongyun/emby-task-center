import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const localDataDirectory = resolve(".local");
mkdirSync(localDataDirectory, { recursive: true });

process.env.NODE_ENV = "production";
// This source-checkout launcher serves local development/preview data, which may
// contain a copy of real SMTP settings. Never deliver email from this entry point.
// The deployed container starts server/index.mjs directly and keeps its own policy.
process.env.EMAIL_DELIVERY_DISABLED = "true";
process.env.DEVELOPMENT_MODE = "true";
console.warn("本地开发／预览服务：邮件发送已禁用（包含验证码、测试邮件、通知及补发）。");
process.env.PORT ??= "3000";
process.env.DATABASE_PATH ??= resolve(localDataDirectory, "emby-task-center.db");
process.env.MIGRATIONS_PATH ??= resolve("packages/database/drizzle");
process.env.WEB_DIST_PATH ??= resolve("apps/web/dist");

await import("../dist/server/index.mjs");
