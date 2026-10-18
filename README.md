# Emby Task Center

自托管的 Emby 分享管理面板：会员与有效期、卡密、邮箱门户、虚拟媒体库、媒体库存、缺集检测、在线会话和使用记录。

[源码](https://github.com/hellohongyun/emby-task-center) · [镜像](https://github.com/users/hellohongyun/packages/container/package/emby-task-center) · [部署文档](docs/deployment.md)

## 部署

Linux `amd64`，已安装 Docker Engine 与 Docker Compose。将下面内容保存为 `compose.yaml`：

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

首次启动：

```bash
mkdir -p data
sudo chown -R 1000:1000 data
docker compose up -d
```

打开 `http://服务器IP:12333/login`，初始账号 `admin`，口令 `admin123`。登录后先修改口令，再在系统设置填写 Emby 地址和 API Key。

数据保存在 Compose 同目录的 `./data`。管理端口为 `12333`；虚拟库反代默认 `8097`，在后台启用。升级执行 `docker compose pull && docker compose up -d`，升级前备份 `data/`。

## 功能

- 会员、Emby 账号关联、启停状态和访问有效期
- 卡密生成、兑换和续期
- 邮箱验证码门户，会员自助管理账号
- 虚拟媒体库：从已有电影和剧集中选片，不复制文件
- Emby 库存同步、海报展示和缺集检测
- 在线会话、并发限制和使用记录

项目只读取 Emby API，不下载媒体、不搬运文件，也不需要挂载媒体目录。

## 从源码运行

需要 Node.js 24、Corepack 和 pnpm 11.16.0：

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm build
pnpm start
```

自行构建镜像使用 `compose.build.yaml`：

```bash
docker compose -f compose.build.yaml up -d --build
```

## 文档

[功能说明](docs/features.md) · [虚拟媒体库](docs/virtual-libraries.md) · [会员访问](docs/member-access.md) · [部署、备份与升级](docs/deployment.md) · [测试](tests/README.md) · [贡献指南](CONTRIBUTING.md)

## 许可

[MIT](LICENSE)
