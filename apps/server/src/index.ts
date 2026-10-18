import { createApp } from "./app";
import { writeSync } from "node:fs";
import { installFatalErrorHandlers } from "./fatal-errors";
import { readBootstrapEnv } from "./bootstrap/env";
import { startRuntime } from "./scheduling/runtime";
import { ensureDefaultAdminAccount, verifyAdminCredentials } from "./settings/admin-account";
import { migrateLegacyConfig } from "./settings/legacy-migration";
import { ensureSessionSecret, readSettings, redactSecrets, seedSettingsFromEnv } from "./settings/store";
import { createDatabase } from "@emby-task-center/database/client";
import { createLibraryService } from "./library/service";
import { createMissingEpisodeScanner } from "./library/missing-episode-scan";
import { closeMissingRootReader } from "./library/missing-root-reader";
import { createEmbyScan } from "./library/emby-scanner";
import { createEmbyRootsSource } from "./library/emby-roots";
import { createTmdbClient } from "./tmdb/client";
import { createEmbyClient } from "./integrations/emby-client";
import { getRuntimeSettings, initRuntimeSettings } from "./settings/runtime";
import { createEmailNotifier } from "./notifications/email-service";
import { createTgtoDriveClientFromConfig } from "./integrations/tgtodrive-client";
import { createLogger } from "./logging/logger";
import { createCacheStore } from "./trending/cache";
import { createTrendingService } from "./trending/service";
import { createPansouClient } from "./pansou/pansou-client";
import { createResourceTokenStore } from "./pansou/resource-tokens";
import { ALL_PLATFORMS, type PansouPlatformKey } from "./pansou/pansou-filter";
import { installShutdown } from "./shutdown";
import { createVirtualLibraryProxy } from "./virtual-libraries/proxy";

// P3：bootstrap 变量集中解析（其余配置一律来自数据库设置）。
const bootstrap = readBootstrapEnv();
const database = createDatabase(bootstrap.databasePath, bootstrap.migrationsPath);

// ── P1 配置后台化（阶段二）：配置一律以数据库为准 ───────────────────────────
// 读取优先级：DB → env（仅在键缺失时作为首次种子）→ 注册表默认值。
// 只有 bootstrap 变量仍读 env：PORT / DATABASE_PATH / MIGRATIONS_PATH / WEB_DIST_PATH
// （以及 compose 层的 APP_BIND_ADDRESS / APP_PORT / DATA_PATH）。
const settingsSeed = seedSettingsFromEnv(database.db);
// P1.4：把旧配置表（concurrency_policy / submission / notify_retention / mail_default）
// 一次性导入设置存储；只补缺、不覆盖，可反复执行。
const legacyMigration = migrateLegacyConfig(database.db);
const sessionSecretState = ensureSessionSecret(database.db);
const adminAccount = ensureDefaultAdminAccount(database.db);
const settingsRead = readSettings(database.db);
const settings = settingsRead.values;
const logger = createLogger(database.db, {
  databasePath: bootstrap.databasePath,
  retentionDays: settings["logs.retentionDays"],
  maxRows: settings["logs.maxRows"],
  // 设置里的密钥明文不得落进日志。
  redact: (text) => redactSecrets(settings, text),
});
installFatalErrorHandlers({ logger, redact: (text) => redactSecrets(settings, text) });
if (
  settingsSeed.seeded.length > 0 ||
  legacyMigration.migrated.length > 0 ||
  legacyMigration.repaired.length > 0 ||
  sessionSecretState.generated ||
  adminAccount.created
) {
  logger.info({
    event: "settings_initialised",
    message: "应用设置已初始化",
    detail: JSON.stringify({
      seededFromEnv: settingsSeed.seeded.length,
      migratedFromLegacyTables: legacyMigration.migrated.length,
      repairedCopyKeys: legacyMigration.repaired.length,
      sessionSecretGenerated: sessionSecretState.generated,
      adminCreated: adminAccount.created,
    }),
  });
}
for (const warning of settingsRead.warnings) {
  logger.warn({ event: "settings_warning", message: "设置项回落默认值", detail: warning });
}

const port = bootstrap.port;
const embyBaseUrl = settings["emby.baseUrl"] || undefined;
const embyApiKey = settings["emby.apiKey"] || undefined;
// 运行时快照：后台改 Emby 地址/密钥后保存即生效，不必重启（见 settings/runtime.ts）。
initRuntimeSettings(database.db);
const emby = createEmbyClient({
  resolve: () => {
    const live = getRuntimeSettings();
    return { baseUrl: live.embyBaseUrl || undefined, apiKey: live.embyApiKey || undefined };
  },
});
// 媒体库只有一个信息源：Emby。
// 库根不写死，而是"每次都能重新问 Emby"的来源（Emby 侧增删库、改名都会跟随）。
const library = createLibraryService(createEmbyRootsSource(emby), createEmbyScan(emby), database.db, {
  databasePath: bootstrap.databasePath,
});
const tmdb = createTmdbClient({ token: settings["tmdb.token"] });
// 全库缺集检测器：同一实例交给 HTTP 路由（读状态/手动触发）与后台定时任务（每小时一轮）。
// Emby 用来校验 TMDB 标识（库里同名但 TMDB id 对不上的条目不报缺集）。
const missingEpisodeScanner = createMissingEpisodeScanner({ database: database.db, tmdb, emby });
// 新版架构：TgtoDrive 负责搜索/转存/整理/STRM，emby-task-center 只做跟踪提醒。
// 并发限播由会话看门狗执行（见 scheduling/runtime.ts），不在请求层拦截。
// 旧版 AI 通知/队列（LitePan + AI 自动化）已移除。
const embyEnabled = settings["emby.enabled"] && Boolean(embyBaseUrl && embyApiKey);
const publicEmbyBaseUrl = embyBaseUrl;
const trendingCache = await createCacheStore(settings["cache.redisUrl"] || undefined);
const trendingService = createTrendingService({
  database: database.db,
  tmdbToken: settings["tmdb.token"],
  cache: trendingCache,
  log: (event, message) => logger.info({ event, message: message ?? event }),
});

