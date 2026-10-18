# 部署入口

本目录只维护在线镜像部署：

| 文件 | 用途 |
| --- | --- |
| [compose.ghcr.yaml](compose.ghcr.yaml) | Linux 服务器使用公开 GHCR 镜像，不需要源码或 `.env` |
| [ghcr.md](ghcr.md) | 安装、已有服务迁移、升级与回滚步骤 |

需要自行构建源码时，使用仓库根目录的 [compose.yaml](../compose.yaml)。两种模板用途和网络不同，不应直接覆盖已有服务配置。

## 使用 GHCR 镜像（推荐）

将 `compose.ghcr.yaml` 复制到服务器应用目录，命名为 `compose.yaml`。在该目录运行：

```bash
mkdir -p data
docker compose -f compose.yaml config
docker compose -f compose.yaml pull app
docker compose -f compose.yaml up -d --no-build app
curl --fail http://127.0.0.1:12333/health
```

镜像为 `ghcr.io/hellohongyun/emby-task-center:latest`，支持 `linux/amd64`。模板使用 Host 网络，省略 `ports` 和 `PORT`，通过 `http://服务器IP:12333/login` 直接登录。首次管理员为 `admin / admin123`，登录后修改口令，再在系统设置配置 Emby、TMDB 和邮件。业务配置和数据均保存在挂载目录 `./data` 中。

启用虚拟媒体库反代后，Emby 客户端使用后台设置的独立端口（默认 `8097`），管理页面仍使用 `12333`。Host 网络直接使用宿主机端口，无需添加映射；启动前确认端口未被其他服务占用。普通请求与播放仍沿用上游，详见 [虚拟媒体库说明](../docs/virtual-libraries.md)。

## 更新与版本

升级前停止服务并备份实际数据目录，按 [部署与备份说明](../docs/deployment.md) 操作。保持原有 Compose 项目名和数据挂载，再执行：

```bash
docker compose -f compose.yaml pull app
docker compose -f compose.yaml up -d --no-build app
```

`latest` 指向最新正式版本，前端显示镜像的实际构建版本号。固定版本使用 `主版本.次版本.补丁版本`，从 `1.0.1` 开始；规范见 [版本命名与发布](../docs/versioning.md)。仅重启容器不会拉取新镜像。回滚须使用旧固定标签和升级前匹配的数据快照。

## 从源码构建

根目录 [compose.yaml](../compose.yaml) 具有 `build`，默认桥接网络，将容器 `3000` 发布到宿主机 `127.0.0.1:3000`，用于自行构建和测试：

```bash
# 在仓库根目录执行。
mkdir -p data
docker compose config --quiet
docker compose up -d --build app
curl --fail http://127.0.0.1:3000/health
```

根目录 [.env.example](../.env.example) 提供可选的端口、绑定地址、数据目录和时区配置。需要其他设备访问桥接服务时，设置 `APP_BIND_ADDRESS=0.0.0.0`。该模板显式使用容器 `PORT=3000`；镜像自身默认端口为 `12333`。不要把两种模板的端口说明混用。

## 离线部署与数据

不能访问镜像仓库时，可在构建机器导出固定版本镜像，在服务器校验后执行 `docker load -i <镜像归档>`；再将镜像模板的 `image` 改为导入的本地标签，以 `--no-build --pull never` 启动。仓库不包含历史镜像归档或实际数据，通用导出和升级命令见 [离线部署](../docs/deployment.md#离线部署把镜像传上服务器)。

数据目录包含 SQLite 与业务凭据，迁移和备份应保存完整目录。容器根文件系统只读，`/data` 和 `/tmp` 可写；健康检查为 `GET /health`，日志通过 `docker compose logs app` 查看。升级现有服务时保留原配置和实际挂载，避免误建空数据库。
