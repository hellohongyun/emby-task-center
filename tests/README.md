# 测试入口与隔离范围

## 单元与组件回归

`query-descendant-types.test.ts` 验证 SenPlayer 类型组合的子项读取范围、合法视频子项、分集、未限定类型展开及原剧归组海报，使用隔离上游夹具，不代替播放器实测。

在项目根目录运行 `pnpm test`。服务端使用 Vitest，前端使用 Vue 组件和请求夹具；这些测试不代表真实 Emby、TMDB、SMTP 或反向代理已经验证。

会员注册的浏览器回归 `activate-repro.spec.ts` 用请求夹具验证群公告指引、验证码验证后的资料页及最终开通请求，保留已有会员登录和续费页面回归。服务端使用临时 SQLite 验证群邀请码配置、资料保存和头像同步规则，Emby 上传使用测试夹具。

名单逐项选片通过 `useVirtualNameQueue.test.ts`、`VirtualNameQueue.test.ts` 和 `VirtualLibrariesPage.test.ts` 验证：仅自动填入搜索词，成功加入后推进，失败保留选择，跳过不写关联，切库后的旧请求不推进新名单。

`apps/server/src/routes/http-direct-login.test.ts` 使用生产模式、临时 SQLite 与本地 HTTP 服务验证管理员和会员登录 Cookie 不带 `Secure`、携带 Cookie 可访问各自接口、退出会清除两类 Cookie，以及响应不下发 HSTS。另验证伪造 `X-Forwarded-For` / `X-Forwarded-Proto` 不能绕过直连 IP 登录锁定；通过检查实际 Cookie 响应头，避免浏览器对 localhost 的特殊处理掩盖问题。这些用例不监听生产端口、不写真实数据库，也不调用外网。

虚拟媒体库的聚焦回归可运行：

```powershell
pnpm exec vitest run apps/server/src/virtual-libraries apps/server/src/routes/virtual-libraries.test.ts packages/database/src/schema-drift.test.ts
```

`upstream-preservation.test.ts` 和 `owned-library-overlay.test.ts` 验证上游 DTO、扩展字段、相对顺序和原始查询参数保留，只有自有新增条目参与隐藏与插入；混合 ID 请求保留上游返回结果。

`root-library-discovery.test.ts` 覆盖网易爆米花实际使用的根级媒体库查询，仅在确认上游返回纯媒体库列表时追加自有库；验证非库、空结果、鉴权失败、递归和其他内容筛选不被改写。

这些用例覆盖关联持久化、选片查询仅包含电影和整部剧、新增季与分集的整批拒绝、类型匹配、历史关联保留、查询映射、完整分页、默认关闭无监听、普通请求与链接透传、Range/HEAD、真实删除结果、WebSocket 和配置失败回退。前端另覆盖作品过滤、禁选与提示、历史告警及类型修改校验。媒体库作品归组测试另覆盖同库内按类型与有效 TMDB ID 识别、缺失 ID 兜底及完整详情。仅使用临时数据库和本地 HTTP 上游，不替代 TgtoDrive 与实际客户端联调。

关联恢复回归覆盖 TMDB 身份持久化、旧库加列升级、原 ID 失效或复用、唯一候选恢复、多来源歧义、身份缺失、401/网络失败及并发移除保护。真实本地 HTTP 代理测试验证原客户端凭据、播放 DTO 与普通请求透传；前端覆盖关联告警和切库后的旧响应隔离。

`queries-view-order.test.ts`、`view-order-proxy.test.ts`、`ttd-order-roundtrip.test.ts` 和 `owned-view-preferences.test.ts` 验证仅移动自有虚拟库、保留上游顺序及分页、偏好失败回退、原配置写入及凭据透传、用户隔离和代理重启后恢复。仅使用临时 SQLite 与本地 HTTP 上游，不修改真实 Emby 用户设置。

`modern-discovery-proxy.test.ts` 使用真实本地 HTTP 与临时数据库，按 Emby 4.10 的动态首页分区、真实 Id 与 Guid 不同、`text/plain` 的 Partial 配置保存，以及上游错误返回无关条目的行为验证发现链路。首页分类缓存只存分区 ID 和类型，并验证凭据隔离、内容继续鉴权及未知分区透传。`home-sections`、`discovery-items` 和 `home-section-cache` 的聚焦用例补充分页、隐藏后数量、缓存过期和父范围约束。

