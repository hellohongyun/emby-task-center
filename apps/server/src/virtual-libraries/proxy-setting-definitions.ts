import { z } from "zod";

/** These settings are edited by the dedicated virtual library panel. */
export const VIRTUAL_PROXY_SETTINGS = {
  "virtualLibraryProxy.enabled": {
    group: "emby" as const,
    label: "虚拟媒体库反代",
    hidden: true,
    schema: z.boolean().default(false),
  },
  "virtualLibraryProxy.upstream": {
    group: "emby" as const,
    label: "虚拟媒体库反代上游",
    hidden: true,
    schema: z.string().default(""),
  },
  "virtualLibraryProxy.port": {
    group: "emby" as const,
    label: "虚拟媒体库反代端口",
    hidden: true,
    schema: z.number().int().min(1).max(65535).default(8097),
  },
};
