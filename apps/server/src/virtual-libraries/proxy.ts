import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { Socket } from "node:net";
import type { AppDatabase } from "@emby-task-center/database/client";
import { createVirtualLibraryStore } from "./store";
import { createVirtualProxyHandler } from "./proxy-handler";
import { forwardUpgrade } from "./proxy-transport";
import {
  readVirtualProxyConfig,
  saveVirtualProxyConfig,
  virtualProxyUpstream,
  type VirtualProxyConfig,
} from "./proxy-settings";

export interface VirtualProxyStatus {
  running: boolean;
  port: number | null;
  error: string | null;
}

export function createVirtualLibraryProxy(options: {
  database: AppDatabase;
  appPort: number;
  report?: (message: string) => void;
}) {
  const store = createVirtualLibraryStore(options.database);
  const marker = randomUUID();
  let active: { server: Server; sockets: Set<Socket>; config: VirtualProxyConfig } | undefined;
  let error: string | null = null;
  let pending = Promise.resolve();
  const retiring = new Set<Promise<void>>();

  function status(): VirtualProxyStatus {
    return { running: Boolean(active?.server.listening), port: active?.config.port ?? null, error };
  }

  function retire(instance: NonNullable<typeof active>): Promise<void> {
    const task = new Promise<void>((resolve) => {
      instance.server.close(() => resolve());
      // Upgraded and long-running playback connections must not outlive a stopped proxy.
      for (const socket of instance.sockets) socket.destroy();
      instance.server.closeAllConnections();
    });
    retiring.add(task);
    void task.finally(() => retiring.delete(task));
    return task;
  }

  async function apply(config: VirtualProxyConfig, persist: boolean): Promise<void> {
    let replacement: typeof active;
    if (config.enabled) {
      const upstream = virtualProxyUpstream(options.database, config);
      if (!upstream) throw new Error("请先填写 TgtoDrive 的 Emby 反代地址或系统 Emby 地址");
      const target = new URL(upstream);
      if (!["http:", "https:"].includes(target.protocol)) throw new Error("反代上游须为 HTTP(S) 地址");
      if (config.port === options.appPort) throw new Error("反代端口不能与本服务网页端口相同");
      if (
        ["localhost", "127.0.0.1", "[::1]", "0.0.0.0"].includes(target.hostname) &&
        Number(target.port || (target.protocol === "https:" ? 443 : 80)) === config.port
      ) {
        throw new Error("反代上游不能指向自身端口");
      }
      if (active?.config.port !== config.port) {
        const instance = { server: createServer(), sockets: new Set<Socket>(), config };
        instance.server.on(
          "request",
          createVirtualProxyHandler(store, () => virtualProxyUpstream(options.database, instance.config), marker),
        );
        instance.server.on("connection", (socket) => {
          instance.sockets.add(socket);
          socket.once("close", () => instance.sockets.delete(socket));
        });
        instance.server.on("upgrade", (request, socket, head) => {
          try {
            if (request.headers["x-task-center-proxy"] === marker) return void socket.destroy();
            request.headers["x-task-center-proxy"] = marker;
            forwardUpgrade(virtualProxyUpstream(options.database, instance.config), request, socket, head);
          } catch {
            socket.destroy();
          }
        });
        await new Promise<void>((resolve, reject) => {
          instance.server.once("error", reject);
          instance.server.listen(config.port, () => {
            instance.server.removeListener("error", reject);
            resolve();
          });
        });
        instance.server.on("error", () => {
          error = "虚拟媒体库反代监听异常";
          options.report?.(error);
        });
        replacement = instance;
      }
    }
    try {
      if (persist) saveVirtualProxyConfig(options.database, config);
    } catch (failure) {
      if (replacement) await retire(replacement);
      throw failure;
    }
    const previous = active;
    if (!config.enabled) active = undefined;
    else if (replacement) active = replacement;
    else if (active) active.config = config;
    if (previous && previous !== active) void retire(previous);
    error = null;
  }

  function configure(config: VirtualProxyConfig, persist = true): Promise<void> {
    const operation = pending
      .then(() => apply(config, persist))
      .catch((failure: unknown) => {
        error = failure instanceof Error ? failure.message : "虚拟媒体库反代配置失败";
        throw failure;
      });
    pending = operation.catch(() => {});
    return operation;
  }

  return {
    status,
    configure,
    async start() {
      try {
        await configure(readVirtualProxyConfig(options.database), false);
      } catch {
        options.report?.(error ?? "虚拟媒体库反代启动失败");
      }
    },
    async close() {
      await pending;
      const previous = active;
      active = undefined;
      if (previous) await retire(previous);
      await Promise.all(retiring);
    },
  };
}

export type VirtualLibraryProxy = ReturnType<typeof createVirtualLibraryProxy>;
