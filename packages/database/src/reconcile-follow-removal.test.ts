import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDatabase, type DatabaseHandle } from "./client";
import { applyPostMigrationReconciliation } from "./reconcile";

/**
 * 追更（follow）功能整体下线（2026-09）后，老库清理的守护用例。
 *
 * 为什么单独一个文件：这次下线的清理有三类动作，每一类都碰真实数据——
 *   ① 丢表：task_subscriptions / public_follow_requests / follow_progress_logs / metric_daily；
 *   ② 删列：media_tasks.track_mode；
 *   ③ 删行：task_type='follow' 的 media_tasks，连同它的 task_seasons 与 task_runs。
 * 前两类删不干净只是漂移；第三类最容易删错——所以这里先造一个"老库"（既有死表死列，
 * 也有活的 ingest 任务与它的执行历史），再把边界钉死：删的是追更，不是别的任务。
 *
 * 追更的 task_runs 为什么也要删：task_runs.task_id 指向 media_tasks(id) 且没有 ON DELETE 动作，
 * 父行删不掉；而 migrate() 末尾的 PRAGMA foreign_key_check 又不允许留下悬空的 run 行。
 * 于是"追更任务的执行历史"只能跟着任务走，这条约束也一并钉在用例里。
 *
 * 幂等是硬要求：reconcile 在每次进程启动的 migrate() 末尾都会跑，
 * 第二次跑必须不抛错、且结果与第一次完全一致（否则"重启一次库就变一次"）。
 */
const seededAt = "2026-09-01T00:00:00.000Z";
/** 两个追更任务（要连同 task_seasons、task_runs 一起被删）。 */
const followTaskIds = [9001, 9002];
/** 一个完结入库任务（必须原样活着，用来证明删除没有扩大化）。 */
const ingestTaskId = 9100;
const mediaItemId = 9001;

/**
 * 造老库：createDatabase 已经跑完迁移 + 对账，所以这里补的全是"新代码已经不认、
 * 但老库里确实存在"的东西——手写死表、手加死列，再灌进追更/入库两类任务行。
 */
