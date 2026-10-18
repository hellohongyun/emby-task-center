import type { Express } from "express";
import type { AppDatabase } from "@emby-task-center/database/client";
import type { VirtualLibraryProxy } from "../virtual-libraries/proxy";
import {
  readVirtualProxyConfig,
  saveVirtualProxyConfig,
  VirtualProxyConfigSchema,
} from "../virtual-libraries/proxy-settings";

export function registerVirtualLibraryProxyRoutes(app: Express, database: AppDatabase, proxy?: VirtualLibraryProxy) {
  const payload = () => ({
    config: readVirtualProxyConfig(database),
    status: proxy?.status() ?? { running: false, port: null, error: null },
  });
  app.get("/api/virtual-libraries/proxy", (_request, response) => response.json(payload()));
  app.put("/api/virtual-libraries/proxy", async (request, response) => {
    const parsed = VirtualProxyConfigSchema.safeParse(request.body);
    if (!parsed.success)
      return void response.status(400).json({ error: "invalid_request", message: parsed.error.issues[0]?.message });
    if (!proxy && parsed.data.enabled) return void response.status(503).json({ error: "proxy_runtime_unavailable" });
    try {
      if (proxy) await proxy.configure(parsed.data);
      else saveVirtualProxyConfig(database, parsed.data);
      response.json(payload());
    } catch (error) {
      response.status(400).json({
        error: "proxy_configuration_failed",
        message:
          (error as NodeJS.ErrnoException).code === "EADDRINUSE"
            ? "反代端口已被占用，请换一个端口"
            : error instanceof Error
              ? error.message
              : "反代配置失败",
        ...payload(),
      });
    }
  });
}
