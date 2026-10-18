#!/usr/bin/env node
/**
 * 服务端打包（P2 之后必须走脚本，不能用 `esbuild --packages=external`）。
 *
 * 背景：`packages/*` 现在是真实的 workspace 包，它们的 exports 直接指向 TS 源码
 * （内部包模式，由消费方打包）。`--packages=external` 会把 `@emby-task-center/*`
 * 也当成外部依赖留给运行时，而 Node 即使能剥离类型加载 .ts，也会在包内的
 * 无扩展名相对导入（如 contracts/task.ts 里的 "./media"）上直接 ERR_MODULE_NOT_FOUND。
 *
 * 因此这里只把**第三方依赖**标记为 external，workspace 包照常打包进产物。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

// externals = 所有 workspace 清单里声明的第三方依赖并集。
// 只读 apps/server 会漏掉传递依赖（例如经 database 包用到的 better-sqlite3，
// 漏掉就会让 esbuild 去打包原生 CJS 模块，运行时报 "Dynamic require of fs is not supported"）。
// 不含 apps/web：它有自己的打包流程（vite），依赖与此无关。
const manifests = [
  "../package.json",
  "../apps/server/package.json",
  "../packages/contracts/package.json",
  "../packages/database/package.json",
  "../packages/task-domain/package.json",
];
const external = [
  ...new Set(
    manifests
      .flatMap((manifest) => {
        const parsed = JSON.parse(readFileSync(new URL(manifest, import.meta.url), "utf8"));
        return Object.keys(parsed.dependencies ?? {});
      })
      .filter((name) => !name.startsWith("@emby-task-center/")),
  ),
].sort();

const result = await build({
  // 用 fileURLToPath 而不是 `new URL(...).pathname.replace(/^\//, "")`：
  // 后者是 Windows 专用写法（依赖 pathname 形如 /E:/... 再去掉前导斜杠），
  // 在 Linux/容器里会得到 "workspace/apps/..." 这种不存在的相对路径，直接构建失败。
  entryPoints: [
    "index",
    "library/scan-worker",
    "library/missing-scan-worker",
    "library/missing-root-worker",
    "routes/public-library-worker",
  ].map((name) => fileURLToPath(new URL(`../apps/server/src/${name}.ts`, import.meta.url))),
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  external,
  outdir: fileURLToPath(new URL("../dist/server", import.meta.url)),
  entryNames: "[name]",
  outExtension: { ".js": ".mjs" },
  logLevel: "info",
  metafile: false,
});

if (result.errors.length > 0) process.exit(1);
console.log(`external packages: ${external.join(", ")}`);