`emby-library-order.test.ts` 使用真实管理端 HTTP 和模拟 Emby 会话，验证鉴权、草稿与审计、直连和反代预览、全量及单账号范围、可见库顺序、未知令牌保留、新增媒体库和过期草稿冲突。连续同步回归覆盖直连接口返回注入库、Emby 丢弃注入库标识、可见库列表换序及账号实际修改顺序。`emby-library-order-client.test.ts` 使用本地 HTTP 验证仅通过 Emby 部分配置接口提交 `OrderedViews`。`emby-library-order-plan.test.ts` 验证 GUID 归一化、未知令牌保留，以及写入后必须回读到显式保存的顺序。`LibraryOrderPage.test.ts` 验证排序、搜索、草稿、双预览、仅反代变化时的确认和部分成功结果。

`emby-library-order-proxy-linkage.test.ts` 使用真实管理 API、独立的本地 Emby 和 TgtoDrive HTTP 上游，以及本项目反代。验证 Emby Web「首页设置」实际使用的 `/Views` 查询按模板排列原生库、上游注入库和本项目虚拟库，覆盖隐藏项、单账号同步边界、反代重启、客户端鉴权及 206 分段读取。管理 API 测试另覆盖上游部分失败时保留已有模板及逐账号的反代预览错误提示。上游和 SQLite 均为测试夹具。

缺集聚焦回归覆盖合并集闭区间持久化与重扫、所选启用库独立计算、停用库历史保留、公开 Emby 库 ID（含 GUID）与本地行号碰撞、删除前真实库存复核、当前库 Emby 跳转、只读 worker 一致快照与生命周期。前端覆盖切库清除选择、空库切换、待核对提示、迟到响应、401、超时和离页取消。只在临时数据库与本地上游中执行删除；真实库核对仅执行只读查询。

`apps/server/src/library/emby-unnumbered-specials.test.ts` 另覆盖无集号 S00 的保留与严格边界：正季、未知季缺号及非法数字仍拒绝；同真实 ID 去重，不同特别篇保留。临时文件 SQLite 验证库存文件数、正常合并集行、重扫稳定和重开持久化，不写真实 Emby。

性能回归使用包含 1200 个分集的本地夹具，断言整部剧列表和作品筛选只执行一次上游查询，并验证季、分集、Counts、Latest/Resume、NextUp 及旧容器的范围。身份检查缓存测试覆盖分页和展示头复用、并发合并、用户/凭据/上游隔离、映射变更失效与取消重试；这些用例验证请求数量和行为，不用不稳定的耗时阈值代替正确性检查。

## 求片与管理员续期回归

```powershell
pnpm exec vitest run apps/server/src/routes/media-requests.test.ts apps/server/src/routes/media-requests-auth.test.ts apps/server/src/media-requests/persistence.test.ts apps/server/src/routes/member-renewal.test.ts packages/database/src/schema-drift.test.ts
pnpm --filter @emby-task-center/web test src/components/MediaRequestForm.test.ts src/components/PublicRequestsView.mobile-flow.test.ts src/components/MediaRequestEditor.test.ts src/components/MediaRequestQuickActions.test.ts src/components/MediaRequestList.test.ts src/components/MediaRequestList.actions.test.ts src/composables/media-request-api.test.ts src/components/MemberRenewalDialog.test.ts src/components/PublicPortal-policy.test.ts
```

求片测试验证真实 `createApp` 管理员／会员会话用途隔离、动态权限、会员记录与说明编辑隔离、TMDB 身份及真实季号校验、同季重复保护、管理员反馈与编辑冲突。临时文件库测试验证表对账幂等、重开持久化及历史申请重新开启的重复保护。组件测试覆盖搜索、分季确认、补集必填说明、步骤间键盘焦点、页签切换保留草稿、重复申请提示、处理冲突和离页取消。

会话回归通过真实邮箱验证码登录、删号、同邮箱重建及重新登录，验证旧会话不能读取或编辑新账号的申请。另覆盖旧版会话对既有会员的兼容，以及历史申请含时区偏移或异常版本值时的安全编辑、过期版本冲突与清理起点保留。卡密回归验证长期会员拒绝兑换新卡、卡密保持未使用以及旧卡幂等回执。

已入库申请保留期可聚焦运行：

```powershell
pnpm exec vitest run apps/server/src/media-requests/retention.test.ts apps/server/src/scheduling/media-request-retention.test.ts packages/database/src/media-requests-retention-upgrade.test.ts apps/server/src/routes/media-requests.test.ts
```

