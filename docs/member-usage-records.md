# 会员使用记录（登录 / 播放 / 使用时段）

管理端「会员与运营 → 使用记录」要回答三个问题：**谁在什么时候登录了、看了什么、一天里的哪些时段在用**。
Emby 本身只给"此刻谁在播什么"（`/Sessions`）和一份会被截断的活动日志，所以这份台账由应用自己攒。

## 数据从哪来

| 来源 | 覆盖 | 说明 |
| --- | --- | --- |
| **会话采样器**（`usage/session-sampler.ts`） | 装上之后 | 每 `usage.sampleSeconds`（默认 30 秒）拉一次 `/Sessions`，把"观察到的连续使用"攒成区间 |
| **活动日志回填**（`usage/activity-log.ts`） | Emby 保留的那段历史 | 每 10 分钟拉一次 `/System/ActivityLog/Entries?HasUserId=true`，按条目 Id 去重写入 |

两者都写进同一张事件表，事件带 `source`（`sampler` / `activity_log`）区分，界面上可追溯。

## 两张表（`packages/database/src/schema.ts`，建表在 `reconcile.ts` 幂等补齐）

- **`member_usage_segments`＝观察区间**：一段"连着/在播"的时间。采样器不断延长 `last_seen_at`；
  会话消失、换片、或在播转成挂着，就封口（`ended_at`）。时段统计完全由它算出来。
  未封口的区间在 `(session_id, kind, item_id)` 上有唯一索引，所以采样是"延长"而不是每次插一行。
- **`member_usage_events`＝事件流水**：`login` / `play_start` / `play_stop` / `session_end` / `other`。
  带 `external_id` 的行（活动日志回填）靠唯一索引去重，回填可以反复跑。

## 已知的取舍（刻意的）

- **只记看到的**：封口时间取 `last_seen_at` 而不是 `now` —— 只能证明到那一刻还在用，多算的时长是编的。
  代价是采样间隔内的短播放（点开又秒退）会漏，统计出的时长永远是**下限**。
- **丢失即结束**：会话从 Emby 消失后要连续两个采样周期没见到才封口，避免网络抖一下把一次观看切成好几段。
- **登录 = 新会话**：Emby 没有"登录事件流"，把"第一次看到某个会话 Id"记成登录（客户端接入）。
  换设备、重装客户端都会产生新会话 Id；服务重启后首次看到的老会话也会记一条，属预期。
- **认不出来的一律留痕**：活动日志里识别不了的类型记成 `other` 并把原文存进 `detail`，不静默丢弃。
- **时段用本地时区算**：SQLite 的 `strftime` 只能按 UTC 或固定偏移切小时，夏令时/跨时区会错位，
  所以按区间在 JS 里逐段切小时（`usage/usage-report.ts`）。

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/member-usage/overview?days=1\|7\|30` | 汇总：总计、全站 24 格时段分布、每会员（含零使用会员）的时长/次数/时段/常看内容 |
| GET | `/api/member-usage/member?key=email:x@y&days=30` | 单会员：事件时间线（最多 200 条）、日期×小时热力图、最近观看 |
| POST | `/api/member-usage/refresh` | 立刻采样一次 + 回填一次活动日志（页面首次打开没有数据时自动触发） |

`key` 规则：会员是 `email:<邮箱>`；未绑定会员的 Emby 账号是 `emby:<EmbyUserId>`（他们照样会产生记录，
不会因为"没收编成会员"就从统计里消失）。界面上优先显示**用户名**，只有连用户名都没有时才会露出这个 key。

### 身份是怎么认出来的（2026-09 修过一处线上坑）

- **采样器**：直接用会话里的 `UserId`（GUID）+ `UserName`。**没有 UserId 的会话整条跳过** ——
  那是我们自己后台客户端的连接（媒体任务中心 / TgtoDrive）或未登录的匿名客户端，
  既不是会员在用，也没有名字可显示（早期它们会变成一行 `name:unknown`，还把设备数与时长算大）。
- **活动日志回填**：Emby 活动日志里的 `UserId` 是**内部数字 id**（线上实测：同一个账号在 `/Sessions`
  是 GUID `e0c8d46c…`，在活动日志里却是 `1`）。所以回填时必须用 `/Users/{id}` 把它翻译回 GUID
  —— 该端点两种 id 都吃。早期版本直接存数字 id，于是「会员使用情况」里出现过根本不存在的
  `emby:1`；现在解析不出真实用户的条目**不写入**（记进 `unresolved` 计数），绝不凭空造账号。
- 启动/每轮回填会顺带**修历史**：`source='activity_log'` 且 `emby_user_id` 不是 GUID 的行，
  会被翻译回 GUID 并补上用户名与会员邮箱（幂等，修完就再也匹配不到）。
- 统计口径：没有任何身份（无邮箱、无 UserId、无用户名）的行不进「会员使用情况」，
  设备数 / 播放次数 / 时长都按同一份口径算。

## 相关设置（「系统设置 → 会员使用记录」）

- `usage.sampleSeconds`（默认 30，10–600）：采样间隔。改完需重启进程生效。
- `usage.retentionDays`（默认 180，7–3650）：超期的事件与**已封口**区间会被清理；正在进行的区间不删。

## 播放会话详情

会话卡片上的"4K HEVC / Chinese EAC3 stereo / MKV 6 mbps / 转码原因"由 `integrations/emby-playback.ts`
解析（纯函数，单测覆盖真实样例）。会话里没带 `MediaStreams` 时，用 `/Items?Fields=MediaStreams` 兜底补齐，
按条目 Id 缓存 10 分钟——管理端会话面板每 3 秒轮询一次，不能每次都去问 Emby。

### 进度条：总时长未知时画"不确定态"，不画 0%

`positionTicks`（已播）与 `runTimeTicks`（总时长）是两件事，Emby 完全可能只给前者：

| 情况 | 会话卡显示 |
| --- | --- |
| 两者都有 | `4:39 / 21:07` + 实心进度条 |
| 总时长未知（`.strm` / 网盘直链片源常见：条目层与 `MediaSources` 层都没有 RunTimeTicks） | `已播 47:58 · 总时长未知` + 不确定态（扫光）进度条，且不设置 `aria-valuenow` |
| 没在播 | 「已连接（未播放）」+ 不渲染进度条 |

所以服务端把 `progressPercent` 定义成 **nullable**：`null` = 算不出来，`0` = 确实停在片头。
2026-09 的线上样本：会员 `2512920656` 用 Emby Web 播《92霸王花与霸王花》（.strm 网盘直链），
`PositionTicks=28780397291`（47:58）而 `RunTimeTicks=null`；早期实现把它当 0，
界面画成 0% 宽的进度条，看起来就是"只有播放时间、没有进度条"。
总时长的兜底顺序：`NowPlayingItem.RunTimeTicks → 选中 MediaSources[].RunTimeTicks → null`。

### 会话列表只铺"正在播放"的那些

`/Sessions` 里混着"客户端连着但没在播"的会话，其中包括本应用/系统自己连上去的
（媒体任务中心、TgtoDrive）。列表默认只显示 `isPlaying` 的卡片，其余折叠成一行
「另有 N 个已连接会话（未在播放）」；没有 `userId` 的会话标注为「系统 / 应用会话」。
分组规则在 `apps/web/src/library/session-groups.ts`（有单测）。
