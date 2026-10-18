import { fileURLToPath } from "node:url";

import { configDefaults, defineConfig } from "vitest/config";

/**
 * 根 vitest 配置（P0.5 工程护栏）。
 *
 * 修复历史坑：在仓库根直接 `vitest run` 会把 apps/web/** 也收集进来，
 * 而根环境没有 jsdom 配置，导致 20+ 个前端测试文件报 "document is not defined"。
 * 这里显式圈定「服务端 + packages」；前端用 apps/web/vite.config.ts 里自己的 test 配置。
 *
 * envDir 指向空目录：Vite 默认会把仓库根的 .env 注入 process.env，
 * 让"配置来源"随开发者本机 .env 漂移（例如 email.host 的 source 变成 env）。
 * 测试必须与 .env 隔离，配置一律由用例自己显式给出。
 */
export default defineConfig({
  envDir: fileURLToPath(new URL("./tests/env-isolated", import.meta.url)),
  test: {
    // 5s 默认超时对这批用例偏紧：不少用例会真起 Express + 监听端口再 fetch，
    // 整套跑（多 worker 抢 CPU）时它们仍是几百毫秒，但偶发会顶到 5s 而假红（单跑必过）。
    testTimeout: 20_000,
    hookTimeout: 20_000,
    // Vitest 仍会把根 .env 注入 process.env，这里在用例前清掉配置类变量（见 setup 注释）。
    setupFiles: ["./tests/env-isolated/setup.ts"],
    include: ["apps/server/src/**/*.test.ts", "packages/*/src/**/*.test.ts"],
    exclude: [...configDefaults.exclude, "apps/web/**", "tests/e2e/**"],
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "json-summary"],
      reportsDirectory: "coverage/server",
      include: ["apps/server/src/**/*.ts", "packages/*/src/**/*.ts"],
      exclude: ["**/*.test.ts", "**/*.d.ts"],
      // 阈值 = 实测基线的「棘轮」：2026-09-10 实测
      // lines/statements 74.67%、branches 67.91%、functions 84.38%，因此取略低值锁定，只许升不许降。
      thresholds: {
        lines: 73,
        statements: 73,
        functions: 82,
        branches: 66,
      },
    },
  },
});
