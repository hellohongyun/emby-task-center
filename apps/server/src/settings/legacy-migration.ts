/**
 * 旧配置表 → app_settings 的一次性迁移（P1.4）。
 *
 * 背景：项目里曾有 5 套各自为政的配置实现，P1.4 把它们收编到统一设置存储。
 * 下面只列**现在仍需要迁移**的旧表：
 *   - concurrency_policy_settings → concurrencyPolicy.*
 *   - mail_default_settings       → mail.*（只迁 membershipReminder；
 *     投稿相关的 mail.submission* 随投稿功能删除，taskUpdate 随任务更新通知整条链下线，都不再注册）
 *   - pansou_platform_settings    → pansou.enabledPlatforms（列表形态 encode 成数组；P1.5 收编，
 *     旧表保留但不再读取，管理员此后的修改一律写设置项）
 *
 * 规则：
 *  - 只在该设置键**尚无数据库行**时导入，绝不覆盖管理员已保存的值；可反复执行。
 *  - 旧表保留不删（回滚与对照用），读取路径已改走 app_settings；
 *    已下线功能的旧表不在此列，由 packages/database 的 reconcile.ts 直接丢掉。
 *  - 注册表里已经下线的键（{@link RETIRED_SETTING_KEYS}）顺手清行，见该常量注释。
 *
 * 另注：automation/task-settings.ts 是**按任务的数据**（匹配别名、通知收件人），
 * 不是全局配置，因此不在迁移范围内。
 */
import { eq } from "drizzle-orm";

import type { AppDatabase } from "@emby-task-center/database/client";
import {
  appSettings,
  concurrencyPolicySettings,
  mailDefaultSettings,
  pansouPlatformSettings,
} from "@emby-task-center/database/schema";
import { settingDefinition, type SettingKey } from "./registry";
import { SETTINGS_ACTOR_ENV_SEED, writeSettings } from "./store";

export interface LegacyMigrationResult {
  migrated: SettingKey[];
  /** 顺手修正过旧口径的文案键（见 repairUnfreezeNoticeCopy）。 */
  repaired: SettingKey[];
}

/**
 * 已经下线的设置键：注册表里不再声明，`readSettings` 也读不到，但老库里还留着行。
 * 留着只会在库里发霉（还可能被误当成"当前配置"），所以每次迁移顺手清掉，可反复执行。
 */
const RETIRED_SETTING_KEYS: readonly string[] = [
  "emby.proxyEnabled",
  "embyProxy.enabled",
  "embyProxy.upstream",
  "embyProxy.port",
  "embyProxy.publicUrl",
  // 更早的废弃键：代码只读 embyProxy.upstream，这个从来没被用过（和面板里的上游设置重复）。
  "emby.proxyUpstream",
  // 自动签到子系统整体删除（2026-09）：这些键注册表里不再声明，读取路径也没有了。
  // checkin.tgSession 本身是一份**账号登录态凭据**，功能都没了就绝不该继续躺在库里，所以一并清行。
  "checkin.enabled",
  "checkin.tgApiId",
  "checkin.tgApiHash",
  "checkin.tgSession",
  "checkin.alertOnFailure",
  "checkin.retentionDays",
  // 任务更新通知整条链下线（2026-09）：注册表里不再声明这个键（邮件发送方已不存在），
  // 老库里迁移出来的行顺手清掉，免得看起来像"还有一类通知在发"。
  "mail.taskUpdate",
];

export function migrateLegacyConfig(database: AppDatabase): LegacyMigrationResult {
  const existing = new Set(
    database
      .select({ key: appSettings.key })
      .from(appSettings)
      .all()
      .map((row) => row.key),
  );
  const pending: Array<[SettingKey, unknown]> = [];

  /** 只在目标键尚无行、且值能通过注册表校验时入队。 */
  const queue = (key: SettingKey, value: unknown) => {
    if (existing.has(key)) return;
    const parsed = settingDefinition(key).schema.safeParse(value);
    if (parsed.success) pending.push([key, parsed.data]);
  };

  for (const key of RETIRED_SETTING_KEYS) {
    database.delete(appSettings).where(eq(appSettings.key, key)).run();
  }

  const concurrency = database.select().from(concurrencyPolicySettings).limit(1).get();
  if (concurrency) {
    queue("concurrencyPolicy.enabled", concurrency.enabled);
    queue("concurrencyPolicy.remindAfterMinutes", concurrency.remindAfterMinutes);
    queue("concurrencyPolicy.disableAfterMinutes", concurrency.disableAfterMinutes);
    queue("concurrencyPolicy.disableForHours", concurrency.disableForHours);
    queue("concurrencyPolicy.adminEmail", concurrency.adminEmail ?? "");
  }

  // PanSou 平台开关：旧表只有"显式保存过的行"；整表为空说明管理员没动过，保持注册表默认。
  const pansouRows = database.select().from(pansouPlatformSettings).all();
  if (pansouRows.length > 0) {
    queue(
      "pansou.enabledPlatforms",
      pansouRows.filter((row) => row.enabled).map((row) => row.platform),
    );
  }

  // 旧表是整行开关（两列），现在注册表只剩一列：membershipReminder 照迁，
  // taskUpdate 这一列随任务更新通知下线而不再有对应的设置键。
  const mail = database.select().from(mailDefaultSettings).where(eq(mailDefaultSettings.id, 1)).get();
  if (mail) {
    queue("mail.membershipReminder", mail.membershipReminder);
  }

  const migrated: SettingKey[] = [];
  for (const [key, value] of pending) {
    const result = writeSettings(database, { [key]: value }, SETTINGS_ACTOR_ENV_SEED);
    if (result.updated.includes(key)) migrated.push(key);
  }
  return { migrated, repaired: repairUnfreezeNoticeCopy(database) };
}

/**
 * 旧口径文案修正（可反复执行，与上面的"只补缺"互不干扰）。
 *
 * 自助解冻弹窗正文里的 remainingChances 占位符曾经表示**本次解冻后还剩几次**（已扣掉本次），
 * 现在它表示**本月当前还剩几次**（不扣本次）——"本次解冻后还剩"改用 remainingAfterThis 占位符。
 *
 * 为什么必须迁移：管理员只要在面板上保存过一次，库里那行就是旧口径的默认文案，
 * 不再走注册表默认值；不修的话会员点开弹窗会看到"本次解冻后还剩 3 次"（上限本来就只有 3 次）。
 * 只替换这一句，管理员的其它改动一律不动。返回修正过的键（没改就是空数组）。
 */
function repairUnfreezeNoticeCopy(database: AppDatabase): SettingKey[] {
  const key = "concurrencyPolicy.unfreezeNotice";
  const row = database.select().from(appSettings).where(eq(appSettings.key, key)).get();
  if (!row?.value) return [];
  let stored: unknown;
  try {
    stored = JSON.parse(row.value) as unknown;
  } catch {
    return []; // 非法 JSON 交给 readSettings 走回落逻辑，不在迁移里猜
  }
  if (typeof stored !== "string") return [];
  const repaired = stored.replace("本次解冻后还剩 {{remainingChances}}", "本次解冻后还剩 {{remainingAfterThis}}");
  if (repaired === stored) return [];
  const result = writeSettings(database, { [key]: repaired }, SETTINGS_ACTOR_ENV_SEED);
  return result.updated.includes(key) ? [key] : [];
}