这些测试使用临时 SQLite 和受控时间，验证仅已入库满 7 天可删除、精确时间边界、非法时间保留、反馈编辑不重置计时、重新打开取消计时、批次上限及删除与审计同事务。升级测试验证历史时间只回填一次且迁移不删记录；调度测试验证启动检查、每小时检查、互斥、失败重试及停止行为。另在独立本地验收库通过真实 HTTP 和 320／390 像素浏览器验证清理前后管理员与会员列表、保留提示、时间详情和旧记录修改被拒绝；仅删除本轮专属夹具申请，并核对会员与媒体库存不变。

移动端界面回归另验证状态快捷筛选沿用服务端查询、处理面板的焦点与 Escape／取消行为、保存期间防重复及禁止关闭、正文滚动锁还原和冲突恢复；分步提交保留剧集必选分季及补集说明校验。界面调整不改变求片身份、去重或状态更新规则。

快捷处理回归验证开始处理与标为已入库保留原反馈、版本检查、同卡写操作互斥、双击不跨两个阶段、失败不改状态和离页取消。列表回归验证确认后原位更新、不整页重读、保留筛选和搜索、移出当前筛选时更新数量并提示结果，以及旧刷新响应不能覆盖新状态。真实本地 HTTP／浏览器验收另通过延迟响应检查忙状态、真实并发修改检查 409、四个状态选项只改草稿并在保存时提交；仍仅使用独立测试会员和资源夹具。

会员页专项组件测试覆盖切换提交／记录页签保留草稿、返回修改、提交回执与新申请，以及海报失败占位。真实网页另完成 320／390／1440 像素的搜索、填写、核对、记录及后台处理验收，核对主要触控区域至少 44px、长说明和长邮箱不横向溢出。手机处理面板在 600px 高视口下仍可滚动正文并点击底部保存，未被底部导航遮挡；缩小视口只模拟可用高度，不代替真实手机软键盘验证。

另以本地独立文件数据库和真实网页 HTTP 完成会员单季补集、后台反馈、会员查看结果，以及两种管理员续期方式的浏览器验收。320、390、1440 像素宽度下检查门户、管理页和续期弹窗，未见横向溢出或页面异常；手机端通过「更多」进入求片管理。TMDB 与会员使用本地夹具，邮件仅本地捕获；播放器反代仅验证无凭据公共信息请求可转发，未验证真实账号登录或播放。

管理员续期测试验证增加天数与服务器时区固定日期、旧有效期校验、跨数据库重开的幂等重放、停用／冻结限制及 Emby 恢复失败的部分成功提示。前端另验证 HTTP 局域网可用的操作 UUID、重复提交保护、请求超时和卸载后的迟到响应隔离。测试仅操作临时 SQLite 与本地夹具，不调用真实 Emby、TMDB 或 SMTP。

续期名称与邮件投递可聚焦运行：

```powershell
pnpm exec vitest run apps/server/src/routes/member-renewal.test.ts apps/server/src/routes/renewal-notifications.test.ts apps/server/src/subscriptions/renewal-outbox.test.ts apps/server/src/subscriptions/renewal-receipt.test.ts apps/server/src/notifications/renewal-email-notifier.test.ts apps/server/src/notifications/renewal-smtp.integration.test.ts packages/database/src/schema-drift.test.ts
pnpm --filter @emby-task-center/web test src/components/MemberRenewalDialog.test.ts src/composables/portal-renewal-email.test.ts src/composables/usePortalSession-races.test.ts src/components/PublicProfileView.test.ts
```

后端验证两种续费通过现有通知器发送、必发凭证不受临期提醒开关影响、自定义名称与真实日期、HTML 转义、正常重放不重复投递、失败／未配置待发、重启持久化、跨连接租约互斥与慢发送续租。另用 SQLite 触发器模拟入队／开户写入失败，验证卡密、有效期和通知一起回滚；发送完成后的状态标记失败不误报投递成功。前端验证名称填写及清空、待发提示不误报已发送、会员切换后的旧投递状态隔离。

`renewal-smtp.integration.test.ts` 使用实际 `createEmailNotifier`／Nodemailer、真实 HTTP 续期接口、临时内存 SQLite 和本地 TCP SMTP 服务，核对实际信封收件人与解码后的 MIME 正文；模拟 SMTP 451 拒信，验证有效期保留、现有 `retryPending` 补发和正常重放去重。该测试不模拟通知器方法，不连接外部 SMTP，也不证明真实邮件提供商的认证、TLS 或最终收件箱投递已通过。

