/**
 * 测试环境隔离（P0.5 护栏补强）。
 *
 * Vitest 会把仓库根的 .env 注入 process.env，导致"配置来源"类断言随开发者本机
 * .env 漂移（例如 email.host 的来源从 default 变成 env，或者库里凭空多出种子值）。
 * 这里在每个测试文件执行前清掉配置类环境变量：
 *   - 覆盖 registry 里登记的全部 env 名（单一真源，新增设置项自动生效）；
 *   - 加上少量历史/部署变量。
 * 需要配置的用例必须自己显式传入（例如 readSettings(db, { SMTP_HOST: "..." })）。
 */
import { installSafeListen } from "../../apps/server/src/test-support/port-guard";
import { SETTING_KEYS, settingDefinition } from "../../apps/server/src/settings/registry";

// 让 listen(0) 避开 fetch 禁用端口（否则偶发 "bad port"），详见 port-guard.ts 的根因说明。
installSafeListen();

const LEGACY_NAMES = [
  "SHARED_PASSWORD",
  "SESSION_SECRET",
  "MEDIA_ROOTS_JSON",
  "WEB_DIST_PATH",
  "MIGRATIONS_PATH",
  "MCP_TOKEN",
  "MCP_ALLOWED_HOSTS",
  "MCP_ALLOWED_ORIGINS",
  "LITEPAN_BASE_URL",
  "LITEPAN_API_TOKEN",
  "AGENT_WEBHOOK_TOKEN",
  "AGENT_WEBHOOK_BASE_URL",
];

const names = new Set<string>(LEGACY_NAMES);
for (const key of SETTING_KEYS) {
  const envName = settingDefinition(key).env;
  if (envName) names.add(envName);
}

for (const name of names) delete process.env[name];
