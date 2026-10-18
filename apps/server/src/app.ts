import { requirePublicMember } from "./subscriptions/member-access";
import express, { type ErrorRequestHandler, type RequestHandler } from "express";
import { join } from "node:path";

import type { AppDatabase } from "@emby-task-center/database/client";
import { createSessionManager, type SessionOptions } from "./auth/session";
import type { LibraryService } from "./library/service";
import type { LogEvent } from "./logging/logger";
import type { EmbyClient } from "./integrations/emby-client";
import { createMissingEpisodeScanner, type MissingEpisodeScanner } from "./library/missing-episode-scan";
import type { EmailNotifier } from "./notifications/email-service";
import { registerAuthRoutes, type AuthLimitOptions } from "./routes/auth";
import { registerIntegrationRoutes, type IntegrationStatusFlag } from "./routes/integrations";
import { registerEmbyUserRoutes } from "./routes/emby-users";
import { registerCardRoutes } from "./routes/cards";
import { registerLibraryRoutes } from "./routes/library";
import { registerLogRoutes } from "./routes/logs";
import { registerOperationsRoutes } from "./routes/operations";
import { registerPublicRoutes } from "./routes/public";
import { registerPublicLibraryRoutes } from "./routes/public-library";
import { registerPublicSubscriptionRoutes } from "./routes/public-subscriptions";
import { registerMemberRoutes } from "./routes/members";
import { registerMemberUsageRoutes } from "./routes/member-usage";
import { registerAdminContentRoutes } from "./routes/admin-content";
import { registerConcurrencyPolicyRoutes } from "./routes/concurrency-policy";
import { registerSettingsRoutes } from "./routes/settings";
import { refreshRuntimeSettings } from "./settings/runtime";
import { registerDashboardRoutes } from "./routes/dashboard";
import { registerTaskRoutes } from "./routes/tasks";
import { registerTaskSettingsRoutes } from "./routes/task-settings";
import { registerMissingEpisodeRoutes } from "./routes/missing-episodes";
import { registerTmdbRoutes } from "./routes/tmdb";
import { registerPublicTrendingRoutes, registerAdminTrendingRoutes } from "./trending/routes";
import type { TrendingService } from "./trending/service";
import { createPublicSessionManager } from "./subscriptions/public-session";
import type { TmdbClient } from "./tmdb/client";
import type { PansouClient } from "./pansou/pansou-client";
import type { ResourceTokenStore } from "./pansou/resource-tokens";
import type { PansouPlatformKey } from "./pansou/pansou-filter";
import { registerPansouRoutes } from "./routes/pansou";
import { registerTgtoResourcesRoutes } from "./routes/tgto-resources";
import type { TgtoDriveClient } from "./integrations/tgtodrive-client";
import { registerPansouAdminRoutes } from "./routes/pansou-admin";
import { registerVirtualLibraryRoutes } from "./routes/virtual-libraries";
import { registerVirtualLibraryProxyRoutes } from "./routes/virtual-library-proxy";
import type { VirtualLibraryProxy } from "./virtual-libraries/proxy";

export interface AppLogger {
  info(event: LogEvent): void;
  warn(event: LogEvent): void;
  error(event: LogEvent): void;
  request: RequestHandler;
}

export interface AppOptions {
  virtualLibraryProxy?: VirtualLibraryProxy;
  database: AppDatabase;
  auth: SessionOptions;
  authLimits?: AuthLimitOptions;
  tmdb: TmdbClient;
  library: LibraryService;
  logger?: AppLogger;
  webDistPath?: string;
  /** 连接状态位：常量或 getter（生产用 getter 现取，保存配置后无需重启即刷新）。 */
  integrationStatus?: { emby: IntegrationStatusFlag; email: IntegrationStatusFlag };
  integrationServices?: { emby: EmbyClient; email: EmailNotifier };
  /** 已入库电影任务完成后自动清理的保留小时数（默认 24，0 关闭）。 */
  taskRetentionHours?: number;
  /** 热点榜单聚合服务（公开首页 + 管理端来源配置）。 */
  trending?: TrendingService;
  /** Emby Web 地址（如 http://emby:8096），用于公开“去观看”链接。 */
  publicEmbyBaseUrl?: string;
  /** PanSou 聚合搜索客户端（后端代理）。 */
  pansou?: PansouClient;
  /** PanSou resourceId 短时映射（前端只拿 token）。 */
  pansouTokens?: ResourceTokenStore;
  /** 管理后台网盘启用开关（Phase 1 由 env/默认值传入）。 */
  pansouEnabledPlatforms?: readonly PansouPlatformKey[];
  /** TgtoDrive 管理台客户端（面板源资源搜索，替代 PanSou 资源）。 */
  tgtoDrive?: TgtoDriveClient;
  /** 使用记录采样周期（毫秒）；与后台采样定时任务用同一个值。 */
  usageSampleIntervalMs?: number;
  /**
   * 全库缺集检测器。生产由 index.ts 创建并同时交给后台定时任务，保证"定时扫描"与
   * "页面手动触发/读状态"用的是同一个实例；测试不传时路由内建一个（不会自己跑）。
   */
  missingEpisodeScanner?: MissingEpisodeScanner;
}

