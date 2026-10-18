# 并发限播怎么执行

并发限制**全部走 Emby API**：实时中断 + 累计超限到点冻结，不依赖任何转发层。可选的 [虚拟媒体库反代](virtual-libraries.md) 只处理虚拟库展示和映射，不接入这里的并发限制。

## 为什么不能只靠 Emby 自己的开关

实测（见 `apps/server/src/scheduling/runtime.ts` 的说明）：

- 这台 Emby **不执行用户级 `SimultaneousStreamLimit`** —— 策略里写上上限也不拦；
- **停用账号（`IsDisabled`）不会中断"已登录设备"正在进行的播放**，也不拦它们开新流（只是挡住新登录）。

所以"冻结"不能只写策略位，必须 **停用 + 主动断掉该账号全部会话 + 踢掉设备**：令牌失效后客户端必须
重新登录，而账号已停用，登不回来——冻结才真的成立。

## 三层执行

| 层 | 位置 | 频率 | 做什么 |
| --- | --- | --- | --- |
| ① 上限解析 | `subscriptions/stream-limits.ts` | 每次判定 | 登记会员用登记值 → 未登记账号用「默认并发路数」（默认 1）→ Emby 管理员不限 |
| ② 实时看门狗 | `subscriptions/stream-guard.ts` | 有人在播时 1 秒，否则 5 秒 | 同一账号播放/暂停会话超过上限：**先到先得**，保留看得更久的那台，停掉后来者（先请客户端停 → 断开会话 → 踢设备）；**冻结中的会员一路都不许**，直接踢 |
| ③ 超限升级 | `subscriptions/concurrency-escalation.ts` | 每 10 秒 | **累计超限时长** →（可选）提醒邮件 → **到点直接冻结** → 冻结期间每轮继续断流 → 到期自动恢复并邮件 |

冻结与提醒**只针对会员账号**（`submission_users` 里已绑定 Emby 的账号）：登记过并发上限的用登记值，
没登记的按「默认并发路数」；**Emby 管理员一律不受影响**（即使被登记成会员也跳过）。非会员的 Emby
账号只被看门狗实时中断，不做冻结。

冻结期间可以登录门户进入“我的”申请自助解冻，但不能访问影视内容。卡密续费只延长有效期，不清除冻结状态。自动解冻、自助解冻、管理员恢复和后台直接启用 Emby 用户都核对当前会员状态：管理员停用或已过期的会员不能被恢复操作重新启用。过期并冻结时先续费，再按解冻规则处理。完整访问规则见 [会员访问与账号恢复](member-access.md)。

### 触发式累计（关键口径）

超限判定不是"连续超限到点"，而是**累计超限时长**：

```
首次确认超限 ──累计满 remindAfterMinutes──> 提醒邮件（可设 0 关闭）
             └──累计满 disableAfterMinutes──> 冻结：Emby 停用 + 断全部会话 + 踢设备 + 邮件
                                            └──disableForHours──> 自动恢复并邮件
```

- 升级任务每 10 秒采样一次：**相邻两次都确认超限**的那段时间才计入累计，单次最多计入一个周期；
- 采样读到"限内"时只闭合当前这一档，**累计与"已提醒"标记都不清零**；只有冻结/解冻才归零；
- 为什么要这样：看门狗每秒就把第二路掐掉，采样时经常读到"已经回落限内"。若一回落就清零，
  持续对抗的会员永远攒不到阈值，冻结形同虚设；
- 代价与好处：换设备、客户端重连这类**一次性重叠**最多贡献不到一个周期，攒不到阈值，因此不会误伤
  （对应会员须知里"多次违规才临时封停"）；代价是真正的冻结时刻可能比配置值晚最多一个采样周期；
- 单次计入封顶还防了一件事：进程停机期间锚点不会更新，恢复后不会拿旧锚点把"超限几小时"一次性补记。

### 冻结必须"确认生效"，不能"发完请求就算冻了"

线上踩过的坑：邮件说"已冻结"，账号照常用。三处根因都已在代码里封死：

