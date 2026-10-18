/**
 * 迁移后的"对账"段（P5：从 migrate.ts 原样搬出，逻辑未改）。
 *
 * 为什么存在：主 schema 历史由 `drizzle/` 下的迁移负责（migrate.ts 调 drizzle migrator），
 * 现有迁移快照存在冲突；增量修复由此处的幂等 schema 检查负责。
 * 因此那之后新增的表/列改用这里幂等补齐：
 *   - 建表：`CREATE TABLE IF NOT EXISTS`
 *   - 补列 / 改数据：`PRAGMA table_info` 检查后再 `ALTER TABLE ... ADD COLUMN`，或 `INSERT OR IGNORE`
 *
 * 不变量（由 schema-drift.test.ts 守护）：schema.ts 声明的每个表/列，跑完 migrate() 后都必须存在。
 * 新增表/列时二选一：① 补一份 drizzle 迁移（若能 generate）；② 在下面加一段幂等对账（当前默认做法）。
 */
import { sql } from "drizzle-orm";

import type { AppDatabase } from "./client";
import { reconcileLegacyArticleAddresses } from "./legacy-article-address";
import { reconcileVirtualLibraries } from "./virtual-libraries-reconcile";

export function applyPostMigrationReconciliation(database: AppDatabase): void {
  reconcileVirtualLibraries(database);
  // 已下线的表：老库（首次对账时建过）里可能还留着，直接丢掉，幂等可反复执行。
  database.run(sql`DROP TABLE IF EXISTS emby_proxy_settings`);
  // 并发超限升级策略（单行）。
  database.run(sql`CREATE TABLE IF NOT EXISTS concurrency_policy_settings (
    id INTEGER PRIMARY KEY,
    enabled INTEGER NOT NULL DEFAULT 1,
    remind_after_minutes INTEGER NOT NULL DEFAULT 2,
    disable_after_minutes INTEGER NOT NULL DEFAULT 5,
    disable_for_hours INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL
  )`);
  // 兼容早先版本（disable_for_minutes 列）：补 disable_for_hours。
  const policyCols = database.all<{ name: string }>(sql`PRAGMA table_info(concurrency_policy_settings)`);
  if (!policyCols.some((column) => column.name === "disable_for_hours")) {
    database.run(sql`ALTER TABLE concurrency_policy_settings ADD COLUMN disable_for_hours INTEGER NOT NULL DEFAULT 1`);
  }
  if (!policyCols.some((column) => column.name === "admin_email")) {
    database.run(sql`ALTER TABLE concurrency_policy_settings ADD COLUMN admin_email TEXT`);
  }
  // 媒体库改由 Emby 驱动：题材由 Emby 提供，需要有地方存（幂等补列）。
  const libraryCols = database.all<{ name: string }>(sql`PRAGMA table_info(library_items)`);
  if (!libraryCols.some((column) => column.name === "genres_json")) {
    database.run(sql`ALTER TABLE library_items ADD COLUMN genres_json TEXT NOT NULL DEFAULT '[]'`);
  }
  // Emby 条目 Id 成为身份：补列 + 唯一索引（同一库内一条 Emby 条目只应有一行）。
  if (!libraryCols.some((column) => column.name === "emby_item_id")) {
    database.run(sql`ALTER TABLE library_items ADD COLUMN emby_item_id TEXT`);
    database.run(
      sql`CREATE UNIQUE INDEX IF NOT EXISTS library_items_root_emby_item ON library_items (media_root_id, emby_item_id) WHERE emby_item_id IS NOT NULL`,
    );
  }

  // 每会员的并发超限升级状态。
  database.run(sql`CREATE TABLE IF NOT EXISTS concurrency_escalation_state (
    member_id INTEGER PRIMARY KEY,
    overshoot_since TEXT,
    overshoot_ms INTEGER NOT NULL DEFAULT 0,
    notified_at TEXT,
    disabled_until TEXT,
    updated_at TEXT NOT NULL
  )`);
  // 并发冻结改成「触发式累计」：老库补 overshoot_ms（累计超限毫秒）。
  const escalationCols = database.all<{ name: string }>(sql`PRAGMA table_info(concurrency_escalation_state)`);
  if (!escalationCols.some((column) => column.name === "overshoot_ms")) {
    database.run(sql`ALTER TABLE concurrency_escalation_state ADD COLUMN overshoot_ms INTEGER NOT NULL DEFAULT 0`);
  }
  // 会员自助解冻：申请时刻（服务端校验强制等待的依据）+ 成功流水（每月次数上限按它统计）。
  if (!escalationCols.some((column) => column.name === "unfreeze_requested_at")) {
    database.run(sql`ALTER TABLE concurrency_escalation_state ADD COLUMN unfreeze_requested_at TEXT`);
  }
  database.run(sql`CREATE TABLE IF NOT EXISTS member_unfreeze_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    member_id INTEGER NOT NULL,
    email TEXT NOT NULL,
    month TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`);
  database.run(
    sql`CREATE INDEX IF NOT EXISTS member_unfreeze_events_member_month_idx ON member_unfreeze_events (member_id, month)`,
  );
  // 热点榜单来源配置。
  database.run(sql`CREATE TABLE IF NOT EXISTS trending_source_configs (
    source TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL DEFAULT 1,
    ttl_minutes INTEGER NOT NULL DEFAULT 60,
    refresh_minutes INTEGER NOT NULL DEFAULT 30,
    updated_at TEXT NOT NULL
  )`);
  // 热点榜单快照（抓取结果持久化，重启/降级兜底）。
  database.run(sql`CREATE TABLE IF NOT EXISTS trending_snapshots (
    id INTEGER PRIMARY KEY,
    source TEXT NOT NULL,
    section_key TEXT NOT NULL,
    payload TEXT NOT NULL,
    fetched_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  database.run(
    sql`CREATE UNIQUE INDEX IF NOT EXISTS trending_snapshot_source_section_idx ON trending_snapshots(source, section_key)`,
  );
  // 公开「追更请求」表、追更进度快照表、追更通知订阅表已随追更功能整体下线（2026-09）：
  // 老库里还留着它们（公开追更请求/进度快照本就是本对账段当年建的），这里直接丢掉，幂等可反复执行。
  database.run(sql`DROP TABLE IF EXISTS public_follow_requests`);
  database.run(sql`DROP TABLE IF EXISTS follow_progress_logs`);
  database.run(sql`DROP TABLE IF EXISTS task_subscriptions`);
  // 投稿的“入库完成邮件”标记列（去重；部分早期迁移场景下该表可能尚未创建，跳过即可）。
  const submissionTable = database.all<{ name: string }>(
    sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'movie_submissions'`,
  );
  if (submissionTable.length > 0) {
    const submissionCols = database.all<{ name: string }>(sql`PRAGMA table_info(movie_submissions)`);
    if (!submissionCols.some((column) => column.name === "in_library_notified_at")) {
      database.run(sql`ALTER TABLE movie_submissions ADD COLUMN in_library_notified_at TEXT`);
    }
  }
  // P0 领域完善：平台字典 / 追更完结标记 / 投稿审核字段 / 额度流水 / 追更进度 / 状态时间线。
  database.run(sql`CREATE TABLE IF NOT EXISTS platforms (
    id INTEGER PRIMARY KEY,
    code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    logo_url TEXT,
    homepage TEXT,
    sort INTEGER NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  const platformSeed = new Date().toISOString();
  database.run(sql`INSERT OR IGNORE INTO platforms (code, name, sort, created_at, updated_at) VALUES
    ('tencent', '腾讯视频', 1, ${platformSeed}, ${platformSeed}),
    ('iqiyi', '爱奇艺', 2, ${platformSeed}, ${platformSeed}),
    ('youku', '优酷', 3, ${platformSeed}, ${platformSeed}),
    ('bilibili', '哔哩哔哩', 4, ${platformSeed}, ${platformSeed}),
    ('mango', '芒果TV', 5, ${platformSeed}, ${platformSeed}),
    ('letv', '乐视视频', 6, ${platformSeed}, ${platformSeed}),
    ('other', '其他', 9, ${platformSeed}, ${platformSeed})`);

  database.run(sql`CREATE TABLE IF NOT EXISTS submission_timeline (
    id INTEGER PRIMARY KEY,
    submission_id INTEGER NOT NULL,
    from_status TEXT,
    to_status TEXT NOT NULL,
    operator TEXT NOT NULL DEFAULT 'system',
    note TEXT,
    created_at TEXT NOT NULL
  )`);
  database.run(sql`CREATE INDEX IF NOT EXISTS submission_timeline_idx ON submission_timeline(submission_id)`);

  database.run(sql`CREATE TABLE IF NOT EXISTS quota_ledger (
    id INTEGER PRIMARY KEY,
    email TEXT NOT NULL,
    type TEXT NOT NULL,
    amount INTEGER NOT NULL,
    submission_id INTEGER,
    note TEXT,
    created_at TEXT NOT NULL
  )`);
  database.run(sql`CREATE INDEX IF NOT EXISTS quota_ledger_email_idx ON quota_ledger(email)`);

  // 追更/完结标记（track_mode）随追更功能下线（2026-09）：SQLite 支持 DROP COLUMN，
  // 先查 PRAGMA 再删，保证反复执行不报错（老库有、新库没有）。
  const taskCols = database.all<{ name: string }>(sql`PRAGMA table_info(media_tasks)`);
  if (taskCols.some((column) => column.name === "track_mode")) {
    database.run(sql`ALTER TABLE media_tasks DROP COLUMN track_mode`);
  }
  // 投稿：来源平台与期望画质。
  if (submissionTable.length > 0) {
    const submissionCols2 = database.all<{ name: string }>(sql`PRAGMA table_info(movie_submissions)`);
    if (!submissionCols2.some((column) => column.name === "platform")) {
      database.run(sql`ALTER TABLE movie_submissions ADD COLUMN platform TEXT`);
    }
    if (!submissionCols2.some((column) => column.name === "expected_quality")) {
      database.run(sql`ALTER TABLE movie_submissions ADD COLUMN expected_quality TEXT`);
    }
    // PanSou 投稿→自动入库：所选资源与入库状态（链接/口令仅服务端保存）。
    const pansouSubmissionCols = database.all<{ name: string }>(sql`PRAGMA table_info(movie_submissions)`);
    if (!pansouSubmissionCols.some((column) => column.name === "selected_url")) {
      database.run(sql`ALTER TABLE movie_submissions ADD COLUMN selected_url TEXT`);
    }
    if (!pansouSubmissionCols.some((column) => column.name === "selected_password")) {
      database.run(sql`ALTER TABLE movie_submissions ADD COLUMN selected_password TEXT`);
    }
    if (!pansouSubmissionCols.some((column) => column.name === "selected_platform")) {
      database.run(sql`ALTER TABLE movie_submissions ADD COLUMN selected_platform TEXT`);
    }
    if (!pansouSubmissionCols.some((column) => column.name === "selected_note")) {
      database.run(sql`ALTER TABLE movie_submissions ADD COLUMN selected_note TEXT`);
    }
    if (!pansouSubmissionCols.some((column) => column.name === "selected_source")) {
      database.run(sql`ALTER TABLE movie_submissions ADD COLUMN selected_source TEXT`);
    }
    if (!pansouSubmissionCols.some((column) => column.name === "selected_display_type")) {
      database.run(sql`ALTER TABLE movie_submissions ADD COLUMN selected_display_type TEXT`);
    }
    if (!pansouSubmissionCols.some((column) => column.name === "resource_id")) {
      database.run(sql`ALTER TABLE movie_submissions ADD COLUMN resource_id TEXT`);
    }
    if (!pansouSubmissionCols.some((column) => column.name === "ingest_status")) {
      database.run(sql`ALTER TABLE movie_submissions ADD COLUMN ingest_status TEXT`);
    }
    if (!pansouSubmissionCols.some((column) => column.name === "ingest_error")) {
      database.run(sql`ALTER TABLE movie_submissions ADD COLUMN ingest_error TEXT`);
    }
    if (!pansouSubmissionCols.some((column) => column.name === "ingest_notified")) {
      database.run(sql`ALTER TABLE movie_submissions ADD COLUMN ingest_notified INTEGER NOT NULL DEFAULT 0`);
    }
    if (!pansouSubmissionCols.some((column) => column.name === "ingest_stage")) {
      database.run(sql`ALTER TABLE movie_submissions ADD COLUMN ingest_stage TEXT`);
    }
    if (!pansouSubmissionCols.some((column) => column.name === "ingest_stage_at")) {
      database.run(sql`ALTER TABLE movie_submissions ADD COLUMN ingest_stage_at TEXT`);
    }
  }

  // PanSou 网盘/磁力启用开关（管理后台可调）。
  database.run(sql`CREATE TABLE IF NOT EXISTS pansou_platform_settings (
    platform TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL DEFAULT 1,
    sort INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  )`);
  const pansouPlatformSeed = new Date().toISOString();
  // 与 pansou-filter.ts 的 DEFAULT_ENABLED_PLATFORMS 保持一致：默认只开 115 + 磁力。
  // 用 INSERT OR IGNORE：仅在表为空（全新库）时落默认行，绝不覆盖管理员已保存的开关。
  const defaultPansouPlatforms: Array<[string, number, number]> = [
    ["115", 1, 10], // 115 网盘（默认开）
    ["magnet", 1, 20], // 磁力（默认开）
    ["123", 0, 30], // 123 云盘（默认关）
    ["other", 0, 40], // 光鸭云盘（默认关）
    ["tianyi", 0, 50],
    ["quark", 0, 60],
    ["baidu", 0, 70],
    ["xunlei", 0, 80],
    ["uc", 0, 90],
    ["aliyun", 0, 100],
    ["mobile", 0, 110],
  ];
  for (const [platform, enabled, sort] of defaultPansouPlatforms) {
    database.run(sql`INSERT OR IGNORE INTO pansou_platform_settings (platform, enabled, sort, updated_at)
      VALUES (${platform}, ${enabled}, ${sort}, ${pansouPlatformSeed})`);
  }

  // 应用设置（P1 配置后台化）：env → 数据库的通用键值表。
  // 具体键的类型/默认值/密钥标记在 apps/server/src/settings/registry.ts 定义，这里只建表。
  database.run(sql`CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT,
    is_secret INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    updated_by TEXT
  )`);

  // 二期：移除已删除的 AI/LitePan webhook、任务自动化、自动化运行表。
  database.run(sql`DROP TABLE IF EXISTS webhook_configs`);
  database.run(sql`DROP TABLE IF EXISTS task_automation_settings`);
  database.run(sql`DROP TABLE IF EXISTS automation_runs`);
  database.run(sql`DROP TABLE IF EXISTS notify_queue_settings`);
  // 投递表与两张收件人表随「任务更新通知」整条链一起丢掉（2026-09）：
  // 发送方（email-service 的 sendTaskUpdate）已经没有任何调用方，收件人列表再没有任何读方，
  // 功能删了却把表留在库里，schema.ts ↔ 库结构就永远对不上。
  // 顺序被外键逼出来：notification_deliveries.recipient_id 指向 task_notification_recipients。
  database.run(sql`DROP TABLE IF EXISTS notification_deliveries`);
  database.run(sql`DROP TABLE IF EXISTS task_notification_recipients`);
  database.run(sql`DROP TABLE IF EXISTS global_notification_recipients`);
  // P1/P2：媒体唯一标识/别名、站内通知、分季跟踪、日报、审计、内容源。
  const mediaItemCols = database.all<{ name: string }>(sql`PRAGMA table_info(media_items)`);
  if (!mediaItemCols.some((column) => column.name === "imdb_id")) {
    database.run(sql`ALTER TABLE media_items ADD COLUMN imdb_id TEXT`);
  }
  if (!mediaItemCols.some((column) => column.name === "douban_id")) {
    database.run(sql`ALTER TABLE media_items ADD COLUMN douban_id TEXT`);
  }
  const libraryItemCols = database.all<{ name: string }>(sql`PRAGMA table_info(library_items)`);
  if (!libraryItemCols.some((column) => column.name === "quality")) {
    database.run(sql`ALTER TABLE library_items ADD COLUMN quality TEXT`);
  }
  if (!libraryItemCols.some((column) => column.name === "source_provider")) {
    database.run(sql`ALTER TABLE library_items ADD COLUMN source_provider TEXT`);
  }
  if (!libraryItemCols.some((column) => column.name === "subtitle_langs_json")) {
    database.run(sql`ALTER TABLE library_items ADD COLUMN subtitle_langs_json TEXT NOT NULL DEFAULT '[]'`);
  }
  if (!libraryItemCols.some((column) => column.name === "poster_cache_path")) {
    database.run(sql`ALTER TABLE library_items ADD COLUMN poster_cache_path TEXT`);
  }

  // 全库缺集快照（缺集总览）：后台扫描器定时写入，页面只读。
  // TMDB 季/集缓存也在同一行（tmdb_seasons_json）：缓存未过期时每小时重算不必再打 TMDB。
  database.run(sql`CREATE TABLE IF NOT EXISTS missing_episode_snapshots (
    media_item_id INTEGER PRIMARY KEY REFERENCES media_items(id),
    tmdb_id INTEGER,
    title TEXT NOT NULL,
    tmdb_seasons_json TEXT NOT NULL DEFAULT '[]',
    fetched_at TEXT,
    missing_json TEXT NOT NULL DEFAULT '[]',
    unmatched_seasons_json TEXT NOT NULL DEFAULT '[]',
    aired_count INTEGER NOT NULL DEFAULT 0,
    stored_count INTEGER NOT NULL DEFAULT 0,
    missing_count INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    scanned_at TEXT NOT NULL
  )`);
  // 后来补的列：编号体系疑似不一致、未判定缺集的季；以及 Emby 跳转用的季/剧条目 Id。
  const snapshotCols = database.all<{ name: string }>(sql`PRAGMA table_info(missing_episode_snapshots)`);
  if (!snapshotCols.some((column) => column.name === "suspect_seasons_json")) {
    database.run(sql`ALTER TABLE missing_episode_snapshots ADD COLUMN suspect_seasons_json TEXT NOT NULL DEFAULT '[]'`);
  }
  if (!snapshotCols.some((column) => column.name === "emby_series_id")) {
    database.run(sql`ALTER TABLE missing_episode_snapshots ADD COLUMN emby_series_id TEXT`);
  }
  if (!snapshotCols.some((column) => column.name === "emby_tmdb_id")) {
    database.run(sql`ALTER TABLE missing_episode_snapshots ADD COLUMN emby_tmdb_id INTEGER`);
  }
  if (!snapshotCols.some((column) => column.name === "emby_seasons_json")) {
    database.run(sql`ALTER TABLE missing_episode_snapshots ADD COLUMN emby_seasons_json TEXT NOT NULL DEFAULT '[]'`);
  }
  // 宽限期内（默认=今日更新）暂不计缺集的集：当天晚间才入库的集白天不该报缺集。
  if (!snapshotCols.some((column) => column.name === "pending_seasons_json")) {
    database.run(sql`ALTER TABLE missing_episode_snapshots ADD COLUMN pending_seasons_json TEXT NOT NULL DEFAULT '[]'`);
  }

  database.run(sql`CREATE TABLE IF NOT EXISTS media_aliases (
    id INTEGER PRIMARY KEY,
    item_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    lang TEXT NOT NULL DEFAULT 'zh',
    source TEXT NOT NULL DEFAULT 'auto',
    created_at TEXT NOT NULL
  )`);
  database.run(sql`CREATE UNIQUE INDEX IF NOT EXISTS media_aliases_item_name_idx ON media_aliases(item_id, name)`);

  database.run(sql`CREATE TABLE IF NOT EXISTS user_notifications (
    id INTEGER PRIMARY KEY,
    email TEXT NOT NULL,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT,
    link TEXT,
    read_at TEXT,
    created_at TEXT NOT NULL
  )`);
  database.run(sql`CREATE INDEX IF NOT EXISTS user_notifications_email_idx ON user_notifications(email, id)`);

  database.run(sql`CREATE TABLE IF NOT EXISTS task_seasons (
    id INTEGER PRIMARY KEY,
    task_id INTEGER NOT NULL,
    season_number INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'tracking',
    air_progress INTEGER,
    stored_progress INTEGER,
    last_check_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  database.run(
    sql`CREATE UNIQUE INDEX IF NOT EXISTS task_seasons_task_season_idx ON task_seasons(task_id, season_number)`,
  );
  // 宽限期内（默认=今日更新）的集数：已播但暂不计缺集，看板据此显示「今日更新 N 集」。
  const taskSeasonCols = database.all<{ name: string }>(sql`PRAGMA table_info(task_seasons)`);
  if (!taskSeasonCols.some((column) => column.name === "air_pending_progress")) {
    database.run(sql`ALTER TABLE task_seasons ADD COLUMN air_pending_progress INTEGER`);
  }
  // 任务级同一口径的集数（列表/调度按任务读，不逐季汇总时也要能排除今日更新）。
  const mediaTaskCols = database.all<{ name: string }>(sql`PRAGMA table_info(media_tasks)`);
  if (!mediaTaskCols.some((column) => column.name === "air_pending_progress")) {
    database.run(sql`ALTER TABLE media_tasks ADD COLUMN air_pending_progress INTEGER`);
  }

  // 业务日报表随追更指标下线（2026-09）：它的唯一写入方是被删的 follow-admin 路由，
  // 老库里还留着这张表和 follow_added/follow_finished 两列计数，这里整张丢掉，幂等。
  database.run(sql`DROP TABLE IF EXISTS metric_daily`);

  // 追更任务行整体删除（2026-09 用户决策）：task_type='follow' 的任务连同它的追更专属数据一起清掉。
  // 顺序是被外键逼出来的：task_runs.task_id 指向 media_tasks(id) 且没有 ON DELETE 动作，
  // 先删任务行会直接 FK 失败；而 migrate() 结束时的 foreign_key_check 又不允许留下悬空的 run 行，
  // 所以执行历史只能跟着任务一起走（本机实测 task_runs 总量为 0，没有真正丢掉东西）。
  // 幂等：第二次跑时已经没有 follow 行，删除 0 行，也不报错。
  const followTaskIds = database
    .all<{ id: number }>(sql`SELECT id FROM media_tasks WHERE task_type = 'follow'`)
    .map((row) => row.id);
  for (const taskId of followTaskIds) {
    database.run(sql`DELETE FROM task_runs WHERE task_id = ${taskId}`);
    database.run(sql`DELETE FROM task_seasons WHERE task_id = ${taskId}`);
    database.run(sql`DELETE FROM media_tasks WHERE id = ${taskId}`);
  }
  // 投稿表上的"任务类型"列同理：追更已下线（2026-09），留下的值只会让读取方以为还有第二种类型。
  // 投稿链路本身早已没有写入方，这里只是把历史值收敛成唯一合法值。
  // 存在性守卫不能省：migrate.test.ts 会喂"只应用了部分迁移日志"的库，那时这张表还没建。
  if (submissionTable.length > 0) {
    database.run(sql`UPDATE movie_submissions SET task_type = 'ingest' WHERE task_type = 'follow'`);
  }

  database.run(sql`CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY,
    operator TEXT NOT NULL DEFAULT 'system',
    action TEXT NOT NULL,
    target_type TEXT NOT NULL,
    target_id INTEGER,
    before_json TEXT,
    after_json TEXT,
    note TEXT,
    created_at TEXT NOT NULL
  )`);
  database.run(sql`CREATE INDEX IF NOT EXISTS audit_logs_created_idx ON audit_logs(created_at)`);

  database.run(sql`CREATE TABLE IF NOT EXISTS content_providers (
    id INTEGER PRIMARY KEY,
    code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    adapter TEXT NOT NULL,
    config_json TEXT NOT NULL DEFAULT '{}',
    enabled INTEGER NOT NULL DEFAULT 1,
    priority INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  const providerSeed = new Date().toISOString();
  database.run(sql`INSERT OR IGNORE INTO content_providers (code, name, adapter, enabled, priority, created_at, updated_at) VALUES
    ('tmdb', 'TMDB', 'tmdb', 1, 100, ${providerSeed}, ${providerSeed}),
    ('douban', '豆瓣', 'douban', 0, 50, ${providerSeed}, ${providerSeed}),
    ('maoyan', '猫眼', 'maoyan', 0, 40, ${providerSeed}, ${providerSeed}),
    ('bilibili', '哔哩哔哩', 'bilibili', 0, 30, ${providerSeed}, ${providerSeed}),
    ('tencent', '腾讯视频', 'tencent', 0, 20, ${providerSeed}, ${providerSeed})`);

  database.run(sql`CREATE TABLE IF NOT EXISTS provider_items (
    id INTEGER PRIMARY KEY,
    provider_id INTEGER NOT NULL,
    external_id TEXT NOT NULL,
    item_id INTEGER,
    external_title TEXT,
    quality TEXT,
    available INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL
  )`);
  database.run(
    sql`CREATE UNIQUE INDEX IF NOT EXISTS provider_items_provider_external_idx ON provider_items(provider_id, external_id)`,
  );

  // 站内通知保留期（单行设置，行政端可调）。
  database.run(sql`CREATE TABLE IF NOT EXISTS notify_retention_settings (
    id INTEGER PRIMARY KEY,
    short_days INTEGER NOT NULL DEFAULT 30,
    important_days INTEGER NOT NULL DEFAULT 180,
    default_days INTEGER NOT NULL DEFAULT 120,
    updated_at TEXT NOT NULL
  )`);
  database.run(sql`INSERT OR IGNORE INTO notify_retention_settings (id, short_days, important_days, default_days, updated_at)
    VALUES (1, 30, 180, 120, ${providerSeed})`);

  // 邮件默认发送设置（管理员全局默认）+ 用户邮件偏好覆盖。
  // 这张表只是**迁移来源**（legacy-migration 把 membership_reminder 读进 app_settings），
  // 早已没有写入方；task_update / submission_* 两批列同理，功能下线后不再被读，
  // 列留着只是"老库不重建"的代价，删列要动老库结构、收益为零。
  database.run(sql`CREATE TABLE IF NOT EXISTS mail_default_settings (
    id INTEGER PRIMARY KEY,
    submission_receipt INTEGER NOT NULL DEFAULT 1,
    submission_converted INTEGER NOT NULL DEFAULT 1,
    submission_rejected INTEGER NOT NULL DEFAULT 1,
    submission_duplicate INTEGER NOT NULL DEFAULT 1,
    submission_inlibrary INTEGER NOT NULL DEFAULT 1,
    membership_reminder INTEGER NOT NULL DEFAULT 1,
    task_update INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL
  )`);
  database.run(sql`INSERT OR IGNORE INTO mail_default_settings (id, updated_at) VALUES (1, ${providerSeed})`);

  database.run(sql`CREATE TABLE IF NOT EXISTS user_mail_preferences (
    email TEXT NOT NULL,
    mail_type TEXT NOT NULL,
    enabled INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (email, mail_type)
  )`);

  // 会员使用记录：事件流水（登录/开播/结束播放）+ 使用区间（"哪几个钟头在用"）。
  // 两张表都是应用自己攒的观察数据，不是 Emby 的业务表：Emby 重启/删会话都不会影响这里的账。
  database.run(sql`CREATE TABLE IF NOT EXISTS member_usage_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    emby_user_id TEXT,
    member_email TEXT,
    user_name TEXT,
    kind TEXT NOT NULL,
    source TEXT NOT NULL,
    external_id TEXT,
    item_id TEXT,
    item_title TEXT,
    episode_title TEXT,
    season_number INTEGER,
    episode_number INTEGER,
    device_id TEXT,
    device_name TEXT,
    client TEXT,
    app_version TEXT,
    remote_address TEXT,
    position_ticks INTEGER,
    run_time_ticks INTEGER,
    detail TEXT,
    occurred_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`);
  database.run(sql`CREATE INDEX IF NOT EXISTS member_usage_events_occurred_idx ON member_usage_events (occurred_at)`);
  database.run(
    sql`CREATE INDEX IF NOT EXISTS member_usage_events_email_idx ON member_usage_events (member_email, occurred_at)`,
  );
  database.run(
    sql`CREATE INDEX IF NOT EXISTS member_usage_events_user_idx ON member_usage_events (emby_user_id, occurred_at)`,
  );
  // 活动日志回填可反复跑：同一条 Emby 记录只落一行。
  database.run(
    sql`CREATE UNIQUE INDEX IF NOT EXISTS member_usage_events_source_external_idx ON member_usage_events (source, external_id)`,
  );

  database.run(sql`CREATE TABLE IF NOT EXISTS member_usage_segments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    emby_user_id TEXT,
    member_email TEXT,
    user_name TEXT,
    kind TEXT NOT NULL,
    item_id TEXT NOT NULL DEFAULT '',
    item_title TEXT,
    episode_title TEXT,
    season_number INTEGER,
    episode_number INTEGER,
    device_id TEXT,
    device_name TEXT,
    client TEXT,
    app_version TEXT,
    remote_address TEXT,
    play_method TEXT,
    position_ticks INTEGER,
    run_time_ticks INTEGER,
    media_source_name TEXT,
    started_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    ended_at TEXT
  )`);
  // 未封口的区间必须唯一：采样器据此"延长"而不是每次插入新行。
  database.run(
    sql`CREATE UNIQUE INDEX IF NOT EXISTS member_usage_segments_open_idx ON member_usage_segments (session_id, kind, item_id) WHERE ended_at IS NULL`,
  );
  database.run(sql`CREATE INDEX IF NOT EXISTS member_usage_segments_started_idx ON member_usage_segments (started_at)`);
  database.run(
    sql`CREATE INDEX IF NOT EXISTS member_usage_segments_email_idx ON member_usage_segments (member_email, started_at)`,
  );

  // 平台说明/规范文章。
  database.run(sql`CREATE TABLE IF NOT EXISTS content_articles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    enabled INTEGER NOT NULL DEFAULT 1,
    sort INTEGER NOT NULL DEFAULT 0,
    force_seconds INTEGER NOT NULL DEFAULT 3,
    updated_at TEXT NOT NULL
  )`);
  if (
    !database
      .all<{ name: string }>(sql`PRAGMA table_info(content_articles)`)
      .some((col) => col.name === "force_seconds")
  ) {
    database.run(sql`ALTER TABLE content_articles ADD COLUMN force_seconds INTEGER NOT NULL DEFAULT 3`);
  }
  const articles: Array<[string, string, string, number]> = [
    [
      "quickstart",
      "新手必读",
      "欢迎使用影视中心！在这里你可以：\n\n· 影视库：浏览 Emby 已入库的电影/剧集，点击即可观看；\n· 热榜：看看豆瓣 / TMDB / IMDB 的热门，以及在库可直接播放的作品；\n· 我的：续费/兑换卡密、Emby 账号与改密、邮件偏好、通知中心、平台须知。\n\n有任何操作问题，请在「我的 → 平台须知」查看详细教程。",
      1,
    ],
    [
      "emby-setup",
      "Emby 客户端配置教程",
      "一、下载客户端\n手机/电视/网页任选，搜索 Emby 官方客户端即可。\n\n二、配置账号\n1. 打开客户端 → 添加服务器；\n2. 服务器地址：{{embyServerAddress}}（局域网内可直接访问；换地址由管理员在「系统设置」里改，此处自动同步）；\n3. 账号：你的邮箱；\n4. 密码：开通时设置的 Emby 密码（忘记可在「我的 → 修改密码」随时重设）。\n\n三、播放规则\n· 每个账号同时在线播放：1 台设备；\n· 强行多设备同时播放将被中断，多次违规可能临时封停 12 小时；\n· 如需同时多设备，请提前联系管理员。\n\n四、常见问题\n· 连接失败：确认域名可访问、网络正常；仍不行联系管理员；\n· 修改密码后：用新密码重新登录即可；\n· 最多同时播放：按会员上限（默认 1 路）。",
      2,
    ],
    [
      "rules",
      "平台使用规范",
      "一、账号使用\n· 每个账号同时在线播放仅限 1 台设备；\n· 强行多设备同时播放会被中断，多次违规将被临时封停 12 小时；\n· 如需同时多设备，请提前说明，特殊情况可另行开通。\n\n二、内容来源\n· 平台内容以 Emby 媒体库为准，本站只做展示与播放入口；\n· 需要补充影片请联系管理员，由管理员按流程处理。\n\n三、会员要求\n· 会员邮箱即登录账号，请勿转借他人；\n· 会员到期后播放与浏览权限会暂停，续费请用卡密兑换。\n\n四、内容合规\n· 请勿上传/请求违法违规内容；平台仅作技术分享，请尊重版权、支持正版。",
      3,
    ],
    [
      "disclaimer",
      "免责声明",
      "1. 本站为个人技术交流与学习用途，不存储、不传播任何侵权内容；\n2. 平台内影片信息由公开来源整理，版权归原权利方所有；\n3. 如涉及侵权或内容不妥，请及时告知我们，我们将在核实后第一时间整改/下架（可在站内或向管理员反馈）；\n4. 请用户遵守当地法律法规，理性使用；因使用本平台产生的任何问题，本平台不承担连带责任；\n5. 本声明内容如有调整，以最新版本为准；继续使用即视为同意本声明。",
      4,
    ],
    [
      "announcement",
      "平台公告",
      "📌 重要提醒\n· 每个账号同时在线播放仅限【1 台设备】；\n· 强行多设备同时播放将被中断，多次违规将被临时封停【12 小时】；\n· 如需同时多设备，请提前联系管理员。\n\n📺 如何配置账号\n1. 账号 = 你的登录邮箱（提示：开通账号时填写的那个）；\n2. 密码 = 你设置的 Emby 密码（忘记可在「我的 → 修改密码」随时重设）；\n3. 服务器地址：见「我的 → Emby 账号」显示的地址（端口 443，HTTPS 默认）；\n4. 打开 Emby 客户端 → 添加服务器 → 填入以上三项即可观看。\n\n🍿 功能速览\n· 影视库：浏览/搜索已入库影片，点击即看；\n· 热榜：豆瓣 / TMDB / IMDB 热门，标注「可看」的已在库；\n· 我的：续费兑换卡密 / Emby 账号 / 邮件偏好 / 通知中心 / 平台须知。\n\n📄 免责声明（摘要）\n· 本站为个人技术交流与学习用途，不存储、不传播任何侵权内容；\n· 影片信息由公开来源整理，版权归原权利方所有；\n· 如涉及侵权或不妥内容，请及时告知我们，核实后第一时间整改/下架；\n· 请遵守当地法律法规，理性使用；继续使用即视为同意本声明。\n\n（完整版见「我的 → 平台须知」）",
      0,
    ],
  ];
  for (const [code, title, content, sort] of articles) {
    database.run(sql`INSERT OR IGNORE INTO content_articles (code, title, content, enabled, sort, updated_at)
      VALUES (${code}, ${title}, ${content}, 1, ${sort}, ${providerSeed})`);
  }
  // 旧默认地址转为动态占位符；只匹配已知旧值，不更改其他部署的文章地址。
  reconcileLegacyArticleAddresses(database, providerSeed);

  // 会员改走局域网地址后，"（端口 443，HTTPS 默认）"这句不再成立（局域网是 http + 自定义端口）。
  database.run(sql`UPDATE content_articles
    SET content = REPLACE(content, '{{embyServerAddress}}（端口 443，HTTPS 默认）',
                                 '{{embyServerAddress}}（局域网内可直接访问）'),
        updated_at = ${providerSeed}
    WHERE content LIKE '%{{embyServerAddress}}（端口 443，HTTPS 默认）%'`);

  // 投稿功能删除后，把仍是"旧种子文案"的文章刷新一遍：只认旧文案里的特征串，
  // 管理员自己改过的内容不会被覆盖（特征串不匹配就不动）。
  const legacyArticleMarkers: Array<[string, string]> = [
    ["quickstart", "%· 投稿求片：提交想看的电影%"],
    ["rules", "%二、投稿范围%"],
    ["announcement", "%· 投稿：想看新片/完结剧集%"],
  ];
  for (const [code, marker] of legacyArticleMarkers) {
    const seeded = articles.find((item) => item[0] === code);
    if (!seeded) continue;
    database.run(sql`UPDATE content_articles SET content = ${seeded[2]}, updated_at = ${providerSeed}
      WHERE code = ${code} AND content LIKE ${marker}`);
  }

  // 自动签到（Telegram 签到子系统）已于 2026-09 整体下线：执行引擎、接口、设置项、界面与
  // 这两张表（checkin_tasks / checkin_runs）一起删除。代码里已经没有任何地方读它们，
  // 留着只会让 schema.ts 与库结构对不上；所以这里把老库里遗留的表连同数据一并清掉。
  // 先删流水再删任务（流水有指向任务的外键）。
  database.run(sql`DROP TABLE IF EXISTS checkin_runs`);
  database.run(sql`DROP TABLE IF EXISTS checkin_tasks`);

  // 自定义卡密：名称 / 固定到期日 / 到期时间名称 / 彩蛋祝福文案（见 docs/card-keys.md）。
  // 四列全部可空——老卡读出来就是 NULL，等价于"没有名称、走 base+days、不弹窗"，行为一行不变。
  const cardCols = database.all<{ name: string }>(sql`PRAGMA table_info(card_keys)`);
  if (cardCols.length > 0) {
    if (!cardCols.some((column) => column.name === "name")) {
      database.run(sql`ALTER TABLE card_keys ADD COLUMN name TEXT`);
    }
    if (!cardCols.some((column) => column.name === "expires_at")) {
      database.run(sql`ALTER TABLE card_keys ADD COLUMN expires_at TEXT`);
    }
    if (!cardCols.some((column) => column.name === "expiry_label")) {
      database.run(sql`ALTER TABLE card_keys ADD COLUMN expiry_label TEXT`);
    }
    if (!cardCols.some((column) => column.name === "blessing")) {
      database.run(sql`ALTER TABLE card_keys ADD COLUMN blessing TEXT`);
    }
  }

  // 会员当前有效期的「到期时间名称」：开通时由带 expiry_label 的卡写进来，用户侧所有页面
  // 优先显示它。冗余在会员行上是刻意的——卡密会被删，反查当场失效（详见设计文档第 5 节）。
  const memberCols = database.all<{ name: string }>(sql`PRAGMA table_info(submission_users)`);
  if (memberCols.length > 0 && !memberCols.some((column) => column.name === "membership_expiry_label")) {
    database.run(sql`ALTER TABLE submission_users ADD COLUMN membership_expiry_label TEXT`);
  }
}
