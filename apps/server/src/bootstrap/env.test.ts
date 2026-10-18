import { describe, expect, it } from "vitest";

import { DEFAULT_DATABASE_PATH, readBootstrapEnv } from "./env";

describe("bootstrap env", () => {
  it("falls back to the documented defaults when nothing is set", () => {
    expect(readBootstrapEnv({})).toEqual({
      port: 12333,
      databasePath: DEFAULT_DATABASE_PATH,
      migrationsPath: undefined,
      webDistPath: undefined,
    });
  });

  it("reads the deployment variables and nothing else", () => {
    const env = readBootstrapEnv({
      PORT: "8080",
      DATABASE_PATH: "/tmp/app.sqlite",
      MIGRATIONS_PATH: "/app/drizzle",
      WEB_DIST_PATH: "/app/public",
      NODE_ENV: "production",
      // MEDIA_ROOTS_JSON 已废弃：库根现在实时取自 Emby，环境变量里给了也一律忽略
      MEDIA_ROOTS_JSON: '[{"id":"strm","name":"STRM","mediaType":"mixed","path":"/media/strm"}]',
      // 配置类变量即使存在也不应该被这里读取（P1 之后它们只作为首启种子）
      SMTP_HOST: "smtp.example.com",
      TMDB_TOKEN: "secret",
    } as NodeJS.ProcessEnv);

    expect(env).toEqual({
      port: 8080,
      databasePath: "/tmp/app.sqlite",
      migrationsPath: "/app/drizzle",
      webDistPath: "/app/public",
    });
  });
});
