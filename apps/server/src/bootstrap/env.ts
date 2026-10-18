/**
 * bootstrap 环境读取（P3）。
 *
 * P1 之后，环境变量只剩部署/bootstrap 用途；这里把它们的解析集中到一处，
 * 便于测试（传 env 对象即可）与审计（哪些 env 还在被读，一眼可见）。
 */

export interface BootstrapEnv {
  port: number;
  databasePath: string;
  /** 未设置时交给 createDatabase 用内置默认（容器内 /app/drizzle）。 */
  migrationsPath: string | undefined;
  webDistPath: string | undefined;
}

export const DEFAULT_DATABASE_PATH = "/data/emby-task-center.db";
export const DEFAULT_PORT = 12333;

export function readBootstrapEnv(env: NodeJS.ProcessEnv = process.env): BootstrapEnv {
  return {
    port: Number(env.PORT ?? DEFAULT_PORT),
    databasePath: env.DATABASE_PATH ?? DEFAULT_DATABASE_PATH,
    migrationsPath: env.MIGRATIONS_PATH,
    webDistPath: env.WEB_DIST_PATH,
  };
}

// MEDIA_ROOTS_JSON 与 readLibraryRoots 已删除：库根不再来自环境变量，
// 而是每次同步时从 Emby 的媒体库实时取（见 library/emby-roots.ts）。
