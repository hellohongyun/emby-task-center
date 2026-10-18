# Emby Task Center

把自建 Emby 媒体库分享给朋友的自托管管理面板：账号与有效期、卡密、邮件门户、虚拟媒体库、媒体库存、缺集检测、在线会话与使用记录，集中在一个后台。

[源码](https://github.com/hellohongyun/emby-task-center) · [镜像](https://github.com/users/hellohongyun/packages/container/package/emby-task-center) · [部署文档](docs/deployment.md) · [功能说明](docs/features.md)

## 快速部署

要求 **Linux amd64**，已安装 Docker Engine 与 Docker Compose。直接拉取公开镜像，不需要源码或 `.env`：

```bash
mkdir -p /opt/emby-task-center/data
cd /opt/emby-task-center
curl -fsSL https://raw.githubusercontent.com/hellohongyun/emby-task-center/main/compose.yaml -o compose.yaml
sudo chown -R 1000:1000 data
docker compose up -d
curl --fail http://127.0.0.1:12333/health
```

打开 `http://服务器IP:12333/login`，初始账号 **`admin`**，口令 **`admin123`**。登录后立即修改口令，再到系统设置填写 Emby 地址与 API Key。

| 入口 | 默认地址 | 说明 |
| --- | --- | --- |
| 管理后台 | `http://服务器IP:12333/login` | 配置系统、管理媒体库和账号 |
| 会员门户 | `http://服务器IP:12333/` | 朋友自助登录和查看内容 |
| Emby 虚拟库 | `http://服务器IP:8097` | 后台启用虚拟库反代后使用 |

Compose 使用 **Host 网络**，管理端口固定为 **12333**；数据固定存放在 **Compose 文件同目录的 `./data`**，与执行命令时所在目录无关。镜像以 UID `1000` 运行，首次创建目录后执行一次 `chown`；之后升级、重建容器都不需要重新初始化数据。

升级前先备份 `data/`，再执行：

```bash
docker compose pull
docker compose up -d
```

## 核心功能

| 功能 | 用途 |
| --- | --- |
| 账号与访问期限 | 维护会员、Emby 账号关联、启停状态和有效期 |
| 卡密 | 生成兑换卡密，让会员自行兑换或续期 |
| 邮件门户 | 邮箱验证码登录，查看状态、管理账号和邮件偏好 |
| 虚拟媒体库 | 从 Emby 已有电影和整部剧中选片，组织主题库，不复制文件 |
| 媒体库存 | 同步 Emby 电影和剧集，查看海报、来源、扫描状态和分集 |
| 缺集检测 | 对比 Emby 库存与 TMDB 已播信息，列出缺失集号 |
| 在线会话 | 查看播放中的内容、设备和状态，按规则限制并发 |
| 使用记录 | 按会员和时段查看使用情况、任务、审计与运行日志 |

前端适配桌面和手机，会员门户支持 PWA 安装。详细规则见 [功能说明](docs/features.md)。

## 使用边界

项目使用 **Vue 3 + TypeScript**、**Node.js 24 + Express** 和 **SQLite**。Emby 提供媒体内容和会话信息，项目保存配置、库存、任务与使用记录。

项目**不下载媒体、不搬运文件、不执行入库**，也不需要挂载媒体目录；媒体文件和 STRM 继续由现有流程维护。虚拟媒体库只对浏览查询加入本地映射，普通请求、播放链接和字幕仍交给上游 Emby，客户端继续使用原 Emby 账号。

## 首次配置

1. 在系统设置填写 Emby 地址和 API Key，确认连接可用。
2. 需要作品匹配和缺集检测时，配置 TMDB。
3. 需要邮箱验证码登录和通知时，配置 SMTP。
4. 在媒体库页面同步库存，启用需要的库。
5. 创建会员和卡密；需要主题分类时再创建虚拟媒体库并启用反代。

账号流程见 [会员访问](docs/member-access.md)，虚拟库见 [虚拟媒体库](docs/virtual-libraries.md)。

## 从源码运行

需要 **Node.js 24**、Corepack 和 **pnpm 11.16.0**：

```bash
git clone https://github.com/hellohongyun/emby-task-center.git
cd emby-task-center
corepack enable
pnpm install --frozen-lockfile
pnpm build
pnpm start
```

本地启动器默认监听 `3000`，管理后台为 `http://localhost:3000/login`，默认数据库在 `.local/emby-task-center.db`。常用检查：

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm build
```

需要自行构建镜像时使用根目录的 `compose.build.yaml`：

```bash
docker compose -f compose.build.yaml up -d --build
```

该模板使用桥接网络，只用于源码构建和隔离测试；公开部署始终使用根目录的 `compose.yaml`。

## 项目结构

```text
emby-task-center/
├─ apps/
│  ├─ web/                 Vue 管理后台、会员门户与移动端
│  └─ server/              Express API、调度与虚拟库反代
├─ packages/
│  ├─ contracts/           前后端接口契约
│  ├─ database/            SQLite 表结构、迁移与数据访问
│  └─ task-domain/         任务与缺集领域逻辑
├─ docs/                   功能、部署与运维文档
├─ scripts/                构建、启动、检查与发布脚本
├─ tests/                  浏览器流程与 Docker 冒烟测试
├─ compose.yaml            公开镜像部署
└─ compose.build.yaml      源码构建与隔离测试
```

## 文档

| 分类 | 文档 |
| --- | --- |
| 功能与使用 | [功能说明](docs/features.md) · [虚拟媒体库](docs/virtual-libraries.md) · [会员访问](docs/member-access.md) · [卡密](docs/card-keys.md) |
| 会话与记录 | [并发管理](docs/concurrency-enforcement.md) · [会员使用记录](docs/member-usage-records.md) |
| 部署与维护 | [部署、备份与升级](docs/deployment.md) · [性能](docs/performance.md) · [故障排查](docs/runtime-diagnostics.md) |
| 开发与协作 | [贡献指南](CONTRIBUTING.md) · [测试](tests/README.md) · [版本规范](docs/versioning.md) · [安全](SECURITY.md) |

## 许可

本项目采用 [MIT 许可证](LICENSE)。Emby、TMDB、TgtoDrive 等上游项目和服务保留各自的许可证与使用条件；本项目的 MIT 许可不包含上游软件或媒体内容的授权。
