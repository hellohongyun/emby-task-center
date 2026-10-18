import type { Express } from "express";
import { z } from "zod";

import type { EmbyClient } from "../integrations/emby-client";
import type { EmailNotifier } from "../notifications/email-service";
import { settingDefinition } from "../settings/registry";

/**
 * 状态位可以给常量，也可以给 getter。
 *
 * 生产环境用 getter 现取运行时快照：后台刚配好 SMTP/Emby，本接口当场返回"已配置"，
 * 而不是沿用进程启动那一刻的旧值（那正是"明明配好了却一直显示未配置"的根因）。
 */
export type IntegrationStatusFlag = boolean | (() => boolean);

// 全局通知收件人（GET/POST/DELETE /api/integrations/email/recipients）随
// 「任务更新通知」整条链删除（2026-09）：这条邮件链已无发送方。
// 于是 database 也不再被本文件用到，选项里一并去掉（P3 约定：无人使用的选项不留占位）。
export interface IntegrationRouteOptions {
  configured?: { emby: IntegrationStatusFlag; email: IntegrationStatusFlag } | undefined;
  services?: { emby: EmbyClient; email: EmailNotifier } | undefined;
}

/** 现取状态位：函数就调用、布尔就用它、都没给则回落到服务的实时 configured。 */
function resolveStatusFlag(flag: IntegrationStatusFlag | undefined, live: (() => unknown) | undefined): boolean {
  if (typeof flag === "function") return flag();
  if (typeof flag === "boolean") return flag;
  return Boolean(live?.() ?? false);
}

// P3：位置参数改为选项对象（_logger 占位已无人使用，直接删除）。
export function registerIntegrationRoutes(app: Express, options: IntegrationRouteOptions): void {
  const { services } = options;
  app.get("/api/integrations/status", (_request, response) =>
    response.json({
      embyConfigured: resolveStatusFlag(options.configured?.emby, () => services?.emby?.configured),
      emailConfigured: resolveStatusFlag(options.configured?.email, () => services?.email?.configured),
      // 光说"未配置"没法排查：把还缺的设置项按注册表标签列出来（已配置时为空数组）。
      emailMissing: (services?.email?.missingFields?.() ?? []).map((key) => settingDefinition(key).label),
    }),
  );

  app.post("/api/integrations/emby/test", async (_request, response) => {
    if (!services?.emby.configured) return void response.status(409).json({ error: "emby_not_configured" });
    try {
      response.json({ ok: true, ...(await services.emby.systemInfo()) });
    } catch (error) {
      response.status(502).json({ error: (error as Error).message });
    }
  });

  app.post("/api/integrations/email/test", async (request, response) => {
    const parsed = z.strictObject({ email: z.string().trim().email().max(254) }).safeParse(request.body);
    if (!parsed.success) return void response.status(400).json({ error: "invalid_email" });
    try {
      await services?.email.sendTest(parsed.data.email);
      response.json({ ok: true });
    } catch (error) {
      response.status(502).json({ error: (error as Error).message });
    }
  });
}
