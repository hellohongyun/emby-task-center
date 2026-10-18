<div align="center">

# Emby Task Center

**把闲置的 Emby 媒体库，变成和朋友一起使用的共享片库。**

一个自托管的 Emby 分享管理面板：会员、有效期、卡密、邮箱门户、虚拟媒体库、库存缺集、在线会话与使用记录，集中在一个后台完成。

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Image](https://img.shields.io/badge/ghcr.io-emby--task--center-2496ED?logo=docker&logoColor=white)](https://github.com/users/hellohongyun/packages/container/package/emby-task-center)
[![Node](https://img.shields.io/badge/Node.js-24-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Platform](https://img.shields.io/badge/platform-linux%2Famd64-lightgrey)]()

[快速部署](#部署) · [功能](#功能) · [工作方式](#工作方式) · [文档](#文档) · [源码](https://github.com/hellohongyun/emby-task-center)

</div>

---

自己的 Emby 媒体库只给自己看，总觉得有些浪费。这个项目把媒体库分享给朋友一起使用，并把会员、有效期、卡密、虚拟媒体库和在线会话收进一个后台，管理起来更省心。

## 功能

### 会员与访问

| 功能 | 说明 |
| --- | --- |
| 会员管理 | 集中维护会员资料、Emby 账号关联、启停状态和备注，统一处理开户、改密、停用与删除。 |
| 访问有效期 | 设置到期时间，到期前发送提醒；配置 Emby 集成后，过期会员会自动停用对应账号。 |
| 卡密系统 | 批量生成、复制和删除卡密，会员可在门户自助兑换或续期，减少人工调整。 |
| 邮箱门户 | 会员使用邮箱验证码登录，查看有效期和账号状态，自助修改密码、兑换卡密和设置邮件偏好。 |

### 媒体库与内容

| 功能 | 说明 |
| --- | --- |
| 媒体库存 | 从 Emby 同步电影和剧集，展示海报、媒体库归属、来源、扫描状态和分集详情。 |
| 虚拟媒体库 | 从已有电影和整部剧中选片，组织主题库或分类库；不复制文件，同一内容可映射到多个虚拟库。 |
| 虚拟库反代 | 为 Emby 客户端提供独立的虚拟库入口，未映射的内容继续透传给上游 Emby，支持接 TgtoDrive。 |
| 缺集检测 | 对比 Emby 库存与 TMDB 已播信息，列出具体缺失集号和编号疑点，辅助整理剧集。 |
| 门户内容 | 会员门户提供热榜和影视库浏览，标注内容是否已在库，方便朋友发现可看的内容。 |

### 运营与监控

| 功能 | 说明 |
| --- | --- |
| 在线会话 | 查看正在播放的内容、设备和播放状态，按会员规则限制并发，支持冻结与解冻。 |
| 使用记录 | 按会员和时段查看累计观看情况，了解谁在使用、用了多少。 |
| 通知提醒 | 通过 SMTP 发送到期、账号和并发限制等邮件，减少逐个沟通。 |
| 系统管理 | 在后台维护 Emby、TMDB、SMTP、扫描调度、日志保留和登录安全等配置，统一保存到数据库。 |

## 工作方式

```text
浏览器
  └─ Emby Task Center :12333
       ├─ /login    管理后台
       └─ /         会员门户

Emby 客户端（可选）
  └─ 虚拟库反代 :8097
       └─ Emby / TgtoDrive
```

应用通过 Emby API 读取媒体库和会话信息，使用 SQLite 保存配置、库存、任务和使用记录。它不下载媒体、不搬运文件，也不需要挂载媒体目录；播放、字幕和 WebSocket 仍由上游 Emby 处理。

## 部署

**环境要求：** Linux `amd64`，Docker Engine 与 Docker Compose。

将以下内容保存为 `compose.yaml`：

```yaml
name: emby-task-center

services:
  app:
    image: ghcr.io/hellohongyun/emby-task-center:latest
    platform: linux/amd64
    network_mode: host
    init: true
    restart: unless-stopped
    stop_grace_period: 30s
    environment:
      TZ: Asia/Shanghai
    volumes:
      - ./data:/data
    read_only: true
    tmpfs:
      - /tmp:size=64m,mode=1777
    security_opt:
      - no-new-privileges:true
```

创建数据目录并启动：

```bash
mkdir -p data
sudo chown -R 1000:1000 data
docker compose up -d
```

首次启动后访问 `http://服务器IP:12333/login`，使用初始账号 `admin`、口令 `admin123` 登录。请先修改管理员口令，再到系统设置填写 Emby 地址和 API Key。

| 入口 | 地址 | 说明 |
| --- | --- | --- |
| 管理后台 | `http://服务器IP:12333/login` | 管理会员、媒体库、卡密和系统配置 |
| 会员门户 | `http://服务器IP:12333/` | 朋友登录、浏览内容和自助管理 |
| Emby 虚拟库 | `http://服务器IP:8097` | 在后台启用虚拟库反代后使用 |

数据保存在 `compose.yaml` 同目录的 `./data`，包含数据库、配置和密钥，请按敏感文件备份。升级前备份 `data/`，然后执行：

```bash
docker compose pull
docker compose up -d
```

## 从源码运行

本地开发需要 Node.js 24、Corepack 和 pnpm 11.16.0：

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm build
pnpm start
```

如需自行构建镜像，使用 `compose.build.yaml`：

```bash
docker compose -f compose.build.yaml up -d --build
```

## 文档

| 文档 | 内容 |
| --- | --- |
| [功能说明](docs/features.md) | 功能规则、统计口径和操作边界 |
| [部署、备份与升级](docs/deployment.md) | 安装、数据目录、备份恢复和版本回滚 |
| [虚拟媒体库](docs/virtual-libraries.md) | 选片、映射和 Emby 客户端接入 |
| [会员访问](docs/member-access.md) | 有效期、停用、冻结和账号恢复 |
| [测试说明](tests/README.md) | 单元测试、浏览器测试和 Docker 冒烟 |
| [贡献指南](CONTRIBUTING.md) | 开发环境、提交规范和检查命令 |

## 许可

本项目采用 [MIT 许可证](LICENSE)。Emby、TMDB、TgtoDrive 等上游项目和服务保留各自的许可证与使用条件。
