#!/usr/bin/env node
/**
 * 零 env 启动冒烟（P1.2 验收脚本）。
 *
 * 验证目标：除 bootstrap 变量（PORT / DATABASE_PATH / MIGRATIONS_PATH）外不给任何配置，
 * 服务仍能启动、自动建库、初始化默认管理员，并且 admin / admin123 能登录。
 * （MIGRATIONS_PATH 属部署参数：容器内是 /app/drizzle，本地是 packages/database/drizzle。）
 *
 * 用法：
 *   node scripts/smoke-zero-env.mjs          # 需要先 pnpm build（依赖 dist/server/index.mjs）
 *   SMOKE_PORT=3310 node scripts/smoke-zero-env.mjs
 *
 * 注意：下面 CONFIG_VARS 是"当前应可后台化"的配置面；新增设置项时同步补进这个列表，
 * 否则这条冒烟就不再证明"零 env 可启动"。
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const entry = join(root, "dist", "server", "index.mjs");
const port = Number(process.env.SMOKE_PORT ?? 3210);
const directory = mkdtempSync(join(tmpdir(), "etc-smoke-zero-env-"));

/** 应全部由数据库设置接管、不再从 env 读取的变量。 */
const CONFIG_VARS = [
  "ADMIN_USERNAME",
  "SESSION_VALIDITY_DAYS",
  "AUTH_MAX_FAILED_ATTEMPTS",
  "AUTH_LOCKOUT_BASE_SECONDS",
  "AUTH_LOCKOUT_MINUTES",
  "TMDB_TOKEN",
  "EMBY_ENABLED",
  "EMBY_BASE_URL",
  "EMBY_API_KEY",
  "SMTP_HOST",
  "SMTP_PORT",
  "SMTP_SECURE",
  "SMTP_USERNAME",
  "SMTP_PASSWORD",
  "SMTP_FROM_NAME",
  "SMTP_FROM_ADDRESS",
  "PANSOU_BASE_URL",
  "PANSOU_SEARCH_SRC",
  "PANSOU_ENABLED_PLATFORMS",
  "PANSOU_TIMEOUT_MS",
  "PANSOU_MAGNET_TARGET",
  "TGTO_DRIVE_BASE_URL",
  "TGTO_DRIVE_USERNAME",
  "TGTO_DRIVE_PASSWORD",
  "TGTO_BOT_USERNAME",
  "TGTO_INGEST_SOURCE",
  "TGTO_INGEST_DRY_RUN",
  "TG_API_ID",
  "TG_API_HASH",
  "TG_SESSION",
  "TG_INGEST_POLL_MS",
  "TG_INGEST_TIMEOUT_MS",
  "LIBRARY_BACKEND",
  "LIBRARY_SCAN_MODE",
  "LIBRARY_SCAN_INTERVAL_MINUTES",
  "LIBRARY_IDLE_SCAN_INTERVAL_MINUTES",
  "AIR_PROGRESS_REFRESH_INTERVAL_MINUTES",
  "MOVIE_TASK_RETENTION_HOURS",
  "LOG_RETENTION_DAYS",
  "LOG_MAX_ROWS",
  "REDIS_URL",
  // 已删除的旧子系统配置 + 旧共享口令模型
  "SHARED_PASSWORD",
  "SESSION_SECRET",
  "MCP_TOKEN",
  "MCP_ALLOWED_HOSTS",
  "MCP_ALLOWED_ORIGINS",
  "LITEPAN_BASE_URL",
  "LITEPAN_API_TOKEN",
  "AGENT_WEBHOOK_TOKEN",
  "AGENT_WEBHOOK_BASE_URL",
  "MEDIA_ROOTS_JSON",
  "WEB_DIST_PATH",
];

// 只保留 bootstrap/部署变量；其余配置一律为空，以此证明"零配置可启动"。
const childEnv = {
  ...process.env,
  PORT: String(port),
  DATABASE_PATH: join(directory, "app.sqlite"),
  MIGRATIONS_PATH: join(root, "packages", "database", "drizzle"),
  NODE_ENV: "test",
  TZ: "UTC",
};
for (const name of CONFIG_VARS) delete childEnv[name];

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
}