function seedLegacyFollowDatabase(database: DatabaseHandle): void {
  const db = database.db;

  // ① 三张死表。public_follow_requests / follow_progress_logs 当年就是这个对账段建的；
  // task_subscriptions 是 drizzle 0029 建的（新 reconcile 在建库时已把它丢掉），
  // 这里按生产库里的真实 DDL 重造一份，形状一致才有可比性。
  db.run(sql`DROP TABLE IF EXISTS public_follow_requests`);
  db.run(sql`DROP TABLE IF EXISTS follow_progress_logs`);
  db.run(sql`DROP TABLE IF EXISTS task_subscriptions`);
  db.run(sql`CREATE TABLE public_follow_requests (
    id INTEGER PRIMARY KEY,
    email TEXT NOT NULL,
    tmdb_id INTEGER,
    title TEXT NOT NULL,
    platform TEXT NOT NULL DEFAULT '其他',
    year INTEGER,
    poster_url TEXT,
    season_number INTEGER,
    note TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    admin_note TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  db.run(sql`CREATE TABLE follow_progress_logs (
    id INTEGER PRIMARY KEY,
    task_id INTEGER NOT NULL,
    season_number INTEGER,
    air_progress INTEGER,
    stored_progress INTEGER,
    checked_at TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'system'
  )`);
  db.run(sql`CREATE TABLE task_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
    task_id INTEGER NOT NULL,
    email TEXT NOT NULL,
    enabled INTEGER DEFAULT 1 NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (task_id) REFERENCES media_tasks(id) ON UPDATE cascade ON DELETE cascade
  )`);
  db.run(sql`INSERT INTO public_follow_requests (email, title, created_at, updated_at)
    VALUES ('member@example.com', '求追的剧', ${seededAt}, ${seededAt})`);

  // ② 死列：track_mode 当年是 NOT NULL DEFAULT 'finished'，老行里带着值。
  db.run(sql`ALTER TABLE media_tasks ADD COLUMN track_mode TEXT NOT NULL DEFAULT 'finished'`);
  // 业务日报表在新库里已经不再建（唯一写入方随追更下线被删），这里按老库形状整张重造，
  // 并灌进带值的一行——清理必须把表和数据一起带走，不能"表没了、行还留着"。
  db.run(sql`CREATE TABLE metric_daily (
    date TEXT PRIMARY KEY,
    submitted INTEGER NOT NULL DEFAULT 0,
    converted INTEGER NOT NULL DEFAULT 0,
    inlibrary INTEGER NOT NULL DEFAULT 0,
    follow_added INTEGER NOT NULL DEFAULT 0,
    follow_finished INTEGER NOT NULL DEFAULT 0,
    errors INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  )`);
  db.run(sql`INSERT INTO metric_daily (date, submitted, converted, inlibrary, errors, updated_at, follow_added, follow_finished)
    VALUES ('2026-08-31', 4, 3, 2, 1, ${seededAt}, 7, 5)`);

  // ③ 任务行：media_tasks 的必填列是 media_item_id / task_type / status /
  // idempotency_key / created_at / updated_at（其余列都有默认值）。
  db.run(sql`INSERT INTO media_items (id, tmdb_id, media_type, title, created_at, updated_at)
    VALUES (${mediaItemId}, ${mediaItemId}, 'tv', '追更剧集', ${seededAt}, ${seededAt})`);
  for (const taskId of followTaskIds) {
    db.run(sql`INSERT INTO media_tasks (id, media_item_id, task_type, status, idempotency_key, created_at, updated_at, track_mode)
      VALUES (${taskId}, ${mediaItemId}, 'follow', 'running', ${`follow-${taskId}`}, ${seededAt}, ${seededAt}, 'finished')`);
    db.run(sql`INSERT INTO task_seasons (task_id, season_number, status, created_at, updated_at)
      VALUES (${taskId}, 1, 'tracking', ${seededAt}, ${seededAt})`);
    // 追更轮询的执行历史：task_runs.task_id 没有 ON DELETE 动作，它必须跟着任务行一起消失。
    db.run(sql`INSERT INTO task_runs (task_id, phase, started_at, finished_at, summary)
      VALUES (${taskId}, 'follow-check', ${seededAt}, ${seededAt}, '追更轮询（执行历史）')`);
  }
  // 订阅/进度日志这两张死表里的行必须晚于 tasks 插入：它们对 media_tasks 有外键。
  db.run(sql`INSERT INTO follow_progress_logs (task_id, season_number, checked_at)
    VALUES (${followTaskIds[0]}, 1, ${seededAt})`);
  db.run(
    sql`INSERT INTO task_subscriptions (task_id, email, created_at, updated_at)
      VALUES (${followTaskIds[0]}, 'member@example.com', ${seededAt}, ${seededAt})`,
  );

  db.run(sql`INSERT INTO media_tasks (id, media_item_id, task_type, status, idempotency_key, created_at, updated_at, track_mode)
    VALUES (${ingestTaskId}, ${mediaItemId}, 'ingest', 'completed', 'ingest-9100', ${seededAt}, ${seededAt}, 'finished')`);
  db.run(sql`INSERT INTO task_seasons (task_id, season_number, status, created_at, updated_at)
    VALUES (${ingestTaskId}, 1, 'finished', ${seededAt}, ${seededAt})`);
  // 入库任务的执行历史：删追更时绝对不能顺手删到它。
  db.run(sql`INSERT INTO task_runs (task_id, phase, started_at, finished_at, summary)
    VALUES (${ingestTaskId}, 'ingest', ${seededAt}, ${seededAt}, '完结入库')`);

  // ④ 投稿上的历史 task_type='follow'：表还在，只是这一列的值不再有第二种。
  db.run(sql`INSERT INTO movie_submissions (submitter_email, title, media_type, task_type, status, created_at, updated_at)
    VALUES ('member@example.com', '想追的剧', 'tv', 'follow', 'pending', ${seededAt}, ${seededAt})`);
  db.run(sql`INSERT INTO movie_submissions (submitter_email, title, media_type, task_type, status, created_at, updated_at)
    VALUES ('member@example.com', '想入库的电影', 'movie', 'ingest', 'pending', ${seededAt}, ${seededAt})`);
}

/** 一次性把"清理结果"读成可比较的快照：幂等用例直接比对两次快照是否全等。 */
interface FollowRemovalState {
  tables: string[];
  mediaTaskColumns: string[];
  followTaskRows: number;
  ingestTaskRows: number;
  followSeasonRows: number;
  ingestSeasonRows: number;
  followRunRows: number;
  ingestRunRows: number;
  submissionTaskTypes: Array<string | null>;
}

function followRemovalState(database: DatabaseHandle): FollowRemovalState {
  const db = database.db;
  const columnNames = (table: string) =>
    db
      .all<{ name: string }>(sql.raw(`PRAGMA table_info(${table})`))
      .map((row) => row.name)
      .sort();
  const count = (query: ReturnType<typeof sql>) => db.get<{ count: number }>(query)?.count ?? -1;

  return {
    tables: db
      .all<{ name: string }>(sql`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
      .map((row) => row.name),
    mediaTaskColumns: columnNames("media_tasks"),
    followTaskRows: count(sql`SELECT COUNT(*) AS count FROM media_tasks WHERE task_type = 'follow'`),
    ingestTaskRows: count(sql`SELECT COUNT(*) AS count FROM media_tasks WHERE task_type = 'ingest'`),
    followSeasonRows: count(sql`SELECT COUNT(*) AS count FROM task_seasons WHERE task_id IN (9001, 9002)`),
    ingestSeasonRows: count(sql`SELECT COUNT(*) AS count FROM task_seasons WHERE task_id = ${ingestTaskId}`),
    followRunRows: count(sql`SELECT COUNT(*) AS count FROM task_runs WHERE task_id IN (9001, 9002)`),
    ingestRunRows: count(sql`SELECT COUNT(*) AS count FROM task_runs WHERE task_id = ${ingestTaskId}`),
    submissionTaskTypes: db
      .all<{ task_type: string | null }>(sql`SELECT task_type FROM movie_submissions ORDER BY id`)
      .map((row) => row.task_type),
  };
}

