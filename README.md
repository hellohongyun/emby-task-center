# Emby Task Center

面向 Emby 的自托管管理后台与会员门户：组织虚拟媒体库，浏览电影和整部剧，检测缺集，管理会员、卡密与播放使用记录。前端适配桌面和手机。

当前正式版本：**1.0.1**。源代码采用 [MIT 许可证](LICENSE)。

- [GitHub 源码](https://github.com/hellohongyun/emby-task-center)
- [GHCR 镜像](https://github.com/users/hellohongyun/packages/container/package/emby-task-center)：`ghcr.io/hellohongyun/emby-task-center:latest`
- 管理后台：`/login`；会员门户：`/`

## 主要功能

| 功能 | 内容 |
| --- | --- |
| 虚拟媒体库 | 创建电影、剧集或混合库，将 Emby 已有电影和整部剧映射进去；客户端通过独立反代入口浏览，保留原季、分集和播放能力 |
| 媒体库存 | 从 Emby 同步库存，按电影和整部剧展示海报，查看来源、扫描状态与分集详情 |
| 缺集与任务 | 使用 TMDB 已播元数据比对库存，按当前选中的启用媒体库独立检测缺集，显示具体季集与编号疑点 |
| 会员与卡密 | 会员邮箱验证码登录、卡密兑换续费、Emby 账号关联与改密、会员到期及邮件提醒 |
| 播放与使用记录 | 查看 Emby 在线会话，配置会员并发规则，按会员和时段查看累计使用记录 |
| 系统管理 | 在后台维护 Emby、TMDB、SMTP、扫描调度和登录设置，查看运行及审计日志 |

## 工作方式与边界

应用使用 **Vue 3 + TypeScript** 前端、**Node.js 24 + Express** 服务端和 **SQLite** 数据库。Emby 提供媒体库存、资料及播放会话，TMDB 提供作品和已播分集元数据，SMTP 提供验证码及通知邮件。配置、库存、任务、会员和历史记录持久化到 SQLite。

应用不下载媒体、不搬运文件，也不执行片源入库；片源处理由现有外部流程完成，无需挂载 STRM 或媒体目录。会员开户、改密、停启和并发管理等操作，在配置相应功能后会调用 Emby 接口。缺集页面的真实媒体删除须明确确认，其行为由 Emby 执行。

虚拟媒体库可接在 TgtoDrive（TTD）的 Emby 反代之前，也可直接连接 Emby：

```text
Emby 客户端 → 本服务虚拟库反代（默认 :8097）→ TgtoDrive / Emby
浏览器      → 管理后台与会员门户（:12333）
```

虚拟库层仅对相关浏览查询加入本地虚拟库和映射；普通请求、真实条目、播放链接、字幕和 WebSocket 沿用上游转发，不在此入口额外加入会员或并发限制，也不替代原服务器鉴权。客户端继续使用原 Emby 账号。**后台移除映射只解除关联；客户端删除真实媒体仍会转发到 Emby，按上游权限执行真实删除。**

选片只接受电影和整部剧，不单独选择季或分集；进入整部剧后仍可查看季、分集。同 TMDB 的多个来源不会自动合并。完整规则及目标客户端验证范围见 [虚拟媒体库说明](docs/virtual-libraries.md)。

## Docker 快速开始（推荐）

需要 Linux Docker Engine 与 Compose，当前公开镜像支持 `linux/amd64`。下载或从仓库复制 [deploy/compose.ghcr.yaml](deploy/compose.ghcr.yaml) 到服务器应用目录，命名为 `compose.yaml`：

```bash
mkdir -p /opt/emby-task-center/data
cd /opt/emby-task-center
# 将 deploy/compose.ghcr.yaml 保存为当前目录的 compose.yaml。
docker compose -f compose.yaml config
docker compose -f compose.yaml pull app
docker compose -f compose.yaml up -d --no-build app
curl --fail http://127.0.0.1:12333/health
```

模板使用 **Host 网络**，不配置 `ports` 或 `PORT`，不需要 `.env`。访问 `http://服务器IP:12333/login`，首次管理员为 **admin / admin123**，登录后修改口令，在系统设置填写 Emby 地址、API Key、TMDB Token 和所需邮件配置。支持 HTTP 直连登录。

虚拟媒体库需在后台另行启用反代，默认监听 `8097`；Emby 客户端连接此端口，管理网页仍使用 `12333`。Host 网络下直接使用宿主机端口，启动前确认端口可用。Docker Desktop 或其他网络方式请按实际环境调整，详见 [部署说明](docs/deployment.md)。

`./data` 挂载至 `/data`，包含数据库与业务凭据。升级前备份实际数据目录；迁移现有服务时保留原项目名和数据挂载，避免误建空库。[GHCR 部署指南](deploy/ghcr.md) 包含完整安装、升级与回滚步骤。

日常更新保持镜像标签为 `latest`：

```bash
docker compose -f compose.yaml pull app
docker compose -f compose.yaml up -d --no-build app
```

`latest` 与当前正式固定版本指向同一镜像，前端显示实际构建版本号。仅重启容器不会拉取新版。[版本规范](docs/versioning.md) 说明版本递增与发布流程。

## 从源码运行

需要 Node.js 24 与 Corepack；仓库固定使用 pnpm 11.16.0。

```bash
git clone https://github.com/hellohongyun/emby-task-center.git
cd emby-task-center
corepack enable
pnpm install --frozen-lockfile
pnpm build
pnpm start
```

`pnpm start` 构建后以生产模式启动，本地启动器默认使用 `3000` 端口，可通过 `PORT` 覆盖；镜像直接启动服务的默认端口为 `12333`。默认数据库为被忽略的 `.local/emby-task-center.db`，首次启动自动迁移。业务配置在后台维护，启动器可读取未跟踪的 `.env`。源码 Docker 桥接模板的构建、绑定地址与端口配置见 [部署说明](docs/deployment.md)。

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm build
```

浏览器流程和 Docker 冒烟需要相应运行环境，命令及隔离范围见 [测试说明](tests/README.md)。贡献代码前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 目录与文档

```text
apps/web/                      Vue 管理后台与会员门户
apps/server/                   Express API、后台调度与虚拟库反代
packages/contracts/            接口契约与共享类型
packages/database/             SQLite 表结构、迁移与数据访问
packages/task-domain/          任务与缺集领域逻辑
deploy/                        GHCR 和其他部署模板
docs/                          功能、部署与运维文档
tests/                         浏览器流程与 Docker 冒烟
```

- [功能与使用边界](docs/features.md)
- [虚拟媒体库与 Emby 反代入口](docs/virtual-libraries.md)
- [Docker 部署与备份](docs/deployment.md)
- [GHCR 镜像部署](deploy/ghcr.md)
- [版本命名与镜像发布](docs/versioning.md)
- [扫描、加载与性能](docs/performance.md)
- [运行故障排查](docs/runtime-diagnostics.md)
- [会员访问与账号恢复](docs/member-access.md)
- [卡密管理与兑换](docs/card-keys.md)
- [会员使用记录](docs/member-usage-records.md)
- [并发播放限制](docs/concurrency-enforcement.md)

Emby、TMDB、TgtoDrive 等上游项目和服务保留各自的许可证、权限及使用条件，本项目的 MIT 许可不覆盖它们。
