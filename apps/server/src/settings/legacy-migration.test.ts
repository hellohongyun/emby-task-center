import { eq } from "drizzle-orm";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDatabase, type DatabaseHandle } from "@emby-task-center/database/client";
import { appSettings, concurrencyPolicySettings, mailDefaultSettings } from "@emby-task-center/database/schema";
import { getConcurrencyPolicy, saveConcurrencyPolicy } from "../integrations/concurrency-policy-config";
import { readMailDefaults, saveMailDefaults } from "../subscriptions/domain-utils";
import { migrateLegacyConfig } from "./legacy-migration";
import { readSettings, writeSettings } from "./store";

describe("legacy config migration (P1.4)", () => {
  let directory: string;
  let database: DatabaseHandle;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "emby-legacy-migration-"));
    database = createDatabase(join(directory, "app.sqlite"));
  });

  afterEach(() => {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });

  /**
   * 写入"旧版"配置行。
   * 注意：mail_default_settings 由 migrate.ts 种入 id=1 的默认行，因此那张表用 update，
   * 其余表（代码里靠默认值兜底）用 insert。
   */
  function seedLegacyTables() {
    const timestamp = new Date().toISOString();
    database.db
      .insert(concurrencyPolicySettings)
      .values({
        id: 1,
        enabled: false,
        remindAfterMinutes: 7,
        disableAfterMinutes: 11,
        disableForHours: 3,
        adminEmail: "admin@example.com",
        updatedAt: timestamp,
      })
      .run();
    // mail_default_settings 里仍有投稿相关列（表结构不删），但投稿开关已不再注册，迁移时被忽略。
    database.db
      .update(mailDefaultSettings)
      .set({
        submissionReceipt: false,
        submissionConverted: true,
        submissionRejected: false,
        submissionDuplicate: true,
        submissionInlibrary: true,
        membershipReminder: false,
        taskUpdate: true,
        updatedAt: timestamp,
      })
      .where(eq(mailDefaultSettings.id, 1))
      .run();
  }

  it("imports every legacy row into the settings store", () => {
    seedLegacyTables();
    const { migrated } = migrateLegacyConfig(database.db);
    // 7 条来自 2 张旧配置表（并发 5 + 邮件 1）；末条是 migrate.ts 播种的 pansou_platform_settings（P1.5 收编）。
    // 邮件从 2 条变 1 条：「任务更新通知」整条链下线（2026-09），旧表的 taskUpdate 列不再有对应的设置键。
    expect(migrated.length).toBe(7);
    expect(migrated).toContain("pansou.enabledPlatforms");
    expect(migrated).toContain("concurrencyPolicy.adminEmail");
    expect(migrated).toContain("mail.membershipReminder");

    const { values, sources } = readSettings(database.db, {});
    expect(values["concurrencyPolicy.remindAfterMinutes"]).toBe(7);
    expect(values["mail.membershipReminder"]).toBe(false);
    expect(sources["concurrencyPolicy.remindAfterMinutes"]).toBe("db");

    // PanSou 平台开关：旧表的启用行被编码成数组；未启用的平台不在其中
    const enabledPlatforms = values["pansou.enabledPlatforms"] as string[];
    expect(Array.isArray(enabledPlatforms)).toBe(true);
    expect(enabledPlatforms).toContain("magnet");
    expect(sources["pansou.enabledPlatforms"]).toBe("db");
  });

  it("leaves the module adapters reading the migrated values", () => {
    seedLegacyTables();
    migrateLegacyConfig(database.db);

    expect(getConcurrencyPolicy(database.db)).toEqual({
      enabled: false,
      remindAfterMinutes: 7,
      disableAfterMinutes: 11,
      disableForHours: 3,
      adminEmail: "admin@example.com",
      // 新增项不来自旧表：走注册表默认值（超限直接中断 + 默认 1 路）
      interruptStreams: true,
      defaultStreamLimit: 1,
      // 自助解冻同样不来自旧表：默认允许、每月 2 次、等待 60 秒（文案见 registry 的默认值）
      unfreezeEnabled: true,
      unfreezeMonthlyLimit: 2,
      unfreezeWaitSeconds: 60,
      unfreezeTitle: expect.any(String),
      unfreezeNotice: expect.any(String),
      portalUrl: "",
    });
    expect(readMailDefaults(database.db)).toEqual({ membership_reminder: false });
  });

  it("imports the migrate.ts-seeded rows and falls back to defaults for the rest", () => {
    // migrate.ts 已为 mail_default_settings / pansou_platform_settings 种入默认行，它们同样会被导入；
    // 其余空表则用注册表默认值。
    const { migrated } = migrateLegacyConfig(database.db);
    // pansou 1 条 + 邮件 1 条（membershipReminder）；taskUpdate 已下线，不再有第三条
    expect(migrated.length).toBe(2);
    expect(getConcurrencyPolicy(database.db).remindAfterMinutes).toBe(2);
    expect(readMailDefaults(database.db).membership_reminder).toBe(true);
    // 再次执行不再导入任何东西
    expect(migrateLegacyConfig(database.db).migrated).toEqual([]);
  });

  it("never overwrites a value the operator already saved", () => {
    writeSettings(database.db, { "concurrencyPolicy.remindAfterMinutes": 99 });
    seedLegacyTables();

    const { migrated } = migrateLegacyConfig(database.db);
    expect(migrated).not.toContain("concurrencyPolicy.remindAfterMinutes");
    expect(readSettings(database.db, {}).values["concurrencyPolicy.remindAfterMinutes"]).toBe(99);
    // 其余键照常导入
    expect(migrated).toContain("concurrencyPolicy.enabled");
  });

  it("is idempotent and survives a second run", () => {
    seedLegacyTables();
    expect(migrateLegacyConfig(database.db).migrated.length).toBe(7);
    expect(migrateLegacyConfig(database.db).migrated).toEqual([]);
  });

  it("prunes settings keys that have been retired from the registry", () => {
    // 老库里留下的已下线键（功能删了、行还在）：迁移时必须清掉，且不影响合法键。
    // 自动签到整组（2026-09 删除，含一份账号登录态凭据 checkin.tgSession）也走这条路；
    // mail.taskUpdate 则是「任务更新通知」整条链下线时留下的行。
    const timestamp = new Date().toISOString();
    for (const key of [
      "embyProxy.port",
      "embyProxy.publicUrl",
      "emby.proxyEnabled",
      "emby.proxyUpstream",
      "checkin.enabled",
      "checkin.tgApiId",
      "checkin.tgApiHash",
      "checkin.tgSession",
      "checkin.alertOnFailure",
      "checkin.retentionDays",
      "mail.taskUpdate",
    ]) {
      database.db
        .insert(appSettings)
        .values({ key, value: JSON.stringify(1234), updatedAt: timestamp, updatedBy: "admin" })
        .run();
    }
    writeSettings(database.db, { "emby.baseUrl": "https://emby.example.test" });

    migrateLegacyConfig(database.db);

    const left = database.db
      .select({ key: appSettings.key })
      .from(appSettings)
      .all()
      .map((row) => row.key);
    expect(left).not.toContain("embyProxy.port");
    expect(left).not.toContain("embyProxy.publicUrl");
    expect(left).not.toContain("emby.proxyEnabled");
    expect(left).not.toContain("emby.proxyUpstream");
    expect(left).not.toContain("checkin.tgSession");
    expect(left).not.toContain("checkin.enabled");
    expect(left).not.toContain("mail.taskUpdate");
    // 合法键不受影响
    expect(left).toContain("emby.baseUrl");
    // 反复执行安全
    expect(() => migrateLegacyConfig(database.db)).not.toThrow();
  });

  it("repairs the old 「本次解冻后还剩 {{remainingChances}}」 copy once, and leaves other edits alone", () => {
    // 旧口径：remainingChances = "本次解冻后还剩几次"。管理员若在面板保存过，库里那行就是旧文案；
    // 不修的话会员点开弹窗会看到"本次解冻后还剩 3 次"（上限本来只有 3 次）。
    saveConcurrencyPolicy(database.db, {
      enabled: true,
      remindAfterMinutes: 3,
      disableAfterMinutes: 6,
      disableForHours: 2,
      unfreezeNotice:
        "客服微信：movie-help\n・自助解冻次数：每月上限 {{monthlyLimit}} 次，已用 {{usedThisMonth}} 次，本次解冻后还剩 {{remainingChances}} 次",
    });

    const first = migrateLegacyConfig(database.db);
    expect(first.repaired).toEqual(["concurrencyPolicy.unfreezeNotice"]);
    const repaired = readSettings(database.db, {}).values["concurrencyPolicy.unfreezeNotice"];
    expect(repaired).toContain("本次解冻后还剩 {{remainingAfterThis}} 次");
    // 管理员自己写的那行（客服微信）必须原样保留，不能顺手改掉
    expect(repaired).toContain("客服微信：movie-help");

    // 反复执行安全：第二次没得修
    expect(migrateLegacyConfig(database.db).repaired).toEqual([]);
  });

  it("writes through the adapters into app_settings, leaving the legacy tables alone", () => {
    saveConcurrencyPolicy(database.db, {
      enabled: true,
      remindAfterMinutes: 3,
      disableAfterMinutes: 6,
      disableForHours: 2,
      adminEmail: null,
      interruptStreams: true,
      defaultStreamLimit: 1,
    });
    saveMailDefaults(database.db, { membership_reminder: false });

    const { values } = readSettings(database.db, {});
    expect(values["concurrencyPolicy.adminEmail"]).toBe("");
    expect(values["mail.membershipReminder"]).toBe(false);

    // 旧表不再被写入：回滚时仍能看到迁移前的内容
    const seededMail = database.db.select().from(mailDefaultSettings).where(eq(mailDefaultSettings.id, 1)).get();
    expect(seededMail?.taskUpdate).toBe(true); // 仍是 migrate.ts 的种子值，不被适配器改写
  });
});
