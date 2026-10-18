import { z } from "zod";
import type { AppDatabase } from "@emby-task-center/database/client";
import { readSettings, writeSettings } from "../settings/store";

export const VirtualProxyConfigSchema = z.strictObject({
  enabled: z.boolean(),
  upstream: z
    .string()
    .trim()
    .refine((value) => {
      if (!value) return true;
      try {
        const url = new URL(value);
        return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
      } catch {
        return false;
      }
    }, "请填写 TgtoDrive 的 Emby 反代 HTTP(S) 地址"),
  port: z.number().int().min(1).max(65535),
});
export type VirtualProxyConfig = z.infer<typeof VirtualProxyConfigSchema>;

export function readVirtualProxyConfig(database: AppDatabase): VirtualProxyConfig {
  const { values } = readSettings(database);
  return {
    enabled: values["virtualLibraryProxy.enabled"],
    upstream: values["virtualLibraryProxy.upstream"],
    port: values["virtualLibraryProxy.port"],
  };
}

export function saveVirtualProxyConfig(database: AppDatabase, config: VirtualProxyConfig): void {
  const result = writeSettings(database, {
    "virtualLibraryProxy.enabled": config.enabled,
    "virtualLibraryProxy.upstream": config.upstream,
    "virtualLibraryProxy.port": config.port,
  });
  if (result.rejected.length) throw new Error("虚拟媒体库反代配置保存失败");
}

export function virtualProxyUpstream(database: AppDatabase, config: VirtualProxyConfig): string {
  return config.upstream || readSettings(database).values["emby.baseUrl"];
}
