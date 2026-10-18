# Emby Task Center

面向个人 Emby 媒体库的自托管共享管理工具。将媒体库分享给朋友后，在一个后台管理账号、访问有效期、内容分类与使用情况，同时提供朋友可自助使用的网页门户。

**当前版本：1.0.1** · **许可证：MIT** · **部署镜像：`ghcr.io/hellohongyun/emby-task-center:latest`**

[GitHub 源码](https://github.com/hellohongyun/emby-task-center) · [GHCR 镜像](https://github.com/users/hellohongyun/packages/container/package/emby-task-center) · [部署指南](deploy/ghcr.md) · [贡献指南](CONTRIBUTING.md)

## 目录

- [项目背景](#项目背景)
- [谁使用这个项目](#谁使用这个项目)
- [核心功能](#核心功能)
- [工作方式与使用边界](#工作方式与使用边界)
- [Docker 快速部署](#docker-快速部署)
- [首次使用](#首次使用)
- [从源码运行](#从源码运行)
- [项目结构](#项目结构)
- [文档导航](#文档导航)
- [开源许可](#开源许可)

## 项目背景

这个项目源于一个简单的需求：自己整理的 Emby 媒体库，如果只有自己使用，总觉得有些可惜。希望把它分享给朋友，让已有内容得到更多利用。

共享之后，管理工作也随之增加：给朋友开通账号、处理密码和使用期限、说明库里有什么、查看播放情况，以及整理不同主题的媒体库。Emby Task Center 将这些工作集中到一个后台，并把能自助完成的操作交给使用者，减少逐个沟通和重复维护。

项目围绕个人媒体库与朋友共享的场景开发。界面中的“会员”指通过本服务管理的使用者；卡密用于兑换或延长访问期限。

## 谁使用这个项目

| 使用者 | 可以做什么 |
| --- | --- |
| 媒体库管理员 | 配置 Emby，管理使用者和卡密，组织虚拟媒体库，检查库存与缺集，查看在线会话及使用记录 |
| 使用媒体库的朋友 | 用邮箱验证码登录门户，浏览可用内容，查看访问有效期，兑换卡密，以及按已配置的账号流程管理 Emby 账号和密码 |

管理后台与会员门户使用各自的登录会话。Emby 客户端仍使用 Emby 账号登录；门户登录不会替代客户端鉴权。

## 核心功能

| 功能 | 具体用途 |
| --- | --- |
| 账号与访问期限 | 集中维护使用者、Emby 账号关联、启停状态和有效期；配置 Emby 集成后执行相应账号操作 |
| 卡密管理 | 生成和管理兑换卡密，让朋友自行兑换或延长访问期限，减少管理员手动调整 |
| 邮箱自助门户 | 通过邮箱验证码登录，查看个人状态、管理账号和邮件偏好；验证码及通知需要 SMTP 配置 |
| 虚拟媒体库 | 从 Emby 已有电影和整部剧中选片，组织主题库或分类库；不复制文件，同一内容可映射到多个虚拟库 |
| 媒体库存 | 同步 Emby 内容，以电影和整部剧展示海报，查看媒体库归属、来源、扫描状态和分集详情 |
| 缺集检测与任务看板 | 将当前选中的启用媒体库库存与 TMDB 已播信息比对，列出具体缺失集号和编号疑点；可登记作品并查看进度 |
| 在线会话与并发管理 | 查看 Emby 正在播放的内容、设备和播放状态，按已配置规则管理会员并发使用 |
| 使用记录与系统管理 | 按会员和时段查看累计使用情况，维护扫描调度、外部服务配置及运行、审计日志 |

前端适配桌面与手机。详细行为、统计口径和操作边界见 [功能说明](docs/features.md)。

## 工作方式与使用边界

项目使用 **Vue 3 + TypeScript**、**Node.js 24 + Express** 和 **SQLite**。Emby 提供媒体内容与会话信息，项目保存管理配置、库存、任务和使用记录。

```text
浏览器
  └─ Emby Task Center :12333
       ├─ /login    管理后台
       └─ /         会员门户

Emby 客户端（需要虚拟媒体库时）
  └─ 虚拟库反代 :8097（默认端口，需另行启用）
       └─ TgtoDrive 的 Emby 入口 / 原 Emby 服务
```

虚拟库只对相关浏览查询加入本地库和映射。普通请求、真实条目、播放链接、字幕及 WebSocket 继续交给上游处理；该反代入口不额外加入本项目的会员或并发限制。客户端继续使用原 Emby 凭据。

选片支持电影和整部剧，不单独选择季、分集；进入剧集后仍可浏览和播放原有分集。同 TMDB 的多个来源不会自动合并。后台移除映射只解除关联；客户端发起的真实媒体删除仍按上游权限执行。配置与兼容性验证范围见 [虚拟媒体库说明](docs/virtual-libraries.md)。

项目不下载媒体、不搬运文件，也不执行片源入库；媒体文件和 STRM 仍由现有流程维护，无需挂载媒体目录。缺集检测用于辅助整理，部分编号体系可能需要人工核对；页面中的真实媒体删除操作会调用 Emby，执行前需要明确确认。

## Docker 快速部署

推荐在 **Linux Docker Engine + Docker Compose** 环境运行，公开镜像当前支持 **`linux/amd64`**。下载仓库中的 [Compose 模板](deploy/compose.ghcr.yaml)：

```bash
mkdir -p /opt/emby-task-center/data
cd /opt/emby-task-center
curl -fL https://raw.githubusercontent.com/hellohongyun/emby-task-center/main/deploy/compose.ghcr.yaml -o compose.yaml
docker compose -f compose.yaml config
docker compose -f compose.yaml pull app
docker compose -f compose.yaml up -d --no-build app
curl --fail http://127.0.0.1:12333/health
```

模板使用 **Host 网络**，无需 `.env`，也不需要填写 `ports` 或 `PORT`。管理员与会员均支持 HTTP 直连登录。启动前确保宿主机对应端口可用。

| 入口 | 默认地址 | 说明 |
| --- | --- | --- |
| 管理后台 | `http://服务器IP:12333/login` | 配置系统和管理媒体库、账号 |
| 会员门户 | `http://服务器IP:12333/` | 供朋友浏览内容和自助管理 |
| Emby 客户端入口 | `http://服务器IP:8097` | 虚拟库反代，需在后台单独启用；不是管理网页端口 |

数据库和业务凭据保存在挂载的 `./data` 目录。升级前备份完整数据目录；迁移已有服务时保留原数据挂载和 Compose 项目名。其他网络方式、备份和回滚见 [部署与备份](docs/deployment.md)。

更新时保持镜像标签为 `latest`，执行：

```bash
docker compose -f compose.yaml pull app
docker compose -f compose.yaml up -d --no-build app
```

`latest` 指向最新正式镜像，前端显示该镜像的实际版本号。仅重启容器不会拉取新镜像，版本规则见 [版本命名与发布](docs/versioning.md)。

## 首次使用

开始前需要一个可访问的 **Emby 服务和 API Key**。其他集成按需配置：

| 集成 | 何时需要 |
| --- | --- |
| Emby | 内容查询、库存同步、账号和会话管理的基础连接 |
| TMDB | 作品匹配、已播元数据和缺集检测 |
| SMTP | 朋友通过邮箱验证码登录，以及发送账号、到期等通知 |
| TgtoDrive（TTD） | 已使用其 Emby 反代时，可将虚拟库反代上游接到该入口；也可直接接 Emby |

1. 打开管理后台，用初始账号 **`admin / admin123`** 登录，并修改管理员口令。
2. 在系统设置填写 Emby 地址和 API Key，确认连接可用，再按需求配置 TMDB、SMTP 等服务。
3. 在媒体库页面同步库存，选择需要启用的库；需要检查缺集时，先确认库存同步成功。
4. 配置使用者、账号关联和访问期限；配置 SMTP 后，朋友可通过邮箱验证码登录门户并自助操作。
5. 需要主题分类时，创建虚拟媒体库并选择已有作品，启用独立反代，再让客户端连接其端口。

账号流程见 [会员访问与账号恢复](docs/member-access.md)，虚拟库配置见 [虚拟媒体库](docs/virtual-libraries.md)。

## 从源码运行

需要 **Node.js 24** 与 Corepack，工作区固定使用 **pnpm 11.16.0**。

```bash
git clone https://github.com/hellohongyun/emby-task-center.git
cd emby-task-center
corepack enable
pnpm install --frozen-lockfile
pnpm build
pnpm start
```

本地启动器默认使用 **`3000`**，管理后台地址为 `http://localhost:3000/login`；Docker 镜像的原生默认端口为 **`12333`**。两者均可通过 `PORT` 覆盖。默认本地数据库为 `.local/emby-task-center.db`，首次启动自动执行迁移，业务配置通过后台维护。

常用检查命令：

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm build
```

贡献前阅读 [贡献指南](CONTRIBUTING.md)。浏览器测试、Docker 冒烟及环境要求见 [测试说明](tests/README.md)。

## 项目结构

```text
emby-task-center/
├─ apps/
│  ├─ web/                 Vue 管理后台、会员门户与移动端界面
│  └─ server/              Express API、后台调度与虚拟库反代
├─ packages/
│  ├─ contracts/           前后端接口契约与共享类型
│  ├─ database/            SQLite 表结构、迁移与数据访问
│  └─ task-domain/         任务与缺集领域逻辑
├─ deploy/                 GHCR 镜像部署模板与指南
├─ docs/                   功能规则、部署与运维说明
├─ scripts/                构建、启动、检查与发布脚本
└─ tests/                  浏览器流程与 Docker 冒烟测试
```

参考或移植虚拟媒体库功能时，可从以下路径开始，结合 [虚拟库文档](docs/virtual-libraries.md) 阅读：

| 路径 | 职责 |
| --- | --- |
| [apps/server/src/virtual-libraries/](apps/server/src/virtual-libraries/) | 查询、映射、身份恢复及反代核心逻辑，包含相关测试 |
| [apps/server/src/routes/virtual-libraries.ts](apps/server/src/routes/virtual-libraries.ts) | 虚拟库管理接口 |
| [apps/server/src/routes/virtual-library-proxy.ts](apps/server/src/routes/virtual-library-proxy.ts) | 反代配置与运行状态管理接口 |
| [apps/web/src/components/virtual-libraries/](apps/web/src/components/virtual-libraries/) | 选片、库内容和反代设置界面 |
| [packages/contracts/src/virtual-library.ts](packages/contracts/src/virtual-library.ts) | 虚拟库接口契约 |
| [packages/database/src/virtual-libraries-schema.ts](packages/database/src/virtual-libraries-schema.ts) | 虚拟库及关联表结构 |

虚拟库模块依赖项目中的配置、接口和数据库，不是复制单个目录即可运行的独立插件。

## 文档导航

| 分类 | 文档 |
| --- | --- |
| 功能与使用 | [功能总览](docs/features.md) · [虚拟媒体库](docs/virtual-libraries.md) · [会员访问](docs/member-access.md) · [卡密管理](docs/card-keys.md) |
| 会话与记录 | [并发管理](docs/concurrency-enforcement.md) · [会员使用记录](docs/member-usage-records.md) |
| 部署与维护 | [GHCR 部署](deploy/ghcr.md) · [部署与备份](docs/deployment.md) · [性能说明](docs/performance.md) · [故障排查](docs/runtime-diagnostics.md) |
| 开发与协作 | [贡献指南](CONTRIBUTING.md) · [测试说明](tests/README.md) · [版本规范](docs/versioning.md) · [安全问题报告](SECURITY.md) |

## 开源许可

本项目采用 [MIT 许可证](LICENSE)，允许在保留许可和版权声明的前提下使用、修改、分发及商业使用。

Emby、TMDB、TgtoDrive 等上游项目和服务保留各自的许可证、权限及使用条件；本项目的 MIT 许可不包含上游软件或媒体内容的授权。
