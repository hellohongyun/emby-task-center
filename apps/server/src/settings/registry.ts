/**
 * 应用设置注册表（P1 配置后台化的单一真源）。
 *
 * 约定：
 *  - 这里集中定义每个配置项的类型、默认值、是否密钥、所属分组与帮助文案；
 *    后台配置页的表单/校验/分组由它生成，前后端不再各写一套。
 *  - 业务代码只允许通过 `settings/store.ts` 读写，禁止再直接读 `env.XXX`
 *    （bootstrap 白名单：PORT / DATABASE_PATH / MIGRATIONS_PATH / WEB_DIST_PATH / TZ
 *     以及 compose 层的 APP_BIND_ADDRESS / APP_PORT / DATA_PATH / STRM_PATH）。
 *  - `env` 字段声明「首次启动时从哪个环境变量导入」，用于存量部署无感升级：
 *    DB 里一旦有值就以 DB 为准，env 只在键缺失时作为种子。
 *  - 密钥（secret: true）只影响展示与日志：存库为明文（与 .env 同一个信任边界），
 *    接口一律回掩码，日志需脱敏（2026-09-10 用户决策）。
 */
import { z } from "zod";
import { VIRTUAL_PROXY_SETTINGS } from "../virtual-libraries/proxy-setting-definitions";

import { ALL_PLATFORMS, DEFAULT_ENABLED_PLATFORMS, PLATFORM_META } from "../pansou/pansou-filter";
import { DEFAULT_PANSOU_BASE_URL, DEFAULT_PANSOU_SEARCH_SRC, DEFAULT_PANSOU_TIMEOUT_MS } from "../pansou/pansou-client";

export type SettingGroup =
  | "admin"
  | "session"
  | "security"
  | "concurrency"
  | "member"
  | "tmdb"
  | "emby"
  | "email"
  | "pansou"
  | "tgto"
  | "library"
  | "tasks"
  | "usage"
  | "logs"
  | "ai"
  | "cache";

export const SETTING_GROUP_LABELS: Record<SettingGroup, string> = {
  admin: "管理员",
  session: "会话",
  security: "登录安全",
  concurrency: "并发策略",
  member: "会员",
  tmdb: "TMDB",
  emby: "Emby",
  email: "邮件通知",
  pansou: "PanSou 聚合搜索",
  tgto: "TgtoDrive",
  library: "媒体库",
  tasks: "任务",
  usage: "会员使用记录",
  logs: "日志",
  ai: "AI 文案",
  cache: "缓存",
};

/** 枚举/多选型设置的候选项（后台配置页据此渲染开关，而不是让用户手写逗号分隔字符串）。 */
export interface SettingChoice {
  value: string;
  label: string;
  help?: string;
}

export interface SettingDefinition {
  group: SettingGroup;
  label: string;
  help?: string;
  /** 候选项：数组型渲染为多选开关，字符串型渲染为下拉。 */
  choices?: ReadonlyArray<SettingChoice>;
  schema: z.ZodType;
  /** 密钥：接口只回掩码，日志必须脱敏。 */
  secret?: boolean;
  /**
   * 不在「系统设置 → 配置项」表单里出现：这些键由专属面板维护（见 ConcurrencyPolicyPanel），
   * 同一条设置只允许有一个入口，避免两处都能改、互相覆盖。
   * 仍然照常读写、参与 PATCH 校验，只是不展示。
   */
  hidden?: boolean;
  /** 多行长文本（邮件正文、会员端提示文案）：配置页渲染成 textarea，而不是一行 input。 */
  multiline?: boolean;
  /** 首次启动（DB 无值）时从该 env 变量导入。 */
  env?: string;
  /** env 原始字符串 → schema 输入的解码（CSV 等非 JSON 形态）。缺省时按 JSON 解析，失败则按字符串。 */
  parseEnv?: (raw: string) => unknown;
}

