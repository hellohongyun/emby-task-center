# Emby Task Center

自己的 Emby 媒体库只给自己看，总觉得有些浪费。这个项目把媒体库分享给朋友一起使用，并把会员、有效期、卡密、虚拟媒体库和在线会话收进一个后台，管理起来更省心。

[源码](https://github.com/hellohongyun/emby-task-center) · [镜像](https://github.com/users/hellohongyun/packages/container/package/emby-task-center) · [部署文档](docs/deployment.md)

## 部署

适用于 Linux `amd64`，需已安装 Docker Engine 与 Docker Compose。将以下内容保存为 `compose.yaml`：

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

打开 `http://服务器IP:12333/login`，初始账号 `admin`，口令 `admin123`。首次登录后请先修改口令，再到系统设置填写 Emby 地址和 API Key。

数据保存在 `compose.yaml` 同目录的 `./data`；管理端口为 `12333`，虚拟库反代默认使用 `8097`，可在后台启用。升级前备份 `data/`，然后执行 `docker compose pull && docker compose up -d`。

## 功能

- 管理会员、Emby 账号关联、启停状态和访问有效期
- 生成卡密，供会员兑换或续期
- 提供邮箱验证码登录的会员门户，支持自助管理账号
- 从已有电影和剧集中选片，组织虚拟媒体库，不复制文件
- 同步 Emby 库存，展示海报并检测缺集
- 查看在线会话、限制并发并保留使用记录

项目只通过 Emby API 读取媒体库信息，不下载或搬运媒体文件，也不需要挂载媒体目录。

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

[功能说明](docs/features.md) · [虚拟媒体库](docs/virtual-libraries.md) · [会员访问](docs/member-access.md) · [部署、备份与升级](docs/deployment.md) · [测试](tests/README.md) · [贡献指南](CONTRIBUTING.md)

## 许可

[MIT](LICENSE)