// 保存即生效：SMTP 参数每次发信时从运行时快照现取（与 Emby 客户端同一套机制）。
// 以前是启动时读一次快照，后台配好 SMTP 后状态卡片仍显示"未配置"、测试邮件也发不出去，直到重启。
const email = createEmailNotifier({ resolve: () => getRuntimeSettings().email });
const movieTaskRetentionHours = settings["tasks.movieRetentionHours"];

// PanSou 聚合搜索（后端代理）：前端只拿 resourceId，链接与网盘名留在服务端。
const pansouClient = createPansouClient({
  baseUrl: settings["pansou.baseUrl"],
  src: settings["pansou.searchSrc"],
  timeoutMs: settings["pansou.timeoutMs"],
});
const pansouTokens = createResourceTokenStore();
// 只保留系统认识的平台键（注册表里是自由字符串数组）。
const pansouEnabledPlatforms = settings["pansou.enabledPlatforms"].filter((platform): platform is PansouPlatformKey =>
  (ALL_PLATFORMS as readonly string[]).includes(platform),
);
// TgtoDrive 客户端：面板源资源检索（只读搜索，不再有"确认入库"链路）。
const tgtoDriveClient = createTgtoDriveClientFromConfig({
  baseUrl: settings["tgto.baseUrl"],
  username: settings["tgto.username"],
  password: settings["tgto.password"],
});
const virtualLibraryProxy = createVirtualLibraryProxy({
  database: database.db,
  appPort: port,
  report: (message) => logger.warn({ event: "virtual_proxy_failed", message }),
});
const app = createApp({
  virtualLibraryProxy,
  database: database.db,
  auth: {
    sessionSecret: settings["session.secret"],
    lifetimeSeconds: settings["session.validityDays"] * 86_400,
    // 管理员凭据来自数据库设置（首启 admin / admin123）。
    verifyCredentials: (username, password) => {
      const result = verifyAdminCredentials(database.db, username, password);
      return result.status === "ok"
        ? { username: result.username, mustChangePassword: result.mustChangePassword }
        : null;
    },
  },
  authLimits: settings["security.lockoutMinutes"]
    ? {
        maxFailedAttempts: settings["security.maxFailedAttempts"],
        lockoutMinutes: settings["security.lockoutMinutes"],
      }
    : {
        maxFailedAttempts: settings["security.maxFailedAttempts"],
        lockoutBaseSeconds: settings["security.lockoutBaseSeconds"],
      },
  tmdb,
  library,
  logger,
  webDistPath: bootstrap.webDistPath,
  // 状态现取（函数而不是快照）：后台改完 Emby 开关/SMTP，状态卡片当场跟着变，不必重启。
  integrationStatus: {
    emby: () => getRuntimeSettings().embyEnabled && emby.configured,
    email: () => email.configured,
  },
  integrationServices: { emby, email },
  taskRetentionHours: movieTaskRetentionHours,
  trending: trendingService,
  publicEmbyBaseUrl,
  pansou: pansouClient,
  pansouTokens,
  pansouEnabledPlatforms,
  tgtoDrive: tgtoDriveClient,
  usageSampleIntervalMs: Math.max(10_000, settings["usage.sampleSeconds"] * 1_000),
  missingEpisodeScanner,
});

const runtime = startRuntime({
  database: database.db,
  logger,
  settings,
  library,
  tmdb,
  emby,
  email,
  embyEnabled,
  movieTaskRetentionHours,
  trending: trendingService,
  missingEpisodeScanner,
});

const server = app.listen(port, () => {
  logger.info({ event: "server_started", message: "服务启动", detail: JSON.stringify({ port }) });
  void runtime.runLibraryScan("startup").catch(() => {
    // runLibraryScan 内部已记录失败；这里只是避免未处理的拒绝。
  });
});
trendingService.start();
void virtualLibraryProxy.start();

installShutdown({
  server,
  stopRuntime: () => runtime.stop(),
  cleanup: [
    { name: "virtual_library_proxy", close: () => virtualLibraryProxy.close() },
    { name: "public_library", close: () => app.locals.closePublicLibrary?.() },
    { name: "missing_root_reader", close: () => closeMissingRootReader(database.db) },
    { name: "library", close: () => library.close?.() },
    { name: "logger", close: () => logger.close?.() },
  ],
  closeDatabase: () => database.close(),
  exit: (code) => process.exit(code),
  // Use stderr: the normal logger may already be closed or unable to write.
  report: (event, stage) => writeSync(2, `${JSON.stringify({ event, stage })}\n`),
  signals: process,
});
