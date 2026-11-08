# 开发、修复与发布流程

本文用于维护者和接手项目的开发者，串起需求确认、本地验证、源码推送、镜像发布及服务器升级。版本规则见 [版本规范](versioning.md)，部署与恢复见 [部署文档](deployment.md)，测试范围见 [测试说明](../tests/README.md)。

## 流程与职责

```text
明确问题 → 本地修改 → 自动测试与客户端验收 → 确认发布
    → 版本递增 → 提交源码 → 构建镜像 → 容器验证
    → 推送源码与标签、等待 CI → 上传固定镜像并更新 latest
    → 核对远端摘要与公开拉取 → 服务器备份、拉取、重建、验收
```

| 环节 | 当前实现 |
| --- | --- |
| 源码 | GitHub：`hellohongyun/emby-task-center` |
| 镜像构建 | 维护者本机 Docker Desktop／Docker Engine |
| GitHub Actions | 检查格式、类型、测试、覆盖率、构建和零配置启动；不发布 Docker 镜像 |
| 镜像仓库 | GHCR：`ghcr.io/hellohongyun/emby-task-center` |
| 发布平台 | `linux/amd64` |
| 服务器升级 | 管理员在部署目录执行 Compose 拉取与重建；推送镜像不会自动更新服务器 |

## 1. 明确问题与改动边界

- 记录客户端名称、版本、服务器入口、操作步骤，以及预期和实际结果。
- 区分库入口缺失、首页栏目缺失、库内内容为空、海报失败和播放失败。首页恢复不等于库内和播放已验证。
- 用户仍在讨论方案时先确认方案；本地开发完成后先让用户验收，获得发布指令再推送、打包和更新 `latest`。
- 修改前读相关 README，不覆盖已有改动；删除文件或改变数据范围前先确认。

虚拟库遵循最小改动边界：只处理本项目拥有的库、关联和首页分区；保留上游 Emby、TgtoDrive 的条目、字段及原始请求条件。管理员模板启用时按模板排列可见库，模板外条目保留相对顺序。真实条目、播放链接、字幕、Range、重定向和 WebSocket 按现有透传规则处理。客户端查询使用原客户端凭据，不借用后台管理 API Key 授权。

## 2. 建立可复现的本地环境