let output = "";
const child = spawn(process.execPath, [entry], { cwd: root, env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
child.stdout.on("data", (chunk) => (output += chunk));
child.stderr.on("data", (chunk) => (output += chunk));

const baseUrl = `http://127.0.0.1:${port}`;

async function waitForHealth(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return await response.json();
    } catch {
      /* 还没起来 */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return null;
}

try {
  const health = await waitForHealth();
  record("服务在零配置下启动并响应 /health", health?.status === "ok", JSON.stringify(health ?? {}));

  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "admin123" }),
  });
  const loginBody = await login.json().catch(() => null);
  record(
    "默认管理员 admin/admin123 可登录",
    login.status === 200,
    `status=${login.status} body=${JSON.stringify(loginBody)}`,
  );
  record(
    "登录响应带默认口令提示",
    loginBody?.mustChangePassword === true,
    `mustChangePassword=${loginBody?.mustChangePassword}`,
  );
  const cookie = login.headers.get("set-cookie")?.split(";", 1)[0] ?? "";

  const wrongPassword = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "definitely-wrong" }),
  });
  record(
    "错误口令被拒（且触发锁定策略）",
    wrongPassword.status === 401 || wrongPassword.status === 429,
    `status=${wrongPassword.status}`,
  );

  const guarded = await fetch(`${baseUrl}/api/logs`);
  record("未登录访问受保护接口返回 401", guarded.status === 401, `status=${guarded.status}`);

  const authenticated = await fetch(`${baseUrl}/api/logs`, { headers: { cookie } });
  record("带会话 cookie 可访问受保护接口", authenticated.status === 200, `status=${authenticated.status}`);

  record("启动日志确认设置已初始化", output.includes("settings_initialised"), "查找 settings_initialised 事件");
  record(
    "启动日志未泄漏任何密钥字段",
    !/"(passwordHash|session\.secret|apiKey|token)"\s*:\s*"[^"]+"/i.test(output),
    "扫描 stdout/stderr",
  );

  // 回归：SMTP「保存即生效」。
  // 曾经邮件参数只在进程启动时读一次，后台填好 SMTP 后「系统设置」仍显示"未配置"、
  // 测试邮件按钮一直是灰的，必须重启进程才"突然好了"。这里用真实进程验证不需要重启。
  const statusBefore = await (await fetch(`${baseUrl}/api/integrations/status`, { headers: { cookie } })).json();
  record(
    "零配置时邮件显示未配置并说清缺哪几项",
    statusBefore.emailConfigured === false && statusBefore.emailMissing?.length === 2,
    JSON.stringify(statusBefore),
  );

  const saved = await fetch(`${baseUrl}/api/settings`, {
    method: "PATCH",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({
      values: {
        "email.host": "smtp.example.com",
        "email.port": 465,
        "email.secure": true,
        "email.fromAddress": "ops@example.com",
      },
    }),
  });
  record("后台保存 SMTP 设置成功", saved.status === 200, `status=${saved.status}`);

  const statusAfter = await (await fetch(`${baseUrl}/api/integrations/status`, { headers: { cookie } })).json();
  record(
    "不重启进程，邮件状态当场变为已配置",
    statusAfter.emailConfigured === true && statusAfter.emailMissing?.length === 0,
    JSON.stringify(statusAfter),
  );
} catch (error) {
  record("冒烟脚本异常", false, String(error && error.message ? error.message : error));
} finally {
  child.kill();
  await new Promise((resolve) => setTimeout(resolve, 500));
  rmSync(directory, { recursive: true, force: true });
}

const failed = results.filter((item) => !item.ok);
console.log(`\n零 env 冒烟：通过 ${results.length - failed.length} / 失败 ${failed.length}`);
if (failed.length > 0) {
  console.log("服务输出片段：\n" + output.slice(-3000));
}
process.exit(failed.length === 0 ? 0 : 1);