/** 布尔解析：兼容 true/false、1/0、yes/no、on/off，避免 z.coerce.boolean 把 "false" 判成 true。 */
function booleanSetting(defaultValue: boolean) {
  return z
    .union([z.boolean(), z.string()])
    .transform((value) => {
      if (typeof value === "boolean") return value;
      const normalized = value.trim().toLowerCase();
      if (["1", "true", "yes", "on"].includes(normalized)) return true;
      if (["0", "false", "no", "off", ""].includes(normalized)) return false;
      throw new Error(`无法解析为布尔值：${value}`);
    })
    .default(defaultValue);
}

function integerSetting(defaultValue: number, options: { min?: number; max?: number } = {}) {
  let schema = z.coerce.number().int();
  if (options.min !== undefined) schema = schema.min(options.min);
  if (options.max !== undefined) schema = schema.max(options.max);
  return schema.default(defaultValue);
}

/**
 * 卡密彩蛋的「AI 帮写祝福文案」默认系统提示词（后台可整段替换）。
 *
 * 可用占位符（由 integrations/ai-text-client.ts 渲染）：`{{occasion}}`（场景，如「国庆节卡密」）
 * `{{length}}`（期望字数）。提示词里刻意写死"只输出文案本身"——否则模型很爱加解释与引号，
 * 管理员还得手动删，那就不叫"帮写"了。
 */
export const DEFAULT_AI_SYSTEM_PROMPT = [
  "你是影音会员站点的运营文案写手，负责为「卡密」写兑换成功后的祝福语。",
  "风格：热情、有节日氛围、不油腻、不像广告，最多两句。",
  "场景提示：{{occasion}}",
  "要求：",
  "1. 只输出祝福文案本身，不要引号、不要解释、不要标题、不要 emoji 堆砌（最多一个）。",
  "2. 全文不超过 {{length}} 字。",
  "3. 不要承诺任何具体权益（时长、画质、片源），避免与实际不符。",
].join("\n");

/**
 * 会员自助解冻的默认文案（后台可在「并发超限升级」面板改）。
 *
 * 可用占位符（由 subscriptions/self-unfreeze.ts 渲染）：
 * `{{email}}` `{{unfreezeAt}}` `{{remaining}}` `{{maxStreams}}` `{{monthlyLimit}}`
 * `{{usedThisMonth}}` `{{remainingChances}}`（本月还剩几次，不扣本次）
 * `{{remainingAfterThis}}`（本次解冻后还剩几次）`{{platformUrl}}`
 */
export const DEFAULT_UNFREEZE_TITLE = "申请提前解冻";

/** 弹窗正文默认文案：先讲清"为什么被冻"，再讲"等多久、点哪里"，最后讲清次数口径。 */
export const DEFAULT_UNFREEZE_NOTICE = [
  "你的账号因同时在多台设备播放，超过了系统允许的同时播放上限，已被临时冻结。",
  "",
  "・原定解冻时间：{{unfreezeAt}}（还剩 {{remaining}}）",
  "・同时播放上限：{{maxStreams}} 路",
  "・自助解冻次数：每月上限 {{monthlyLimit}} 次，已用 {{usedThisMonth}} 次，本次解冻后还剩 {{remainingAfterThis}} 次",
  "",
  "请先关闭多余的播放设备，再等倒计时结束点击「确认解冻」。解冻后账号立即恢复，可以用原账号重新登录播放；若再次多设备同时播放，账号会被再次冻结。",
].join("\n");

/**
 * 会员开通（注册成功）那封 Emby 账号邮件的默认主题与正文（后台可在「系统设置 → 会员」改）。
 *
 * 可用占位符（由 subscriptions/member-notices.ts 渲染）：
 * `{{email}}` `{{serverAddress}}` `{{username}}` `{{password}}` `{{maxStreams}}`
 * `{{streamLimitNote}}` `{{platformUrl}}`
 */
export const DEFAULT_WELCOME_EMAIL_SUBJECT = "[天鸿影院] 你的 Emby 账号已开通";

