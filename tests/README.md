# 测试入口与隔离范围

## 单元与组件回归

在项目根目录运行 `pnpm test`。服务端使用 Vitest，前端使用 Vue 组件和请求夹具；这些测试不代表真实 Emby、TMDB、SMTP 或反向代理已经验证。

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

缺集聚焦回归覆盖合并集闭区间持久化与重扫、所选启用库独立计算、停用库历史保留、公开 Emby 库 ID（含 GUID）与本地行号碰撞、删除前真实库存复核、当前库 Emby 跳转、只读 worker 一致快照与生命周期。前端覆盖切库清除选择、空库切换、待核对提示、迟到响应、401、超时和离页取消。只在临时数据库与本地上游中执行删除；真实库核对仅执行只读查询。

`apps/server/src/library/emby-unnumbered-specials.test.ts` 另覆盖无集号 S00 的保留与严格边界：正季、未知季缺号及非法数字仍拒绝；同真实 ID 去重，不同特别篇保留。临时文件 SQLite 验证库存文件数、正常合并集行、重扫稳定和重开持久化，不写真实 Emby。

性能回归使用包含 1200 个分集的本地夹具，断言整部剧列表和作品筛选只执行一次上游查询，并验证季、分集、Counts、Latest/Resume、NextUp 及旧容器的范围。身份检查缓存测试覆盖分页和展示头复用、并发合并、用户/凭据/上游隔离、映射变更失效与取消重试；这些用例验证请求数量和行为，不用不稳定的耗时阈值代替正确性检查。

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

浏览器深度套件包含独立套件的 6 项检查，并增加扫描中切页、读取中退出再登录、搜索后新建任务及刷新持久化、抽屉关闭重开后的旧搜索隔离、390 像素移动端导航。它不拦截伪造应用 API 响应，上游等待由本地 HTTP 服务控制。前端回归还通过可控请求时序验证任务操作旧 401 不影响新登录、完整响应超时、销毁后取消及独立写操作并行。通过这些测试不代表所有请求竞态、生产网络断流或容量均已验证。

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