1. **Emby 的策略写是整份覆盖**（`POST /Users/{Id}/Policy`）：只发 `{IsDisabled:true}` 会把并发上限冲成默认值，
   只发 `{SimultaneousStreamLimit:N}` 又会把停用位冲回 `false` —— 冻结会被之后任意一次上限同步悄悄解除。
   现在 `setDisabled` / `applyPolicy` 一律**先读当前策略再合并写**（`emby-user-service.ts`）。
2. **写成功 ≠ 生效**：冻结先写停用位、**回读确认**，确认了才发"已冻结"邮件、才记冻结状态；
   没确认就只断流、记一条 `concurrency_escalation_failed` 警告日志，下一周期重试 —— **绝不发假的"已冻结"**。
3. **冻结期内守住停用位**：每个周期回读一次，被别的写入冲掉就立刻写回，并记一条
   `concurrency_freeze_reasserted` 警告（这条日志出现说明有别的代码在覆盖策略，值得查）。

其他两处如实性修复：

- **看门狗不再谎报手段**：`DELETE /Devices` 在 Emby 的 `/Devices` 里找不到该设备时会退化为断会话，
  日志与 `stoppedSessions[].action` 现在记**实际生效**的那个（`kick` → `logout`）。
- **每封策略邮件都留痕**：`concurrency_escalation` 日志里能看到"提醒/冻结/解冻 了谁"，
  一眼就能看出是不是重复发了。
- **管理员邮件不再抄送会员那封**：以前 `adminEmail` 是 cc，管理员收到的是一封会员口吻的信，
  压根不知道是谁触发的。现在提醒/冻结各给管理员**单独发一封**，写清会员邮箱、Emby 用户名与用户 ID、
  上限（含是登记值还是全局默认）、触发时实际路数、累计超限时长、系统已经做了什么
  （断了几路、冻结多久、何时自动解冻）、以及"去哪点一键恢复"。

> ⚠️ **上线前必查**：现在**未登记上限的会员也会被冻结**（按 `defaultStreamLimit`，默认 1 路）。
> 如果有会员本来就该多设备同时看，必须在「会员与运营」里把上限登记成对应的路数，否则他会按 1 路
> 被判定超限。自查：`SELECT email, emby_max_streams FROM submission_users;`

## 后台设置项（系统设置 → 外部集成 → 并发超限升级）

| 设置键 | 含义 | 默认 |
| --- | --- | --- |
| `concurrencyPolicy.enabled` | 启用超限升级（关闭 = 只做实时中断） | 开 |
| `concurrencyPolicy.interruptStreams` | 超限直接中断多出来的播放 | 开 |
| `concurrencyPolicy.defaultStreamLimit` | 未登记上限的会员默认路数（0 = 不限；管理员不受限） | 1 |
| `concurrencyPolicy.remindAfterMinutes` | **累计**超限多少分钟后发提醒（**0 = 不提醒，到点直接冻结**） | 2 |
| `concurrencyPolicy.disableAfterMinutes` | **累计**超限多少分钟后冻结账号 | 5 |
| `concurrencyPolicy.disableForHours` | 冻结时长（小时，到期自动恢复） | 1 |
| `concurrencyPolicy.adminEmail` | 提醒/冻结时**单独发给管理员**的邮件（含会员信息与实际情况；留空 = 不发） | 空 |
| `concurrencyPolicy.unfreezeEnabled` | 允许会员自助解冻（冻结邮件给入口 + 门户显示解冻按钮） | 开 |
| `concurrencyPolicy.unfreezeMonthlyLimit` | 会员每月自助解冻次数上限（0 = 不允许） | 2 |
| `concurrencyPolicy.unfreezeWaitSeconds` | 自助解冻强制等待秒数（服务端同样校验） | 60 |
| `concurrencyPolicy.unfreezeTitle` / `.unfreezeNotice` | 自助解冻弹窗标题 / 正文（后台可改，正文支持占位符） | 见下 |
| `concurrencyPolicy.portalUrl` | 平台地址：冻结邮件里"登录平台"的链接 | 空 |