/** 开通邮件正文默认文案：登录信息 + 登录教程 + 并发口径（正文里不写死地址与路数）。 */
export const DEFAULT_WELCOME_EMAIL_BODY = [
  "你的 Emby 账号已开通，现在可以开始观影了。",
  "",
  "【登录信息】",
  "服务器地址：{{serverAddress}}",
  "用户名：{{username}}",
  "初始密码：{{password}}",
  "",
  "【如何登录与观看】",
  "1. 打开 Emby 客户端：网页端、手机 App、电视/盒子或播放器（如 Emby、Infuse 等）均可。",
  "2. 首次打开点「添加服务器 / 手动添加」，服务器地址填上面的地址。",
  "3. 用上面的「用户名 + 密码」登录，即可看到影片库。",
  "4. 建议首次登录后在「用户设置」里修改成自己的密码。",
  "",
  "【温馨提示】{{streamLimitNote}}",
  "如无法登录或地址错误，请联系管理员为你核对。",
  "",
  "—— 天鸿影院",
].join("\n");

/**
 * 注册/开通成功后，门户「我的」页上那块 Emby 配置提示的默认标题与正文（后台可改）。
 *
 * 与开通邮件同一套占位符与渲染路径，所以页面上看到的口径与邮件永远一致。
 */
export const DEFAULT_EMBY_ONBOARD_TITLE = "🎉 Emby 账号已开通";

export const DEFAULT_EMBY_ONBOARD_NOTICE = [
  "你的 Emby 账号已开通，用下面的信息登录即可观看：",
  "",
  "服务器地址：{{serverAddress}}",
  "用户名：{{username}}",
  "初始密码：{{password}}",
  "",
  "首次登录后建议在 Emby「用户设置」里改成自己的密码；忘记密码可在本页「我的 Emby 账号」里随时重设。",
  "同一账号同时最多允许 {{maxStreams}} 路播放，多设备同时播放会被系统临时冻结。",
].join("\n");