export function createApp(options: AppOptions) {
  const app = express();
  const sessions = createSessionManager(options.auth);
  const publicSession = createPublicSessionManager(options.auth.sessionSecret);

  app.disable("x-powered-by");
  app.use((_request, response, next) => {
    response.set({
      "Content-Security-Policy":
        "default-src 'self'; base-uri 'self'; connect-src 'self'; frame-ancestors 'none'; frame-src https://www.youtube.com https://www.youtube-nocookie.com; form-action 'self'; img-src 'self' data: https://image.tmdb.org https://*.doubanio.com https://*.meituan.net https://*.maoyan.com https://*.pipi.cn https://dnm.nflximg.net https://*.nflximg.net; object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'",
      "Cross-Origin-Opener-Policy": "same-origin",
      "Permissions-Policy": "camera=(), geolocation=(), microphone=()",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
    });
    next();
  });
  app.use(express.json({ limit: "32kb" }));
  if (options.logger) app.use(options.logger.request);
  app.get("/health", (_request, response) => response.json({ status: "ok" }));

  app.use(requirePublicMember(options.database, publicSession));
  registerAuthRoutes(app, sessions, options.authLimits, () => publicSession.clearCookie());
  // 公开入口：在登录门之前注册，无需管理端会话；只有 TMDB 检索与门户只读接口，绝不返回内部数据。
  registerPublicRoutes(app, { database: options.database, publicSession, tmdb: options.tmdb });
  // PanSou 聚合搜索：公开会员门禁内，后端代理转发，不暴露链接与具体网盘名。
  if (options.pansou && options.pansouTokens) {
    registerPansouRoutes(app, {
      database: options.database,
      publicSession,
      pansou: options.pansou,
      tokens: options.pansouTokens,
      emby: options.integrationServices?.emby,
      enabledPlatforms: options.pansouEnabledPlatforms,
    });
  }
  // TgtoDrive 面板源资源搜索：替代 PanSou 资源；按网盘/磁力开关过滤。
  if (options.tgtoDrive && options.pansouTokens) {
    registerTgtoResourcesRoutes(app, {
      database: options.database,
      publicSession,
      tgto: options.tgtoDrive,
      tokens: options.pansouTokens,
    });
  }
  // 隐私保护：未登录禁止访问公开内容接口（热点、影视库、图片代理），前端未登录只会显示登录页与管理端口。
  app.use((request, response, next) => {
    const path = request.path;
    if (
      path.startsWith("/api/public/trending") ||
      path.startsWith("/api/public/library") ||
      path.startsWith("/api/public/emby-poster") ||
      path.startsWith("/api/public/image")
    ) {
      const { email } = publicSession.read(request.headers.cookie);
      if (!email) return void response.status(401).json({ error: "unauthorized" });
    }
    next();
  });
  // 登录用户的热点：附上媒体库在库标记，首页可直接“去观看”。
  registerPublicTrendingRoutes(app, {
    service: options.trending,
    database: options.database,
    embyBaseUrl: options.publicEmbyBaseUrl,
  });
  // 登录用户的媒体库检索/最近入库/去重：仅暴露元数据，绝不返回文件路径。
  app.locals.closePublicLibrary = registerPublicLibraryRoutes(app, {
    database: options.database,
    embyBaseUrl: options.publicEmbyBaseUrl,
    library: options.library,
    emby: options.integrationServices?.emby,
  });
  // 公开订阅（卡密/验证码/自动开户）：在登录门之前注册，无需管理端会话。
  registerPublicSubscriptionRoutes(app, {
    database: options.database,
    publicSession,
    email: options.integrationServices?.email,
    emby: options.integrationServices?.emby,
    // 会员自助解冻要留痕（谁在冻结期内自己放了行），和并发升级任务用的是同一个日志。
    logger: options.logger,
  });
  app.use("/api", sessions.requireSession);
  registerVirtualLibraryProxyRoutes(app, options.database, options.virtualLibraryProxy);
  registerVirtualLibraryRoutes(app, { database: options.database });
  registerLogRoutes(app, options.database, options.logger);
  registerDashboardRoutes(app, options.database);
  registerCardRoutes(app, options.database);
  registerTmdbRoutes(app, options.tmdb);
  registerMemberRoutes(app, {
    database: options.database,
    email: options.integrationServices?.email,
    emby: options.integrationServices?.emby,
  });
  // 「内容与偏好」接口：原先被 submission 路由顺带挂载，现各自注册。
  // （追更任务管理 follow-tasks 已随追更功能整体下线，2026-09）
  registerAdminContentRoutes(app, { database: options.database });
  registerPansouAdminRoutes(app, options.database);
  registerAdminTrendingRoutes(app, { service: options.trending });
  // P3：路由注册一律用选项对象，不再出现 undefined 占位参数。
  registerTaskRoutes(app, {
    database: options.database,
    tmdb: options.tmdb,
    library: options.library,
    queue: { movieGroupSize: 5, delayHours: 3, retentionHours: options.taskRetentionHours ?? 24 },
  });
  registerTaskSettingsRoutes(app, { database: options.database, library: options.library });
  // 缺集总览（全库）：快照由后台扫描器定时写入；删除走 Emby 官方删除接口（联动片源清理）。
  const missingEpisodeScanner =
    options.missingEpisodeScanner ??
    createMissingEpisodeScanner({
      database: options.database,
      tmdb: options.tmdb,
      emby: options.integrationServices?.emby,
    });
  registerMissingEpisodeRoutes(app, {
    database: options.database,
    library: options.library,
    scanner: missingEpisodeScanner,
    emby: options.integrationServices?.emby,
    publicEmbyBaseUrl: options.publicEmbyBaseUrl,
  });
  registerLibraryRoutes(app, {
    library: options.library,
    database: options.database,
    tmdb: options.tmdb,
    emby: options.integrationServices?.emby,
  });
  registerOperationsRoutes(app, { database: options.database, library: options.library });
  registerIntegrationRoutes(app, {
    // 直接透传：状态位可能是 getter，由路由在每次请求时现取（保存配置后无需重启即刷新）。
    configured: options.integrationStatus,
    services: options.integrationServices,
  });
  registerEmbyUserRoutes(app, options.integrationServices?.emby, options.database);
  // 会员使用记录（登录/播放/时段）：数据由后台采样器与 Emby 活动日志回填写入，这里只读 + 手动刷新。
  registerMemberUsageRoutes(app, {
    database: options.database,
    emby: options.integrationServices?.emby,
    sampleIntervalMs: options.usageSampleIntervalMs,
  });
  registerConcurrencyPolicyRoutes(app, options.database);
  // 管理端配置中心（P1）：读写 app_settings；密钥只回掩码。
  // 保存配置后立即生效：刷新运行时快照（Emby 地址/密钥等启动时读取的配置）。
  registerSettingsRoutes(app, options.database, {
    onApplied: async () => {
      refreshRuntimeSettings(options.database);
    },
  });

  if (options.webDistPath) {
    const webDistPath = options.webDistPath;
    app.use(express.static(webDistPath));
    // 公开门户：非 API 路径回退到 SPA（index.html），由前端按路由渲染门户页面
    app.use((request, response, next) => {
      if (request.path.startsWith("/api/") || request.path === "/health") return next();
      response.sendFile(join(webDistPath, "index.html"), (error) => {
        if (error) next();
      });
    });
  }

  app.use((_request, response) => response.status(404).json({ error: "not_found" }));
  app.use(createErrorHandler(options.logger));
  return app;
}

function createErrorHandler(logger: AppLogger | undefined): ErrorRequestHandler {
  return (error, request, response, _next) => {
    // body-parser 的 PayloadTooLargeError 不是 SyntaxError：若一律按 500 处理会掩盖客户端超限问题。
    const bodyErrorType = (error as { type?: unknown }).type;
    const isTooLarge = bodyErrorType === "entity.too.large";
    const status = isTooLarge ? 413 : error instanceof SyntaxError ? 400 : 500;
    const message = isTooLarge ? "payload_too_large" : status === 400 ? "invalid_request" : "internal_error";
    logger?.error({
      event: "request_failed",
      message: "请求处理失败",
      method: request.method,
      path: request.path,
      detail: JSON.stringify({ type: bodyErrorType ?? null }),
    });
    response.status(status).json({ error: message });
  };
}