## 过期账号自动删除

```powershell
pnpm exec vitest run apps/server/src/routes/member-expiry-cleanup.test.ts apps/server/src/routes/member-expiry-cleanup-guards.test.ts apps/server/src/integrations/emby-member-cleanup-client.test.ts apps/server/src/scheduling/member-expiry-cleanup.test.ts packages/database/src/schema-drift.test.ts
pnpm --filter @emby-task-center/web test src/components/MemberExpiryCleanupDialog.test.ts src/components/MembersView.test.ts
```

隔离 SQLite、管理端 HTTP 与回环 Emby 测试覆盖默认关闭、旧会员、精确到期边界、无绑定会员、管理员与冻结权益保护、连接切换、预览冲突、删除失败和响应丢失后的重试核对，以及续期、卡密和网盘上限修改与清理并发时的保护。定时测试验证启动检查、下一轮读取新设置及停止行为。构建后的网页使用真实管理端 API 和回环 Emby，在 320／390／1440 像素下验证预览、启用、定向清理和关闭。删除仅作用于测试数据。

## 网盘到期上限

```powershell
pnpm exec vitest run apps/server/src/subscriptions/drive-expiry.test.ts apps/server/src/subscriptions/drive-expiry-conservation.test.ts apps/server/src/subscriptions/drive-expiry-emby-sync.test.ts apps/server/src/routes/membership-drive-expiry.test.ts apps/server/src/notifications/renewal-smtp.integration.test.ts
pnpm --filter @emby-task-center/web test src/components/MembershipDriveExpirySettings.test.ts src/components/MemberRenewalDialog.test.ts src/components/MembersView.test.ts
```

覆盖升级前后的权益保留、首次设置及缩短上限、断档后部分补回、长期跟随、权限、重复兑换和续期幂等，以及 Emby 同步失败后补偿。独立本地验收以临时数据库、真实 HTTP 和 320／390 像素浏览器验证会员列表、续期预览及门户隐私。邮件仅在本地捕获，Emby 权限测试使用上游夹具。

深度回归用文件 SQLite 核对多会员在反复续期、上限变更和重启后的毫秒权益守恒，并用触发器验证事务回滚。并发回归覆盖旧上限续期预览被拒绝，以及 Emby 旧停用请求写入成功但响应丢失时按新有效期恢复。SMTP 回归在回环 TCP 服务模拟拒信和补发，解码实际投递正文验证仅显示当次实际到期日。

## 浏览器测试

默认入口为 `pnpm test:e2e`，使用 `playwright.config.ts`，主要通过浏览器路由夹具验证界面。默认配置可能复用 3000 端口上的现有服务；需要完全隔离的应用服务时使用下面的独立套件。

```powershell
pnpm build
pnpm exec playwright test -c playwright.real.config.ts
```

独立套件启动编译后的应用、临时 SQLite 与本地 HTTP 测试服务，使用真实应用 HTTP 和浏览器交互。Emby 和 TMDB 上游均为本地夹具：测试启动器将 TMDB 请求重定向到本地，拒绝其他外网请求；浏览器也禁止外网访问。不使用生产数据库或真实 Emby、TMDB、SMTP。

临时库关闭热榜来源，登录失败阈值设为 10，以便连续验证错误口令提示和正确登录；这不是生产默认锁定策略的验收。套件覆盖健康与 PWA 静态资源、实际鉴权、任务 API 幂等创建与看板、Emby 扫描与库存分页、设置脱敏、退出及管理员/会员会话隔离。虚拟媒体库流程额外验证创建、源库搜索与映射、刷新持久化、真实反代同时展示原库与虚拟库、原影片 ID 保持，以及解除关联后原片仍存在；截图 `.local/virtual-libraries-mvp.png` 仅含本地夹具数据。不验证外部片源入库、真实上游性能、PWA 离线能力或生产部署容量。浏览器运行时需预先安装。

`mobile-library.spec.ts` 在 320、390、768 像素宽度检查媒体库搜索、筛选展开、详情关闭、移动导航和虚拟库创建、选片与编辑，断言内容不横向溢出、主要按钮触摸尺寸；1440 像素验证桌面筛选与侧栏布局。390 像素截图保存在 `.local/mobile-library.png` 和 `.local/mobile-virtual-libraries.png`，仅含隔离夹具数据。这些检查使用浏览器设备模拟，不代替真实手机、软键盘或 Emby 客户端验收。