export const SETTINGS = {
  ...VIRTUAL_PROXY_SETTINGS,
  /* ---------------------------------------------------------------- 管理员 */
  "admin.username": {
    group: "admin",
    label: "管理员用户名",
    schema: z.string().min(1).max(64).default("admin"),
    env: "ADMIN_USERNAME",
  },
  "admin.passwordHash": {
    group: "admin",
    label: "管理员口令",
    help: "首次启动写入默认口令，登录后可在本页修改；接口只回显掩码。",
    schema: z.string().default(""),
    secret: true,
  },
  "admin.mustChangePassword": {
    group: "admin",
    label: "仍需修改默认口令",
    help: "仍在使用初始化默认口令时为真，后台页会显示提醒。",
    schema: booleanSetting(true),
  },

  /* ------------------------------------------------------------------ 会话 */
  "session.secret": {
    group: "session",
    label: "会话签名密钥",
    help: "首次启动自动随机生成并落库；不需要人工填写。",
    schema: z.string().default(""),
    secret: true,
  },
  "session.validityDays": {
    group: "session",
    label: "会话有效期（天）",
    schema: integerSetting(90, { min: 1, max: 3650 }),
    env: "SESSION_VALIDITY_DAYS",
  },

  /* -------------------------------------------------------------- 登录安全 */
  "security.maxFailedAttempts": {
    group: "security",
    label: "登录失败锁定阈值（次）",
    schema: integerSetting(1, { min: 1, max: 100 }),
    env: "AUTH_MAX_FAILED_ATTEMPTS",
  },
  "security.lockoutBaseSeconds": {
    group: "security",
    label: "锁定时长基数（秒，按次方递增）",
    schema: integerSetting(60, { min: 1, max: 86_400 }),
    env: "AUTH_LOCKOUT_BASE_SECONDS",
  },
  "security.lockoutMinutes": {
    group: "security",
    label: "固定锁定时长（分钟，留空则使用指数递增）",
    schema: z.coerce.number().int().positive().nullable().default(null),
    env: "AUTH_LOCKOUT_MINUTES",
  },

  /* ------------------------------------------------------------------ 会员 */
  "member.autoLinkDays": {
    group: "member",
    label: "Emby 账号自动绑定默认天数",
    help: "Emby 里还没绑定会员的账号会被自动收编成会员（用户名即邮箱，验证码登录）；这里是从绑定那一刻起算的有效天数，到期后按普通会员一样自动停用 Emby 账号。",
    schema: integerSetting(15, { min: 1, max: 3_650 }),
  },
  // 注册/开通环节的对外文案与默认上限：以前写死在代码里，管理员改不了（邮件、门户「我的」提示都在这里配）。
  "member.newMemberMaxStreams": {
    group: "member",
    label: "新注册会员默认并发上限",
    help: "首次开卡注册的会员，开通时自动登记这个并发上限并同步到 Emby（SimultaneousStreamLimit）；开通后可在「会员与运营」里单独调整。",
    schema: integerSetting(1, { min: 1, max: 20 }),
  },
  "member.welcomeEmailSubject": {
    group: "member",
    label: "开通邮件主题",
    help: "注册/开通成功后那封 Emby 账号邮件的主题；留空回落默认主题。",
    schema: z.string().max(200).default(DEFAULT_WELCOME_EMAIL_SUBJECT),
  },
  "member.welcomeEmailBody": {
    group: "member",
    label: "开通邮件正文",
    help: "支持占位符 {{email}} {{serverAddress}} {{username}} {{password}} {{maxStreams}} {{streamLimitNote}} {{platformUrl}}；留空回落默认文案。",
    schema: z.string().max(8_000).default(DEFAULT_WELCOME_EMAIL_BODY),
    multiline: true,
  },
  "member.embyOnboardTitle": {
    group: "member",
    label: "「我的」页开通提示标题",
    help: "注册/开通成功后门户「我的」页顶部那块提示的标题；留空回落默认标题。",
    schema: z.string().max(120).default(DEFAULT_EMBY_ONBOARD_TITLE),
  },
  "member.embyOnboardNotice": {
    group: "member",
    label: "「我的」页开通提示正文",
    help: "与开通邮件同一套占位符 {{email}} {{serverAddress}} {{username}} {{password}} {{maxStreams}} {{streamLimitNote}} {{platformUrl}}；留空回落默认文案。",
    schema: z.string().max(4_000).default(DEFAULT_EMBY_ONBOARD_NOTICE),
    multiline: true,
  },

  /* ------------------------------------------------------------------ TMDB */
  "tmdb.token": {
    group: "tmdb",
    label: "TMDB 凭据",
    help: "接受 32 位 v3 API Key 或 v4 Read Access Token；只由服务端使用。",
    schema: z.string().default(""),
    secret: true,
    env: "TMDB_TOKEN",
  },

  /* ------------------------------------------------------------------ Emby */
  "emby.enabled": {
    group: "emby",
    label: "启用 Emby 相关后台任务",
    schema: booleanSetting(true),
    env: "EMBY_ENABLED",
  },
  "emby.baseUrl": {
    group: "emby",
    label: "Emby 地址",
    help: "用于去重、入库确认与「去观看」链接。",
    schema: z.string().default(""),
    env: "EMBY_BASE_URL",
  },
  "emby.apiKey": {
    group: "emby",
    label: "Emby API Key",
    schema: z.string().default(""),
    secret: true,
    env: "EMBY_API_KEY",
  },
  "emby.webUrl": {
    group: "emby",
    label: "Emby 网页地址（浏览器访问用）",
    help: "缺集总览的「在 Emby 查看」用它拼跳转链接；请填写客户端可访问的 Emby 网页地址，留空时回退至 Emby 地址。",
    schema: z.string().default(""),
    env: "EMBY_WEB_URL",
  },
  /* ------------------------------------------------------------- 邮件通知 */
  "email.host": { group: "email", label: "SMTP 服务器", schema: z.string().default(""), env: "SMTP_HOST" },
  "email.port": {
    group: "email",
    label: "SMTP 端口",
    schema: integerSetting(587, { min: 1, max: 65_535 }),
    env: "SMTP_PORT",
  },
  "email.secure": {
    group: "email",
    label: "使用 TLS（465 隐式加密）",
    schema: booleanSetting(false),
    env: "SMTP_SECURE",
  },
  "email.username": { group: "email", label: "SMTP 用户名", schema: z.string().default(""), env: "SMTP_USERNAME" },
  "email.password": {
    group: "email",
    label: "SMTP 密码",
    schema: z.string().default(""),
    secret: true,
    env: "SMTP_PASSWORD",
  },
  "email.fromName": {
    group: "email",
    label: "发件人名称",
    schema: z.string().default("Media Task Center"),
    env: "SMTP_FROM_NAME",
  },
  "email.fromAddress": {
    group: "email",
    label: "发件人地址",
    schema: z.string().default(""),
    env: "SMTP_FROM_ADDRESS",
  },

  /* ----------------------------------------------------------------- PanSou */
  "pansou.baseUrl": {
    group: "pansou",
    label: "PanSou 地址",
    help: "填写你部署或有权使用的 PanSou 服务地址；未配置时不发起搜索请求。",
    schema: z.string().default(DEFAULT_PANSOU_BASE_URL),
    env: "PANSOU_BASE_URL",
  },
  "pansou.searchSrc": {
    group: "pansou",
    label: "搜索源",
    schema: z.string().default(DEFAULT_PANSOU_SEARCH_SRC),
    env: "PANSOU_SEARCH_SRC",
  },
  "pansou.enabledPlatforms": {
    group: "pansou",
    label: "启用的网盘/磁力",
    help: "未启用的平台不出现在筛选、不参与返回。这里是唯一真源：旧的平台开关表已在启动时一次性导入（导入后不再读取）。",
    choices: ALL_PLATFORMS.map((platform) => ({
      value: platform,
      label: PLATFORM_META[platform].name,
      help: PLATFORM_META[platform].displayType,
    })),
    schema: z.array(z.string()).default([...DEFAULT_ENABLED_PLATFORMS]),
    env: "PANSOU_ENABLED_PLATFORMS",
    parseEnv: (raw) =>
      raw
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
  },
  "pansou.timeoutMs": {
    group: "pansou",
    label: "请求超时（毫秒）",
    schema: integerSetting(DEFAULT_PANSOU_TIMEOUT_MS, { min: 1_000, max: 300_000 }),
    env: "PANSOU_TIMEOUT_MS",
  },

  /* --------------------------------------------------------------- TgtoDrive */
  "tgto.baseUrl": {
    group: "tgto",
    label: "TgtoDrive 地址",
    schema: z.string().default(""),
    env: "TGTO_DRIVE_BASE_URL",
  },
  "tgto.username": {
    group: "tgto",
    label: "TgtoDrive 用户名",
    schema: z.string().default(""),
    env: "TGTO_DRIVE_USERNAME",
  },
  "tgto.password": {
    group: "tgto",
    label: "TgtoDrive 密码",
    schema: z.string().default(""),
    secret: true,
    env: "TGTO_DRIVE_PASSWORD",
  },
  // tgto.botUsername / tgto.ingestSource / tgto.ingestDryRun 与整个 telegram 组
  // 都是"确认资源 → 机器人转存"链路的配置，该链路删除后一并不需要了。

  /* ----------------------------------------------------------------- 媒体库 */
  // 库存来源已固定为 Emby（媒体库只此一条路径），原来的 library.backend 开关随之删除。
  "library.scanMode": {
    group: "library",
    label: "扫描调度",
    help: "adaptive=仅缺集时按间隔扫描；fixed=始终按间隔扫描。",
    schema: z.enum(["adaptive", "fixed"]).default("adaptive"),
    env: "LIBRARY_SCAN_MODE",
  },
  "library.scanIntervalMinutes": {
    group: "library",
    label: "扫描间隔（分钟，0=关闭周期扫描）",
    schema: integerSetting(30, { min: 0, max: 10_080 }),
    env: "LIBRARY_SCAN_INTERVAL_MINUTES",
  },
  "library.idleScanIntervalMinutes": {
    group: "library",
    label: "全部同步时的兜底扫描间隔（分钟）",
    schema: integerSetting(60, { min: 0, max: 10_080 }),
    env: "LIBRARY_IDLE_SCAN_INTERVAL_MINUTES",
  },
  "library.airProgressRefreshMinutes": {
    group: "library",
    label: "已播进度刷新间隔（分钟，0=关闭）",
    schema: integerSetting(10, { min: 0, max: 10_080 }),
    env: "AIR_PROGRESS_REFRESH_INTERVAL_MINUTES",
  },
  "library.missingEpisodeScanIntervalMinutes": {
    group: "library",
    label: "全库缺集检测间隔（分钟，0=关闭）",
    help: "按 TMDB 已播与库内已存逐集比对，结果写入「缺集总览」；TMDB 分集列表在服务端缓存 12 小时。",
    schema: integerSetting(60, { min: 0, max: 10_080 }),
    env: "MISSING_EPISODE_SCAN_INTERVAL_MINUTES",
  },
  "library.missingGraceHours": {
    group: "library",
    label: "今日更新入库宽限（小时，0=当天就算缺集）",
    help:
      "某集在 TMDB 的播出日当天 00:00 起、宽限期内不算缺集，只标「今日更新」；默认 24 小时（次日 0 点起算）。" +
      "用来避开「当天 18 点更新、20 点才入库」在白天被误报成缺集；过了宽限期仍未入库就照常算缺集。",
    schema: integerSetting(24, { min: 0, max: 72 }),
    env: "MISSING_GRACE_HOURS",
  },

  /* ------------------------------------------------------------------- 任务 */
  "tasks.movieRetentionHours": {
    group: "tasks",
    label: "已入库任务保留（小时，0=不自动清理）",
    schema: integerSetting(24, { min: 0, max: 8_760 }),
    env: "MOVIE_TASK_RETENTION_HOURS",
  },

  /* ------------------------------------------------------- 会员使用记录 */
  // 使用记录 = 应用自己采样 Emby 会话攒出来的登录/播放/时段台账（见 apps/server/src/usage/）。
  "usage.sampleSeconds": {
    group: "usage",
    label: "会话采样间隔（秒）",
    help: "每隔多久看一眼 Emby 谁在播什么。越小越准、越费一点 Emby 的接口；改完需重启进程生效。",
    schema: integerSetting(30, { min: 10, max: 600 }),
    env: "USAGE_SAMPLE_SECONDS",
  },
  "usage.retentionDays": {
    group: "usage",
    label: "使用记录保留天数",
    help: "超期的事件与已结束的使用区间会被清理（正在进行的区间不删）。改完需重启进程生效。",
    schema: integerSetting(180, { min: 7, max: 3_650 }),
    env: "USAGE_RETENTION_DAYS",
  },

  /* ------------------------------------------------------------------- 日志 */
  "logs.retentionDays": {
    group: "logs",
    label: "日志保留天数",
    schema: integerSetting(7, { min: 1, max: 3_650 }),
    env: "LOG_RETENTION_DAYS",
  },
  "logs.maxRows": {
    group: "logs",
    label: "日志最大行数",
    schema: integerSetting(5_000, { min: 100, max: 10_000_000 }),
    env: "LOG_MAX_ROWS",
  },

  /* --------------------------------------------------------------- 并发策略 */
  // P1.4：从 concurrency_policy_settings 表收编（迁移见 settings/legacy-migration.ts）。
  // 以下并发策略全部由「并发超限升级」面板维护（hidden = 不进配置项表单，避免同一条设置两处入口）。
  "concurrencyPolicy.enabled": {
    group: "concurrency",
    label: "启用并发超限处置",
    schema: booleanSetting(true),
    hidden: true,
  },
  "concurrencyPolicy.remindAfterMinutes": {
    group: "concurrency",
    label: "累计超限多少分钟后发提醒（0 = 不提醒，到点直接冻结）",
    schema: integerSetting(2, { min: 0, max: 1_440 }),
    hidden: true,
  },
  "concurrencyPolicy.disableAfterMinutes": {
    group: "concurrency",
    label: "累计超限多少分钟后冻结账号",
    schema: integerSetting(5, { min: 1, max: 1_440 }),
    hidden: true,
  },
  "concurrencyPolicy.disableForHours": {
    group: "concurrency",
    label: "冻结时长（小时，到期自动恢复）",
    schema: integerSetting(1, { min: 1, max: 720 }),
    hidden: true,
  },
  "concurrencyPolicy.adminEmail": {
    group: "concurrency",
    label: "管理员抄送邮箱（可选）",
    schema: z.string().default(""),
    hidden: true,
  },
  "concurrencyPolicy.interruptStreams": {
    group: "concurrency",
    label: "超限直接中断多出来的播放",
    help: "开启后，同一账号的第二路播放会被真的停掉（先到先得，保留看得更久的那台）；关闭则只拦截新播放。",
    schema: booleanSetting(true),
    hidden: true,
  },
  "concurrencyPolicy.defaultStreamLimit": {
    group: "concurrency",
    label: "未登记会员的默认并发路数",
    help: "会员与运营里单独登记的会员以登记值为准；Emby 管理员账号不受此限制。0 = 不限。",
    schema: integerSetting(1, { min: 0, max: 20 }),
    hidden: true,
  },
  // 会员自助解冻（冻结邮件里告诉会员"可以登录平台自己解冻"）。
  "concurrencyPolicy.unfreezeEnabled": {
    group: "concurrency",
    label: "允许会员自助解冻",
    help: "关闭后：冻结邮件不再提自助解冻，门户「我的」也不显示解冻按钮，只能等冻结到期或管理员手动恢复。",
    schema: booleanSetting(true),
    hidden: true,
  },
  "concurrencyPolicy.unfreezeMonthlyLimit": {
    group: "concurrency",
    label: "会员每月自助解冻次数上限（0 = 不允许）",
    help: "按自然月统计（服务器本地时区）；每次成功自助解冻记一次，冻结到期自动恢复不占次数。",
    schema: integerSetting(2, { min: 0, max: 10 }),
    hidden: true,
  },
  "concurrencyPolicy.unfreezeWaitSeconds": {
    group: "concurrency",
    label: "自助解冻强制等待秒数",
    help: "点开解冻弹窗后必须读完提示并等满这么久才能点「确认解冻」。服务端同样按这个秒数校验，改接口绕不过去。",
    schema: integerSetting(60, { min: 0, max: 600 }),
    hidden: true,
  },
  "concurrencyPolicy.unfreezeTitle": {
    group: "concurrency",
    label: "自助解冻弹窗标题",
    schema: z.string().max(120).default(DEFAULT_UNFREEZE_TITLE),
    hidden: true,
  },
  "concurrencyPolicy.unfreezeNotice": {
    group: "concurrency",
    label: "自助解冻弹窗正文",
    help: "支持占位符 {{email}} {{unfreezeAt}} {{remaining}} {{maxStreams}} {{monthlyLimit}} {{usedThisMonth}} {{remainingChances}}（本月还剩，不扣本次）{{remainingAfterThis}}（本次解冻后还剩）{{platformUrl}}。",
    schema: z.string().max(4_000).default(DEFAULT_UNFREEZE_NOTICE),
    hidden: true,
  },
  "concurrencyPolicy.portalUrl": {
    group: "concurrency",
    label: "平台地址（会员门户，用于冻结邮件里的登录链接）",
    help: "会员登录平台自助解冻的入口地址，例如 https://movie.example.com。留空则邮件里只写「登录平台」不给链接。",
    schema: z.string().max(300).default(""),
    hidden: true,
  },

  /* -------------------------------------------------------------- 邮件默认开关 */
  // P1.4：从 mail_default_settings 表收编（管理员全局默认；用户可按类型覆盖）。
  // 「默认发送：任务更新」（mail.taskUpdate）随任务更新通知整条链下线（2026-09）：
  // 那条链已经没有发送方，留着这个键只会让后台配一个不起作用的默认值。旧行由
  // legacy-migration 的 RETIRED_SETTING_KEYS 清掉。
  "mail.membershipReminder": { group: "email", label: "默认发送：会员临期/到期", schema: booleanSetting(true) },

  /* ------------------------------------------------------------------ AI 文案 */
  // 卡密彩蛋的「AI 帮写祝福文案」：走 OpenAI 兼容协议（/chat/completions），
  // 默认预设 DeepSeek。密钥只由服务端使用，接口一律回掩码（secret 约定）。
  // 全链路只用这一个出站调用，且**只在管理员点「AI 帮写」时触发**——不在用户侧调用，
  // 所以 Key 泄漏面与费用面都被限制在后台。
  "ai.enabled": {
    group: "ai",
    label: "启用 AI 文案",
    help: "关掉后「AI 帮写」按钮直接提示去配置，不会发出任何外部请求。",
    schema: booleanSetting(false),
  },
  "ai.baseUrl": {
    group: "ai",
    label: "接口地址（OpenAI 兼容）",
    help: "如 https://api.deepseek.com/v1 、https://api.openai.com/v1 ，或任意自建/中转的兼容地址。",
    schema: z.string().max(300).default("https://api.deepseek.com/v1"),
  },
  "ai.apiKey": {
    group: "ai",
    label: "API Key",
    help: "只由服务端使用，不下发到前端，日志里自动脱敏。",
    schema: z.string().max(300).default(""),
    secret: true,
  },
  "ai.model": {
    group: "ai",
    label: "模型",
    help: "如 deepseek-chat 、gpt-4o-mini ，或自建服务暴露的模型名。",
    schema: z.string().max(120).default("deepseek-chat"),
  },
  "ai.timeoutMs": {
    group: "ai",
    label: "请求超时（毫秒）",
    help: "生成文案是交互式操作，超时太短会经常失败；建议 10000-30000。",
    schema: integerSetting(20_000, { min: 1_000, max: 120_000 }),
  },
  "ai.temperature": {
    group: "ai",
    label: "发散度（0-2）",
    help: "偏低更稳妥，偏高更有花样。祝福语建议 0.8-1.2。",
    schema: z.coerce.number().min(0).max(2).default(1),
  },
  "ai.systemPrompt": {
    group: "ai",
    label: "系统提示词",
    help: "决定 AI 写出来的文案风格；后台可整段替换。支持占位符 {{occasion}}（场景，如「国庆节卡密」）与 {{length}}（期望字数）。",
    schema: z.string().max(4_000).default(DEFAULT_AI_SYSTEM_PROMPT),
    multiline: true,
  },

  /* ------------------------------------------------------------------- 缓存 */
  "cache.redisUrl": {
    group: "cache",
    label: "Redis 地址",
    help: "留空则用内存 + SQLite 快照兜底。",
    schema: z.string().default(""),
    env: "REDIS_URL",
  },
} satisfies Record<string, SettingDefinition>;