使用 Node.js 24、仓库指定的 pnpm 和独立测试数据。源码运行：

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm build
pnpm start
```

本地启动器默认管理端口 `3000`，生产镜像默认 `12333`；虚拟库反代另有后台设置的监听端口。手机测试应连接本项目反代入口，不能直接连接上游。电脑与手机需互通，电脑局域网 IP 变更后要同步客户端地址。

真实上游仅在获授权的范围内用于诊断，默认使用临时数据库和本地 Emby 夹具。不要为测试启动生产会员停用或全库扫描任务。真实数据排查前先备份；不要把开发者自己的数据目录打入镜像。

本机 `.local/` 可保存临时启动器、截图和诊断日志，但它们不是公开运行入口，也不随镜像交付。不能把只存在于临时启动器中的修复当作正式产品改动。

## 3. 先取证，再修改

记录实际发现接口、父库范围、类型筛选、分页、排序、HTTP 状态、条目数量和耗时。只记录诊断所需的信息，不记录密码、Token、Cookie、完整授权头或带凭据的链接。

例如 SenPlayer 的首页作品查询会包含 `Series,Movie,Video,MusicVideo,MusicAlbum`。它不等同于明确请求分集：原逻辑先读取全部分集再筛掉，修复是在子项发现阶段沿用原类型筛选，而不是删除客户端条件。仍匹配条件的 Video、Episode 子项必须保留，最终播放状态等筛选不提前裁剪。

不要仅凭截图认定缺少 DTO 字段，也不要为了适配一个客户端而拦截所有根查询。日志未覆盖某类请求时，只能说明证据不足。发现了 GUID 别名等其他兼容缺口，也不能未经实际请求确认就宣称它是本次故障原因。

## 4. 实现、测试与验收

模块按职责拆分，单个代码文件原则上不超过 300 行。前端统一使用 pnpm。修复需要验证原来失败的行为，以及受影响的边界；避免只测试实现细节。

虚拟库聚焦回归示例：

```bash
pnpm exec vitest run apps/server/src/virtual-libraries
pnpm typecheck
pnpm lint
pnpm format:check
pnpm build
```

涉及管理 API、数据库或前端时，补充对应测试。CI 会运行完整检查，本地应按变更选择必要验证；只改文档时检查链接、命令及格式即可。

设备验收至少区分：首页、媒体库列表、库内电影、整部剧与分集、海报和实际播放。需要时低并发重放少量请求，核对内容 ID、耗时和错误；短期全部成功不代表长期稳定。

如已知偶发失败尚未复现，在文档和发布说明中保留限制。没有测试过的平台标记“待实机验证”，不要写成支持全部播放器。

## 5. 准备干净的发布源码

先检查 `git status`、文件清单和差异。不要在混有历史改动的工作区直接 `git add -A`。按本轮明确的文件路径暂存，包含新实现、新测试及相关文档；不要遗漏未跟踪文件。

本项目曾使用 `.local/publication/emby-task-center` 作为干净发布检出目录：将已审查文件按相对路径同步进去，对比内容并验证后，在该目录提交和构建。这个路径是本机做法，不是其他贡献者必须创建的目录。普通干净克隆可直接发布。

发布检出必须基于最新远端，检查是否有他人提交；不要强推或重置用户改动。缺失文件不能自动视为应删除，先确认。`.local`、真实环境配置、凭据、数据库、日志、截图、媒体样本和构建产物均不得暂存。

版本与文件准备：

1. 按 [版本规范](versioning.md) 递增根 `package.json`，修复用补丁版本，新功能用次版本。
2. 同步 Dockerfile 的默认 `BUILD_VERSION`，保持普通源码 Docker 构建可用；发行版本仍以根清单为准。
3. 同步版本文档、功能说明和测试范围；根 README 只添加稳定入口。
4. 提交审查过的源码，确认构建检出干净，记录提交 SHA。

不要改工作区子包版本来控制界面显示。不要覆盖已存在的固定 Git 标签或镜像标签。

## 6. 构建并验证待发布镜像

以下 PowerShell 命令在干净发布目录执行。`$releaseVersion` 来自本轮根清单，不能指向旧版本：

```powershell
$releaseVersion = (Get-Content package.json -Raw | ConvertFrom-Json).version
$releaseImage = "ghcr.io/hellohongyun/emby-task-center:$releaseVersion"
docker info
pnpm release:ghcr
powershell -NoProfile -ExecutionPolicy Bypass -File tests/docker-smoke.ps1 -Image $releaseImage
```

`release:ghcr` 默认只构建和核对平台、OCI 版本及镜像内 `public/version.json`，不上传。冒烟脚本使用临时数据和独立 Compose 项目，验证健康、页面、HTTP 登录、SQLite 持久化及文件系统边界，不调用真实 Emby。

Windows 测试端口被占用或被系统保留时，使用 `-Port` 指定确认可绑定的端口；不要停止不属于本轮测试的服务。失败后查清是环境、构建还是产品错误，修复后重新验证。

## 7. 推送与发布

推送经过审查的提交和本轮固定标签。下面命令假设当前分支已配置，发布标签尚不存在：

```powershell
git push origin HEAD
git tag $releaseVersion
git push origin $releaseVersion
gh run list --repo hellohongyun/emby-task-center --limit 1
# 确认该运行对应本轮提交，再等待完成：
gh run watch <run-id> --repo hellohongyun/emby-task-center --exit-status --interval 30
```

`<run-id>` 替换为实际编号。远端 CI 失败不能当作发布通过。源码也可以在构建前先推送以并行运行 CI，但镜像必须完成本轮验证后才发布。

Docker 需要已有 GHCR 写权限登录。凭据使用安全存储或 `--password-stdin`，不要放进命令参数、仓库或日志。上传刚才已验证的同一镜像：

```powershell
pnpm release:ghcr --skip-build --publish
```

脚本先核对固定版本不存在，再上传固定标签，最后从同一镜像更新 `latest`。如果检查远端标签时超时或鉴权失败，应停止排障，不能把它当作“版本不存在”。若固定标签已上传而 `latest` 更新失败，核对远端固定标签确为本轮摘要后，仅重试该摘要的 `latest` 更新，不重建或覆盖固定标签。

发布后必须确认：

- 固定标签与 `latest` 的**远端 manifest 摘要一致**，不能只比较本地标签。
- 匿名客户端能获取 manifest 和所需镜像层；私有包不会因为源码公开而自动公开。
- 前端实际版本、OCI 版本、固定镜像标签及 Git 发布标签一致。
- 创建固定 Git 标签对应的 GitHub Release，写清问题、行为、验证和剩余限制，不附凭据或本地数据。

远端核对可用 `docker buildx imagetools inspect` 分别查看两个标签；匿名验证需使用不带维护者登录凭据的临时配置或匿名 registry 请求，不能退出、覆盖维护者现有登录。

## 8. 服务器升级与交付

在原部署目录，按 [部署文档](deployment.md) 停服完整备份 `data`，再执行：

```bash
docker compose pull
docker compose up -d
docker compose ps
curl --fail http://127.0.0.1:12333/health
```

保留 Compose 同目录的 `./data`，不要重新初始化。生产使用 Host 网络，无需新增端口映射。仅 `restart` 不会拉取新镜像。

检查前端版本、管理员登录、原库和虚拟库、需要支持的客户端及播放。失败时按部署文档恢复匹配版本的数据快照和固定镜像，不假设新数据库能直接降级。

交付时分别报告“源码已推送”“镜像已发布”“服务器已升级”。没有实际登录服务器执行并验证，就只能报告镜像已发布并提供升级命令。

## 环境故障与特殊构建

| 现象 | 处理 |
| --- | --- |
| 找不到 Docker 引擎管道 | 启动 Docker Desktop，等待 `docker info` 成功，再构建 |
| Docker Hub 认证或基础镜像拉取超时 | 排查网络／DNS，检查本地缓存；不是应用测试失败 |
| Debian／npm 下载超时 | 保留构建日志，恢复网络后重试，不能因此跳过必要依赖 |
| 前端版本与 OCI 不一致 | 停止发布，检查根版本和本轮构建产物，不直接改标签掩盖问题 |
| 设备仍连接旧入口 | 确认客户端地址、实际运行版本和局域网 IP，再分析兼容性 |

`1.2.1` 曾因网络故障采用特殊构建：本机从相同源码重新构建前后端，基于已验证的 `1.2.0` 生产镜像继承 Linux 依赖，再覆盖应用产物与版本标签，完成容器验证后发布。这是已发生的应急路径，不是发布脚本的默认能力。

仅在生产依赖清单、锁文件、原生模块 ABI、运行时布局及数据库迁移均确认兼容时，才能考虑复用旧生产镜像；变化涉及这些部分时恢复完整构建。应急构建使用隔离目录，只放经过审查的服务端和前端产物，不复制 Windows `node_modules`、真实配置或数据。记录基础镜像摘要、源码 SHA、构建方式及验证结果，固定标签仍不可覆盖。正常网络下优先采用仓库 Dockerfile 完整构建。
