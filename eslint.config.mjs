// ESLint 扁平配置（P0.5 工程护栏）
//
// 分工原则：eslint 只管「正确性与一致性风险」，代码格式交给 prettier，
// 避免两套格式规则互相打架（history: 本仓库此前没有任何 lint/format 配置）。
import js from "@eslint/js";
import pluginVue from "eslint-plugin-vue";
import unusedImports from "eslint-plugin-unused-imports";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "dist/**",
      "apps/web/dist/**",
      ".local/**",
      "media/**",
      "tgtodrive/**",
      "deploy/**",
      "release/**",
      "coverage/**",
      "packages/database/drizzle/**",
      ".dsh-tmp/**",
      ".dsh-shots/**",
      ".superpowers/**",
      ".workbuddy/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...pluginVue.configs["flat/essential"],
  {
    files: ["apps/web/**/*.ts", "apps/web/**/*.vue"],
    languageOptions: { globals: { __APP_VERSION__: "readonly" } },
  },
  {
    files: ["**/*.vue"],
    languageOptions: {
      parserOptions: {
        parser: tseslint.parser,
        extraFileExtensions: [".vue"],
        sourceType: "module",
      },
    },
  },
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: { ...globals.node, ...globals.browser },
    },
    plugins: { "unused-imports": unusedImports },
    rules: {
      // 未使用 import / 变量：允许 _ 前缀（接口占位）与空 catch 的绑定
      // unused-imports 负责 import（可自动修复），tseslint 负责其余声明
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": "off",
      "unused-imports/no-unused-imports": "error",
      "unused-imports/no-unused-vars": [
        "error",
        {
          args: "after-used",
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrors: "none",
        },
      ],
      // 本仓库当前 0 处 any 逃生舱：保持可见但不阻断（warn）
      "@typescript-eslint/no-explicit-any": "warn",
      "no-empty": ["error", { allowEmptyCatch: true }],
      eqeqeq: ["error", "smart"],
      "prefer-const": "error",
      "no-var": "error",
      // P2 包边界：禁止再用深相对路径跨越 packages/*，必须走 workspace 包说明符。
      // 规则化是为了防止这次清理成果回退（CI 会拦住）。
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/packages/*/src/**"],
              message: "请改用 @emby-task-center/<package>/<module>（P2 已为 packages/* 建立真实包边界）",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["**/*.test.ts", "**/*.spec.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },
);