export type SettingKey = keyof typeof SETTINGS;
export type SettingsSnapshot = { [K in SettingKey]: z.output<(typeof SETTINGS)[K]["schema"]> };

export const SETTING_KEYS = Object.keys(SETTINGS) as SettingKey[];

export function isSettingKey(value: string): value is SettingKey {
  return Object.prototype.hasOwnProperty.call(SETTINGS, value);
}

/** 密钥键名集合：日志脱敏与接口掩码共用。 */
export const SECRET_SETTING_KEYS: ReadonlySet<SettingKey> = new Set(
  SETTING_KEYS.filter((key) => {
    const definition: SettingDefinition = SETTINGS[key];
    return definition.secret === true;
  }),
);

/** 分组顺序（后台页按此顺序渲染）。 */
export const SETTING_GROUP_ORDER: SettingGroup[] = [
  "admin",
  "session",
  "security",
  "concurrency",
  "member",
  "tmdb",
  "emby",
  "email",
  "pansou",
  "tgto",
  "library",
  "tasks",
  "usage",
  "logs",
  "ai",
  "cache",
];

/**
 * 以统一类型取设置定义。
 * 注意：`satisfies` 会保留每个键的字面量类型，直接 `SETTINGS[key]` 得到的是联合类型，
 * 访问可选字段（env/secret/help）会因"部分成员没有该字段"而报错，故统一走这里。
 */
export function settingDefinition(key: SettingKey): SettingDefinition {
  return SETTINGS[key];
}

/** 取某键的默认值（schema 必须带 default；缺失时抛错以便测试兜住）。 */
export function defaultSettingValue(key: SettingKey): unknown {
  const definition: SettingDefinition = SETTINGS[key];
  const parsed = definition.schema.safeParse(undefined);
  if (!parsed.success) throw new Error(`设置项 ${key} 缺少默认值`);
  return parsed.data;
}
