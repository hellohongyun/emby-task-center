import { readFileSync } from "node:fs";

import tailwindcss from "@tailwindcss/vite";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

const { version } = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
  version: string;
};

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(version) },
  plugins: [
    vue(),
    tailwindcss(),
    {
      name: "app-version",
      generateBundle() {
        this.emitFile({ type: "asset", fileName: "version.json", source: `${JSON.stringify({ version })}\n` });
      },
    },
  ],
  resolve: { alias: { "@": new URL("./src", import.meta.url).pathname } },
  server: {
    host: "0.0.0.0",
    allowedHosts: ["terminal.local"],
    proxy: { "/api": "http://127.0.0.1:3000" },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    css: true,
    // 与根 vitest 配置同样的理由：jsdom + 多 worker 下偶发超过 5s 会变成假红。
    testTimeout: 20_000,
  },
});
