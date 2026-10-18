import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { getTableColumns, getTableName, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { createDatabase } from "./client";
import * as schema from "./schema";

/**
 * 老库升级兼容性（P5）。
 *
 * 拿仓库里真实的历史数据库快照（`.local/*.db`，已被 gitignore）各复制一份跑一遍迁移，
 * 断言：迁移不报错、schema.ts 声明的表/列在升级后全部存在。
 * 这是"改数据层"唯一能证明没把老用户库搞坏的自动化手段——比只跑空库迁移强得多。
 *
 * CI 里没有这些快照，自动跳过；本机有快照时会真跑（只读原文件，永远操作副本）。
 */
const drizzleTableMarker = Symbol.for("drizzle:IsDrizzleTable");
const MAX_SNAPSHOTS = 8;

function snapshotFiles(): string[] {
  const root = resolve(".local");
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((name) => name.endsWith(".db"))
    .map((name) => join(root, name))
    .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)
    .slice(0, MAX_SNAPSHOTS);
}

interface DriftProblem {
  problem: string;
}

function inspectSchemaCompleteness(database: ReturnType<typeof createDatabase>): {
  appliedMigrations: number;
  tableCount: number;
  problems: string[];
} {
  const applied = database.db.get<{ count: number }>(sql`SELECT COUNT(*) AS count FROM __drizzle_migrations`);
  const tables = database.db.all<{ name: string }>(sql`SELECT name FROM sqlite_master WHERE type = 'table'`);
  const problems: string[] = [];

  for (const [exportName, table] of Object.entries(schema)) {
    if (typeof table !== "object" || table === null || !(drizzleTableMarker in table)) continue;
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

  return { appliedMigrations: applied?.count ?? 0, tableCount: tables.length, problems };
}

const snapshots = snapshotFiles();

describe.skipIf(snapshots.length === 0)("upgrade from historical databases", () => {
  it.each(snapshots.length > 0 ? snapshots : ["<no snapshot>"])("migrates %s without losing schema", (source) => {
    const directory = mkdtempSync(join(tmpdir(), "emby-upgrade-"));
    const copy = join(directory, "snapshot.sqlite");
    copyFileSync(source, copy);
    const handle = createDatabase(copy);
    try {
      const result = inspectSchemaCompleteness(handle);
      expect(result.appliedMigrations).toBeGreaterThan(0);
      expect(result.problems, `${source} 升级后 schema 不完整：\n${result.problems.join("\n")}`).toEqual([]);
      // 已下线功能的表不许留在升级后的库里（老快照里确实有过 emby_proxy_settings）。
      const retired = handle.db.all<{ name: string }>(
        sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'emby_proxy_settings'`,
      );
      expect(retired, `${source} 升级后仍残留已下线的表`).toEqual([]);
    } finally {
      handle.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

// 让类型在使用处可见（避免 noUnusedLocals 误报）
export type { DriftProblem };
