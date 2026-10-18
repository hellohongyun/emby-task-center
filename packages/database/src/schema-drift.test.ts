import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getTableColumns, getTableName, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDatabase, type DatabaseHandle } from "./client";
import { applyPostMigrationReconciliation } from "./reconcile";
import * as schema from "./schema";

/**
 * schema.ts ↔ 迁移结果 的一致性守护（P5）。
 *
 * 为什么需要：本仓库的建表有两条来源——`drizzle/` 下的迁移历史，和 `reconcile.ts` 里
 * drizzle-kit 不可用之后新增的幂等对账。谁漏了一步，只有当运行时用到那张表/那一列才会炸。
 * 这个用例把"schema.ts 声明的东西，跑完 migrate() 之后必须都存在"变成硬约束。
 *
 * 只比结构（表名 + 列名），不比索引/默认值：够拦住绝大多数漂移，且不会因为 drizzle 版本
 * 生成的 SQL 差异而误报。
 */
const drizzleTableMarker = Symbol.for("drizzle:IsDrizzleTable");

function isDrizzleTable(value: unknown): boolean {
  return typeof value === "object" && value !== null && drizzleTableMarker in value;
}

describe("schema drift", () => {
  let directory: string;
  let database: DatabaseHandle;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "emby-schema-drift-"));
    database = createDatabase(join(directory, "drift.sqlite"));
  });

  afterEach(() => {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("creates every table declared in schema.ts", () => {
    const existing = new Set(
      database.db
        .all<{ name: string }>(sql`SELECT name FROM sqlite_master WHERE type = 'table'`)
        .map((row) => row.name),
    );

    const declared = Object.entries(schema).filter(([, value]) => isDrizzleTable(value));
    expect(declared.length).toBeGreaterThan(30);

    const missing = declared
      .map(([exportName, table]) => ({ exportName, name: getTableName(table as never) }))
      .filter((item) => !existing.has(item.name));

    expect(missing, `以下表在 schema.ts 里声明，但迁移/对账没有创建：${JSON.stringify(missing)}`).toEqual([]);
  });

  it("creates every column declared in schema.ts", () => {
    const problems: string[] = [];
    for (const [exportName, table] of Object.entries(schema)) {
      if (!isDrizzleTable(table)) continue;
      const name = getTableName(table as never);
      const columns = new Set(
        database.db.all<{ name: string }>(sql.raw(`PRAGMA table_info(${name})`)).map((row) => row.name),
      );
      if (columns.size === 0) {
        problems.push(`${name}（schema.${exportName}）表不存在`);
        continue;
      }
      const declaredColumns = getTableColumns(table as never) as unknown as Record<string, { name: string }>;
      for (const [property, column] of Object.entries(declaredColumns)) {
        if (!columns.has(column.name)) problems.push(`${name}.${column.name}（schema.${exportName}.${property}）缺列`);
      }
    }

    expect(problems, `schema.ts 声明的列缺失：\n${problems.join("\n")}`).toEqual([]);
  });

  it("applies the whole drizzle journal", () => {
    const applied = database.db.get<{ count: number }>(sql`SELECT COUNT(*) AS count FROM __drizzle_migrations`);
    // 36 份迁移（0000_sturdy_mesmero … 0035_submission_settings）都必须已应用
    expect(applied?.count).toBeGreaterThanOrEqual(36);
  });

  it("is idempotent: migrating an existing database twice changes nothing", () => {
    const before = database.db
      .all<{ name: string; sql: string }>(sql`SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name`)
      .map((row) => `${row.name}:${row.sql}`);

    database.close();
    database = createDatabase(join(directory, "drift.sqlite"));

    const after = database.db
      .all<{ name: string; sql: string }>(sql`SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name`)
      .map((row) => `${row.name}:${row.sql}`);
    expect(after).toEqual(before);
  });

  it("drops tables that are no longer declared in schema.ts", () => {
    // 老库里还留着已下线功能的表（对账在 schema.ts 之外建过它），升级时必须被丢掉，
    // 否则"功能删了、表还在"会一直漂移下去。
    database.db.run(sql`CREATE TABLE emby_proxy_settings (
      id INTEGER PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 0,
      upstream TEXT NOT NULL DEFAULT '',
      port INTEGER NOT NULL DEFAULT 8097,
      public_url TEXT,
      updated_at TEXT NOT NULL
    )`);

    applyPostMigrationReconciliation(database.db);

    const tables = new Set(
      database.db
        .all<{ name: string }>(sql`SELECT name FROM sqlite_master WHERE type = 'table'`)
        .map((row) => row.name),
    );
    expect(tables.has("emby_proxy_settings")).toBe(false);
  });

  it("drops the follow-era tables and columns retired in 2026-09", () => {
    // 追更（follow）整体下线：三张死表（老库里确实有过：两张是本对账段当年建的，
    // task_subscriptions 是 drizzle 0029 建的）和 media_tasks.track_mode 死列，都必须被清掉——
    // 表/列一旦留在库里，schema.ts ↔ 库里结构就再也对不上，往后每次读 schema 都得先猜库长什么样。
    // 这里只造结构、不造行：删 follow 任务行要连同 task_runs 的边界由
    // reconcile-follow-removal.test.ts 专门覆盖。
    database.db.run(sql`CREATE TABLE task_subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
      task_id INTEGER NOT NULL,
      email TEXT NOT NULL,
      enabled INTEGER DEFAULT 1 NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (task_id) REFERENCES media_tasks(id) ON UPDATE cascade ON DELETE cascade
    )`);
    database.db.run(sql`CREATE TABLE public_follow_requests (
      id INTEGER PRIMARY KEY,
      email TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`);
    database.db.run(sql`CREATE TABLE follow_progress_logs (
      id INTEGER PRIMARY KEY,
      task_id INTEGER NOT NULL,
      season_number INTEGER,
      air_progress INTEGER,
      stored_progress INTEGER,
      checked_at TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'system'
    )`);
    database.db.run(sql`ALTER TABLE media_tasks ADD COLUMN track_mode TEXT NOT NULL DEFAULT 'finished'`);

    applyPostMigrationReconciliation(database.db);

    const tables = new Set(
      database.db
        .all<{ name: string }>(sql`SELECT name FROM sqlite_master WHERE type = 'table'`)
        .map((row) => row.name),
    );
    for (const retired of ["task_subscriptions", "public_follow_requests", "follow_progress_logs"]) {
      expect(tables.has(retired), `已下线的表 ${retired} 升级后仍留在库里`).toBe(false);
    }
    const taskColumns = database.db.all<{ name: string }>(sql`PRAGMA table_info(media_tasks)`).map((row) => row.name);
    expect(taskColumns, "已下线的列 media_tasks.track_mode 升级后仍留在库里").not.toContain("track_mode");
    // 活表不能被顺手删掉。
    expect(tables.has("media_tasks")).toBe(true);
  });

  it("drops the retired check-in tables along with their rows (2026-09)", () => {
    // 自动签到子系统整体下线：老库里的 checkin_tasks / checkin_runs 必须被**连表带行**一起清掉，
    // 理由和上面两条一样（功能删了、表还在，schema.ts ↔ 库里结构就永远对不上）。
    // 代码里已经没有第二处读这两张表，所以这里只断言表被丢掉、活表没被误伤。
    database.db.run(sql`CREATE TABLE checkin_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'tg',
      target TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`);
    database.db.run(sql`CREATE TABLE checkin_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL REFERENCES checkin_tasks(id) ON DELETE CASCADE,
      trigger TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL
    )`);
    database.db.run(sql`INSERT INTO checkin_tasks (name, kind, target, created_at, updated_at)
      VALUES ('签到机器人每日签到', 'tg', '@qd_bot', 'x', 'x')`);

    applyPostMigrationReconciliation(database.db);

    const tables = new Set(
      database.db
        .all<{ name: string }>(sql`SELECT name FROM sqlite_master WHERE type = 'table'`)
        .map((row) => row.name),
    );
    expect(tables.has("checkin_tasks"), "已下线的表 checkin_tasks 升级后仍留在库里").toBe(false);
    expect(tables.has("checkin_runs"), "已下线的表 checkin_runs 升级后仍留在库里").toBe(false);
    // 活表不能被顺手删掉。
    expect(tables.has("media_tasks")).toBe(true);
  });

  it("drops the retired task-update mail tables (2026-09)", () => {
    // 「任务更新通知」整条链下线：发送方（email-service 的 sendTaskUpdate）已经没有调用方，
    // 任务收件人与全局收件人两张表随之没有任何读写方，必须从老库里清掉
    // （它们由 drizzle 迁移 0003 / 0021 建过，所以"不建"是不够的）。
    database.db.run(sql`CREATE TABLE task_notification_recipients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL,
      email TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`);
    database.db.run(sql`CREATE TABLE global_notification_recipients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`);
    database.db.run(sql`INSERT INTO global_notification_recipients (email, enabled, created_at, updated_at)
      VALUES ('all@example.com', 1, 'x', 'x')`);

    applyPostMigrationReconciliation(database.db);

    const tables = new Set(
      database.db
        .all<{ name: string }>(sql`SELECT name FROM sqlite_master WHERE type = 'table'`)
        .map((row) => row.name),
    );
    expect(tables.has("task_notification_recipients"), "已下线的表 task_notification_recipients 仍留在库里").toBe(
      false,
    );
    expect(tables.has("global_notification_recipients"), "已下线的表 global_notification_recipients 仍留在库里").toBe(
      false,
    );
    // 活表不能被顺手删掉。
    expect(tables.has("media_tasks")).toBe(true);
  });
});
