# GHCR 镜像部署

这是一份独立的在线镜像部署方案，使用 [compose.ghcr.yaml](compose.ghcr.yaml)，不需要源码或 `.env`。模板采用 Linux Host 网络，使用代码和镜像原生默认端口 `12333`，无需填写 `ports` 或 `environment.PORT`。模板使用 `ghcr.io/hellohongyun/emby-task-center:latest`，适用于 `linux/amd64`，直接通过 `http://服务器IP:12333` 访问并登录。镜像页面见 [GHCR 包](https://github.com/users/hellohongyun/packages/container/package/emby-task-center)，源码与 MIT 许可证见 [GitHub 项目](https://github.com/hellohongyun/emby-task-center)。

部署统一使用 `latest` 跟随最新正式版本。当前正式版本为 `1.0.1`，发布时固定标签 `1.0.1` 与 `latest` 指向同一镜像，前端显示实际构建版本 `1.0.1`，不会显示 `latest`。后续版本采用 `主版本.次版本.补丁版本`，见 [版本命名与发布规范](../docs/versioning.md)。

## 首次安装

将模板复制到服务器应用目录并命名为 `compose.yaml`，例如 `/opt/emby-task-center/compose.yaml`。直接在 YAML 中修改时区和数据挂载，无需配置端口或创建 `.env`。

```bash
cd /opt/emby-task-center
mkdir -p data
docker compose -f compose.yaml config
docker compose -f compose.yaml pull app
docker compose -f compose.yaml up -d --no-build app
docker compose -f compose.yaml ps
curl --fail http://127.0.0.1:12333/health
```

模板没有变量插值或 `env_file`，同目录已有 `.env` 中的部署变量不会覆盖 YAML 内的固定值。Compose 自身的 `COMPOSE_*` 控制变量仍需注意；命令显式指定 `-f`，已有部署还需保留原项目名 `-p`。

`network_mode: host` 使服务直接监听宿主机 `12333`，Compose 不设置 `ports` 或 `environment.PORT`；代码默认值与镜像默认值均为 `12333`。此模式面向 Linux 服务器，启动前确认端口未被占用，宿主机允许访问该端口。管理员和会员均支持 HTTP 直连登录。首次安装访问 `http://服务器IP:12333/login`，使用管理员 `admin / admin123` 登录，随后在后台修改口令并配置 Emby、TMDB 和邮件。业务设置保存在数据库，不需要写入 Compose。

需要 Emby 虚拟媒体库反代时，在后台启用并设置未占用的监听端口（默认 `8097`）；Host 网络下直接使用宿主机该端口，不需要添加端口映射。客户端连接此反代端口，它与管理页面的 `12333` 端口用途不同，详见 [虚拟媒体库](../docs/virtual-libraries.md)。

## 已有服务迁移与更新

不要直接用新模板覆盖已有服务配置。先确认旧服务的 Compose 项目名、实际 `/data` 挂载目录、端口和代理设置；将旧部署值逐项写进 YAML，数据源继续指向原目录。相对 `./data` 是相对于 Compose 文件所在目录，换目录使用时必须核实绝对路径，避免误建空库。

只更新镜像时，原有显式 `PORT: "3000"` 和端口映射仍继续生效。要迁移到本模板的 Host 网络与原生 `12333`，将 `services.app.network_mode` 设为 `host`，删除整个 `ports` 段及 `environment.PORT` 项，并确认管理、虚拟库反代端口均未冲突；随后通过 `http://服务器IP:12333` 访问。原配置仍依赖变量时，可以继续保留 `.env`；需要完全移除依赖时，再把所有变量插值改成原来的实际值，先运行 `docker compose config` 核对。无须删除现有 `.env` 才能使用 GHCR。

升级前停止服务并备份完整实际数据目录，按 [部署与备份说明](../docs/deployment.md) 操作。保留原来的 `-p` 和全部 `-f` 参数；如果旧服务带有源码 `build`，下面的 `--no-build` 可确保使用所拉取的镜像。

```bash
# 按既有部署补齐 -p 和 -f 参数。
docker compose -f compose.yaml pull app
docker compose -f compose.yaml up -d --no-build app
docker compose -f compose.yaml ps
curl --fail http://127.0.0.1:12333/health
```

后续发布新版本时，保留 `image: ghcr.io/hellohongyun/emby-task-center:latest`，执行上述 `pull` 和 `up`，无需修改标签。仅执行 `restart` 不会更新镜像；更新后在前端核对实际版本号。公开镜像可免登录拉取；若仍提示权限不足，应先确认包已发布且可见性为 Public。回滚时明确改为旧固定版本标签，并恢复升级前完整数据快照，新版数据库不保证能直接交给旧版镜像使用。