同一浏览器套件还核对管理员登录页与后台顶栏显示的版本来自根 `package.json`，各宽度均可见。镜像发布脚本另外核对前端 `version.json` 与 OCI 版本一致；实际版本命名和发布步骤见 [版本规范](../docs/versioning.md)。

移动导航还验证「更多 → 卡密」可进入实际卡密页面、显示正确标题并保持导航高亮，390 像素截图为 `.local/mobile-card-keys.png`；不生成、删除或兑换卡密。

`mobile-card-keys.spec.ts` 使用另一套临时数据库，在 320、390、768、1440 像素宽度验证卡密表单、自定义日期选择、按天数生成，以及长名称和到期文案的展示、行内编辑取消与保存。它只生成和修改隔离测试卡，保存后核对到期日和天数未被编辑改变；不调用 AI、兑换或删除。界面截图位于 `.local/card-keys-ui-mobile.png`、`.local/card-keys-ui-mobile-list.png` 和 `.local/card-keys-ui-desktop.png`。

`missing-episodes.spec.ts` 在 1440、390 像素验证真实扫描后的合并集识别、启用库独立统计、空库切换、疑似编号提示、删除选择隔离及横向溢出；另以公开 GUID 从 GET 选择到删除确认走完整流程，断言只删除所选夹具库并保留另一库副本。该文件使用专属临时数据库和本地 Emby/TMDB 上游，其他套件默认种子不变。手机截图 `.local/missing-episodes-fixed-mobile.png` 仅含夹具数据，可单独运行：

```powershell
pnpm build
pnpm exec playwright test -c playwright.real.config.ts tests/e2e/missing-episodes.spec.ts
```

## 深度联动

```powershell
pnpm exec vitest run apps/server/src/library/deep-scan-linkage.test.ts apps/server/src/routes/member-lifecycle-linkage.test.ts apps/server/src/shutdown.test.ts apps/server/src/fatal-errors.test.ts
pnpm build
pnpm exec playwright test -c playwright.deep.config.ts
```

后端联动使用临时文件 SQLite、真实应用 HTTP、本地 Emby HTTP 与实际扫描/会员媒体库 worker，验证慢分页和写锁期间读取、重复扫描合并、不完整扫描保留库存、缓存更新、停用媒体库的可见性与历史保留，以及会员开通、停用、过期、续费和冻结限制。邮件仅在内存捕获；会员冻结状态由夹具写入，自动冻结触发由已有并发策略测试覆盖。

浏览器深度套件包含独立套件的 6 项检查，并增加扫描中切页、读取中退出再登录、搜索后新建任务及刷新持久化、抽屉关闭重开后的旧搜索隔离、390 像素移动端导航和媒体库排序。应用 API 由编译后的服务处理，上游等待由本地 HTTP 服务控制。前端回归还通过可控请求时序验证任务操作旧 401 不影响新登录、完整响应超时、销毁后取消及独立写操作并行。

`library-order.spec.ts` 使用独立的本地 Emby 与 TgtoDrive HTTP 上游，从管理后台实际调整顺序，核对保存草稿、单账号同步和全量同步。用 Emby Web 首页设置的 `/Views` 查询核对反代结果、隐藏项、权限和分页，模拟上游 503 检查草稿与生效模板保留，再重启编译后的应用并复用临时 SQLite 核对顺序恢复。浏览器覆盖桌面与 390 像素视口，Emby 设置页通过其 HTTP 查询验证。可单独运行：

```powershell
pnpm build
pnpm exec playwright test -c playwright.deep.config.ts tests/e2e/library-order.spec.ts
```

### 会员注册、群邀请码与头像

```powershell
pnpm build
pnpm exec playwright test -c playwright.deep.config.ts tests/e2e/member-registration.spec.ts tests/e2e/member-registration-boundaries.spec.ts
```

用例运行编译后的门户和服务端、临时文件 SQLite、回环 TCP SMTP，以及本地 QQ 头像和 Emby HTTP 夹具。浏览器调用应用实际接口，验证码从本地收到的邮件正文取得。用例覆盖群公告指引、资料确认前保留卡密、正式开通与 Emby 头像写入、会员自助编辑、管理员查询和同步操作。HTTP 用例另验证邀请码更换、进程重启、凭证与邮箱和卡密的绑定、同一卡密并发核销、SMTP 拒收，以及非 QQ 邮箱老会员登录和续期。