/** 与追更无关的东西：三类清理动作、以及"没有顺手删/删错"的边界。 */
function expectCleanupContract(state: FollowRemovalState): void {
  // 死表必须从 sqlite_master 里消失（不是"没数据"，是表本身不在）。
  // metric_daily 也在其中：它的唯一写入方（follow-admin 的指标计数）随追更一起删了。
  for (const retired of ["task_subscriptions", "public_follow_requests", "follow_progress_logs", "metric_daily"]) {
    expect(state.tables, `已下线的表 ${retired} 还在库里`).not.toContain(retired);
  }
  // 活表不能被顺手删掉。
  for (const kept of ["media_tasks", "task_seasons", "task_runs", "movie_submissions", "audit_logs"]) {
    expect(state.tables, `仍在用的表 ${kept} 被误删`).toContain(kept);
  }

  // 死列同理：PRAGMA 里查不到才算删掉。
  expect(state.mediaTaskColumns).not.toContain("track_mode");

  // 行级边界：追更任务与它的分季行清掉，完结入库任务连同它的分季行原样保留。
  expect(state.followTaskRows).toBe(0);
  expect(state.ingestTaskRows).toBe(1);
  expect(state.followSeasonRows).toBe(0);
  expect(state.ingestSeasonRows).toBe(1);
  expect(state.ingestRunRows, "入库任务的执行历史被误删").toBe(1);
  // 追更的执行历史必须清干净：留着它既删不掉父行，也会让 foreign_key_check 报悬空。
  expect(state.followRunRows, "追更任务的 task_runs 没跟着任务一起清掉").toBe(0);
}

describe("follow removal reconciliation", () => {
  let directory: string;
  let database: DatabaseHandle;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "emby-follow-removal-"));
    database = createDatabase(join(directory, "legacy.sqlite"));
  });

  afterEach(() => {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });

  /**
   * 追更任务带着执行历史的形状：外键决定了 runs 只能跟着任务一起删，这是最容易删错的一档。
   */
  describe("with follow tasks that have execution history", () => {
    beforeEach(() => {
      seedLegacyFollowDatabase(database);
    });

    it("drops the follow tables, columns and task rows of a legacy database", () => {
      applyPostMigrationReconciliation(database.db);
      const state = followRemovalState(database);

      expectCleanupContract(state);
      // 造夹具时确认过：这两条 runs 确实存在，删除动作真的删到了东西（不是空转）。
      expect(state.followRunRows).toBe(0);
    });

    it("collapses legacy task_type='follow' submissions into 'ingest'", () => {
      applyPostMigrationReconciliation(database.db);

      // 投稿链路本身早已没有写入方，但历史值留着会让读取方以为还有第二种任务类型。
      expect(followRemovalState(database).submissionTaskTypes).toEqual(["ingest", "ingest"]);
    });

    it("is idempotent: reconciliating the cleaned database again changes nothing", () => {
      applyPostMigrationReconciliation(database.db);
      const afterFirstRun = followRemovalState(database);

      // reconcile 每次启动都会跑：第二次必须既不抛错，也不改动任何东西。
      expect(() => applyPostMigrationReconciliation(database.db)).not.toThrow();
      expect(followRemovalState(database)).toEqual(afterFirstRun);
    });
  });
});
