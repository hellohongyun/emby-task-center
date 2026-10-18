# 部署、备份与升级

生产部署使用仓库根目录的 [compose.yaml](../compose.yaml)：Linux `amd64` 上直接拉取公开镜像 `ghcr.io/hellohongyun/emby-task-center:latest`，不需要源码、`.env` 或端口映射。

## 安装

```bash
mkdir -p /opt/emby-task-center/data
cd /opt/emby-task-center
curl -fsSL https://raw.githubusercontent.com/hellohongyun/emby-task-center/main/compose.yaml -o compose.yaml
sudo chown -R 1000:1000 data
docker compose up -d
curl --fail http://127.0.0.1:12333/health
```

Compose 使用 **Host 网络**，应用直接监听宿主机 **12333**。镜像以 UID `1000` 运行，所以首次创建 `data/` 后要执行一次 `chown`；以后升级或重建容器都不需要重新初始化。启动前确认 `12333`（以及启用虚拟库后的 `8097`）没有被其他服务占用，并在防火墙或安全组中放行需要访问的端口。

数据目录固定为 **Compose 文件同目录的 `./data`**。相对路径由 Compose 按文件所在目录解析，从其他目录执行命令也不会改变位置：

```text
/opt/emby-task-center/
├─ compose.yaml
└─ data/
   └─ emby-task-center.db
```

`data/` 包含 SQLite 数据库、后台配置、密钥、日志和业务数据，应按敏感文件保存。迁移服务器时复制整个目录即可；不要把 `data/` 放进公开仓库。

## 首次登录

打开 `http://服务器IP:12333/login`，使用初始管理员 **`admin` / `admin123`** 登录，并立即在系统中修改口令。然后在系统设置填写 Emby 地址与 API Key，按需配置 TMDB、SMTP 等服务。

会员门户为 `http://服务器IP:12333/`，使用邮箱验证码登录，需要先配置 SMTP。Emby 客户端仍使用原 Emby 账号。

虚拟媒体库的反代入口默认端口为 `8097`，默认未启用。启用后 Host 网络会直接监听该端口，无需修改 Compose；如果改成其他端口，需同步确认防火墙放行。

## 备份与恢复

停止应用后完整备份数据目录，再启动：

```bash
mkdir -p backups
docker compose stop -t 30
tar -C data -cpf "backups/emby-task-center-$(date +%Y%m%d-%H%M%S).data.tar" .
docker compose start
```

恢复时先保留当前数据，再解压备份，并重新设置目录所有者：

```bash
docker compose stop -t 30
mv data "backups/data-before-restore-$(date +%Y%m%d-%H%M%S)"
mkdir data
tar -xpf backups/emby-task-center-YYYYMMDD-HHMMSS.data.tar -C data
sudo chown -R 1000:1000 data
docker compose start
```

恢复后确认登录、会员和任务数据正常，再删除旧备份。

## 升级与回滚

升级前先备份 `data/`：

```bash
docker compose pull
docker compose up -d
docker compose ps
curl --fail http://127.0.0.1:12333/health
```

`latest` 指向最新正式镜像，前端会显示实际版本号。只执行 `restart` 不会拉取新镜像。

需要固定版本或回滚时，把 `compose.yaml` 中的镜像改为明确的版本标签，例如 `1.0.1`，再执行 `docker compose up -d`；回滚同时恢复与该版本匹配的数据快照。新版数据库不保证能被旧镜像直接读取。

## 源码运行

需要 **Node.js 24**、Corepack 和 **pnpm 11.16.0**：

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm build
pnpm start
```

本地启动器默认监听 `3000`，数据库位于 `.local/emby-task-center.db`。业务配置在后台维护。

## 源码构建镜像

源码构建和隔离测试使用 [compose.build.yaml](../compose.build.yaml)：

```bash
docker compose -f compose.build.yaml up -d --build
```

该模板使用桥接网络，默认发布到 `127.0.0.1:3000`，通过 `.env` 可调整绑定地址、端口和数据目录，变量说明见 [.env.example](../.env.example)。它不用于公开镜像部署。

## 运行与排查

- 应用容器根文件系统只读，只有 `/data` 和 `/tmp` 可写。
- 健康检查：`curl --fail http://127.0.0.1:12333/health`。
- 容器状态：`docker compose ps`；日志：`docker compose logs --tail=200 -f app`。
- 停止时先停止后台任务，再等待请求收尾；`stop_grace_period` 为 30 秒。
- 管理后台和会员门户支持 HTTP 直连。PWA 安装需要 HTTPS（浏览器安全上下文），可在应用前配置反向代理。

反向代理只需把域名转发到 `127.0.0.1:12333`；应用不依赖转发头识别来源地址，登录限流使用直接连接 IP。启用 HTTPS 后，按代理软件文档配置证书和 WebSocket 转发。

## 测试

Docker 冒烟测试使用 `compose.build.yaml` 构建临时镜像，验证健康检查、SPA、SQLite 持久化、只读根文件系统和可写数据目录：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tests/docker-smoke.ps1
```

没有 Docker daemon 时脚本只做静态检查并返回退出码 2，不能算容器验证通过。其他测试见 [测试说明](../tests/README.md)。