会员的并发上限在「会员与运营」里按人设置（留空 = 按上面的默认路数）。**新注册（首次开卡）的会员
开通时会自动登记** `member.newMemberMaxStreams`（系统设置 →「会员」，默认 1 路）——不再是"留空跟随默认"，
所以门户与后台列表里看到的都是一个确定的路数，Emby 侧也同时设上 `SimultaneousStreamLimit`。

注册/开通后会员看到的文案（系统设置 →「会员」，全部留空即回落默认文案）：

| 设置键 | 含义 | 默认 |
| --- | --- | --- |
| `member.newMemberMaxStreams` | 新注册会员自动登记的并发上限 | 1 |
| `member.welcomeEmailSubject` / `.welcomeEmailBody` | 开通邮件（Emby 账号 + 登录教程）的主题 / 正文 | 见注册表 |
| `member.embyOnboardTitle` / `.embyOnboardNotice` | 门户「我的」页开通提示的标题 / 正文 | 见注册表 |

两处共用一套占位符与同一个渲染路径（`subscriptions/member-notices.ts`）：
`{{email}}` `{{serverAddress}}` `{{username}}` `{{password}}` `{{maxStreams}}`
`{{streamLimitNote}}` `{{platformUrl}}`。地址口径以「Emby 地址」设置为准，
所以邮件与页面上写的一定是同一个地址；换服务器地址不需要改代码。

## 会员自助解冻（冻结邮件 + 门户「我的」）

冻结不是"只能干等到期"：会员可以登录平台自己解冻，避免把"为什么播不了"变成一次客服往返。

```
冻结邮件（写明入口/等待秒数/每月次数）
   └── 会员登录门户 →「我的」→ 冻结提示里的「申请解冻」
         └── 强制弹窗（后台文案，倒计时期间没有关闭入口）
               └── 等满 unfreezeWaitSeconds →「确认解冻」
                     └── 确认 Emby 账号重新启用 → 清空冻结状态 + 记一次月度次数 + 发「已解冻」邮件
```

口径（都不是"前端做做样子"）：

- **等待由服务端算**：点开弹窗时把「申请时刻」写进 `concurrency_escalation_state.unfreeze_requested_at`，
  确认解冻时服务端按它校验是否等满；同一轮冻结里重复点开**不重置**时刻（关掉再打开也赖不掉）。
  只做前端倒计时的话，直接打接口就能秒解冻，等于没等。
- **每月次数上限**：每成功一次写一行 `member_unfreeze_events`（自然月统计，服务器本地时区），
  默认每月 2 次，可在后台改（0 = 不允许自助解冻）。**冻结到期自动恢复不占次数**。
- **解冻同样要"确认生效"**：先确认 Emby 账号真的重新启用，才记次数、才发"已解冻"邮件、才清状态；
  没确认就返回失败（`release_failed`），**不消耗次数、不发信**——和冻结那边"绝不发假的已冻结邮件"同一口径。
- **留痕**：审计日志记一条 `member.self_unfreeze`（操作人是会员邮箱），服务器日志记一条
  `member_self_unfreeze`——"谁在冻结期内自己放了行"必须查得到。解冻邮件只发会员本人，不抄送管理员。
- **文案后台可改**：弹窗标题/正文来自「并发超限升级」面板，正文支持占位符
  `{{email}}` `{{unfreezeAt}}` `{{remaining}}` `{{maxStreams}}` `{{monthlyLimit}}` `{{usedThisMonth}}`
  `{{remainingChances}}` `{{remainingAfterThis}}` `{{platformUrl}}`，由服务端渲染后下发
  （前端不写死任何一句提示语）。
- **两个"还剩几次"是不同口径**（曾经混用导致"解冻后还剩 1 次"少算一次）：
  `remainingChances` = 本月还剩几次（不扣本次，门户冻结提示与解冻成功后的弹窗都用它）；
  `remainingAfterThis` = 本次解冻后还剩几次（只用在"本次解冻后还剩"这种句子里）。
  旧库里保存过的默认文案由启动迁移自动改成新占位符（`legacy-migration.ts`）。