Emby 夹具校验用户 ID、API Key 请求头、头像上传内容和回读结果。生产数据库、真实 QQ、外部 SMTP 和实际 Emby 部署权限均在此套件范围之外。

### 保号清理

```powershell
pnpm build
pnpm exec playwright test -c playwright.deep.config.ts tests/e2e/member-inactivity-cleanup.spec.ts
pnpm exec vitest run apps/server/src/routes/member-inactivity-cleanup.test.ts apps/server/src/subscriptions/member-inactivity-cleanup-races.test.ts apps/server/src/routes/member-expiry-cleanup-guards.test.ts apps/server/src/scheduling/member-inactivity-cleanup.test.ts
```

浏览器用例通过编译后的服务、临时 SQLite、回环 SMTP 和 Emby HTTP 夹具，验证管理员预览与确认、播放恢复后旧预览失效、重启后执行已保存的规则、删除待确认时拒绝续费、Emby 和本地删除顺序、门户会话失效及审计。390 像素视口覆盖关闭规则，随后重启核对关闭状态和会员保留情况。

服务端联动覆盖有效期内的会员、15 天边界、并发清理、删除前恢复播放或提升为管理员、切换 Emby 服务后的身份复核，以及删除结果不明时的补查。删号仅针对测试夹具账号。

### 系统日志与头像刷新

```powershell
pnpm build
pnpm exec playwright test -c playwright.deep.config.ts tests/e2e/system-logs.spec.ts
pnpm exec vitest run apps/server/src/routes/logs.test.ts apps/server/src/subscriptions/member-qq-avatar.test.ts
pnpm --filter @emby-task-center/web test src/components/LogsView.test.ts
```

浏览器在隔离服务中通过实际会员注册和扫描接口核对新日志追加、暂停与恢复、执行编号筛选、文件下载和审计入口。服务端用例覆盖增量游标、筛选跨页、下载鉴权和一小时头像检查，使用不同的图片字节验证同一 QQ 换头像、内容相同跳过上传以及 Emby 自定义头像保护。

## Docker 冒烟

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tests/docker-smoke.ps1
```

脚本使用源码构建模板 `compose.build.yaml`、本轮专属 Compose 项目和临时数据目录，通过桥接网络隔离测试端口。`-Keep` 保留本轮容器和目录供排查；通常运行后清理本轮资源。容器验证需要可用的 Docker daemon；缺少 daemon 时，只能报告静态配置和构建检查，不能算容器验证成功。

验证已构建的待发布镜像时追加 `-Image emby-task-center:<固定版本标签>`。脚本复用该镜像、验证它的实际容器行为，并保留它；不会另建或删除传入的镜像。静态配置和本地应用构建检查仍执行。

冒烟检查覆盖构建产物、健康检查、SPA、生产镜像 HTTP 管理员会话（Cookie 无 `Secure`、响应无 HSTS）、数据库重建持久化和容器文件系统边界。应用通过 Emby API 读取媒体库，不挂载 STRM 目录。真实上游及生产数据库另行验证。

`ttd-order-roundtrip.test.ts` 模拟上游保存排序时丢弃 TTD 条目 ID，验证本项目库仍可跨 TTD 调整位置、配置原字节透传、用户隔离和重启恢复。`query-latest-content.test.ts` 与性能用例验证默认首页仅返回作品和原海报、113 条映射仅用两次批量查询，并保留显式分集与继续观看行为；自动测试本身不代替 Hills 实机验收；本次发布另由使用者完成本地测试确认。

自定义虚拟库海报回归覆盖独立存储、数据库重开与旧表升级、格式结构／尺寸／大小验证、替换更新 tag、移除仅影响自定义图、当前 tag 图片免 Token 读取、缺失／旧 tag 使用客户端原凭据鉴权、GET／HEAD／ETag 和原媒体图片透传。前端组件覆盖预览、保存、错误与切库取消；另用隔离临时数据库和实际管理端 HTTP 完成桌面／320px 浏览器上传、刷新及移除验证。该验证不代表所有第三方客户端均已实机验收。

`owned-home-sections.test.ts` 覆盖标准首页展开行、仅新增本项目分区、隐藏设置、拒绝凭据、未知上游原样返回，以及自有分区内容使用原用户凭据；隔离 HTTP 联调验证原有分区字段和顺序保留。

`query-latest-media-types.test.ts` 模拟 Series 无 MediaType、电影和分集为 Video 的上游行为，验证首页分组视频请求保留整部剧及原海报，同时保留音频、显式分集和普通浏览筛选。