- 冻结提示**不再按"有没有登记并发上限"过滤**：未登记上限的会员按默认路数同样会被冻结，
  这批人以前在门户和会员列表里都显示成"正常"（看不到解冻时间、也点不了解冻按钮）。

接口（门户会话，`routes/public-subscriptions.ts`）：

| 接口 | 作用 |
| --- | --- |
| `GET /api/public/subscriptions/member` | 会员摘要，含 `concurrency`（冻结状态）与 `unfreeze`（能否自助解冻、弹窗文案、本月剩余次数） |
| `POST /api/public/subscriptions/member/unfreeze/ack` | 点开弹窗：记下申请时刻，返回 `readyAt`（倒计时以它为准） |
| `POST /api/public/subscriptions/member/unfreeze` | 确认解冻：校验本人 + 冻结中 + 次数未用尽 + 已等满 → 解冻并返回最新摘要 |

## 管理端手动控制

- **会员列表 / Emby 用户页**：停用 / 启用某个 Emby 账号（走 Emby API），可查看并断开在线会话、改密码、删除。
- **会员列表「恢复」**：清除该会员的超限冻结状态，并重新启用其 Emby 账号（冻结期间想提前放行就用它）。

## 相关代码与测试

- `apps/server/src/subscriptions/stream-limits.ts`：上限解析 + `isFrozen()`（冻结期内一路都不许）
- `apps/server/src/subscriptions/stream-guard.ts`：实时中断 + `terminateMemberSessions()`（冻结断流）
- `apps/server/src/subscriptions/concurrency-escalation.ts`：升级时间线与冻结/恢复
  （`releaseFrozenMember()` = 带回读确认的解冻，自助解冻与到期恢复共用）
- `apps/server/src/subscriptions/self-unfreeze.ts`：会员自助解冻（月度次数、强制等待、弹窗文案渲染、已解冻邮件）
- `apps/server/src/subscriptions/member-notices.ts`：注册/开通文案（开通邮件 + 门户「我的」提示，
  主题/标题/正文都来自系统设置，地址与上限按当前配置渲染）
- `apps/server/src/util/template.ts`：占位符渲染（弹窗文案、开通邮件、页面提示共用一份实现）
- `apps/server/src/integrations/emby-user-service.ts`：Emby 用户策略 / 会话 API 封装
- 测试：`stream-guard.test.ts`（先到先得、逐级升级、冻结会员单路也踢）、`concurrency-escalation.test.ts`
  （按 30 秒节奏累计 → 提醒 → 冻结并断流 → 冻结期持续断流 → 到期恢复；提醒关闭时到点直接冻结；
  冻结邮件必须写清自助解冻入口）、`self-unfreeze.test.ts`（没等满不放行、次数用尽拒绝、
  Emby 没确认恢复就不算解冻、未登记上限的会员同样能看到入口）
- 前端：`apps/web/src/components/UnfreezeModal.vue`（强制弹窗 + 倒计时）、
  `PublicProfileView.vue`（冻结提示里的「申请解冻」）、`ConcurrencyPolicyPanel.vue`（后台文案与口径）
- 端到端联调：`concurrency-freeze.integration.test.ts` —— 起假 Emby HTTP 服务 + **真实 EmbyClient**
  真发请求，5 个场景：①未登记上限的会员按默认路数照样冻结；②顽固客户端提醒 → 到点冻结（停用策略位
  + 断全部会话 + 踢设备 + 发信）→ 冻结期内单路也踢 → 12 小时到期恢复；③**采样瞬间恰好回落也不清零**
  （旧实现冻不掉人的根因）；④只短暂重叠一次不误伤；⑤Emby 管理员不受影响。真机验收清单见本文末。

> 真机验收建议：**先重新构建（`pnpm build:server`）并重启实例**，再用一个测试会员开两路播放，
> 等 `disableAfterMinutes` 到点，确认 (1) 两台设备都被踢出、
> (2) 该 Emby 账号变为停用、(3) 到期后自动恢复。`Playing/Stop`、`Logout`、`DELETE /Devices` 对真实客户端
> 生效与否由客户端实现决定，踢设备这一步是最终兜底。
