# Docker 部署

本页 [根目录源码 Compose](../compose.yaml) 使用桥接网络、显式 `PORT=3000`，用于自行构建。无需源码或 `.env` 的 [GHCR 独立模板](../deploy/ghcr.md) 面向 Linux 服务器，只设置 Host 网络，Compose 不填写端口，使用代码和镜像原生默认管理端口 `12333`。

GHCR 部署统一使用 `ghcr.io/hellohongyun/emby-task-center:latest`，通过 `docker compose pull app` 和 `docker compose up -d --no-build app` 更新。正式版本从 `1.0.1` 开始使用 `主版本.次版本.补丁版本`；前端版本与镜像固定版本标签、OCI 版本标签一致，`latest` 只是指向最新正式版本的移动标签。版本来源与发布检查见 [版本规范](versioning.md)。

虚拟媒体库另外使用可配置的 Emby 反代端口（默认 `8097`），默认未启用。桥接网络启用时需增加与后台监听端口一致的映射后重建容器；GHCR Host 网络直接使用宿主机端口，不配置 `ports`。上游应填写 TgtoDrive 的 Emby 反代入口，配置和客户端连接说明见 [虚拟媒体库](virtual-libraries.md)。

## 运行模型

`compose.yaml` 启动一个 `app` 服务。Node 24 Debian-slim 镜像以非特权 `node` 用户运行，提供 `/health`、`/api` 和编译后的 Vue 前端，并在启动时执行 Drizzle 迁移。代码默认端口与镜像默认 `PORT` 均为 `12333`，镜像声明 `EXPOSE 12333`；可通过 `PORT` 覆盖，`EXPOSE` 本身不会发布端口。源码 Compose 显式设置 `PORT=3000`，原有 `3000` 映射继续有效；GHCR 独立模板使用 Host 网络，省略 `ports` 与 `environment.PORT`，直接采用原生默认端口。容器根文件系统只读；只有 `/data` 和 `/tmp` 可写。媒体库直接读 Emby API，不需要挂载片源目录。

本地 `pnpm start` 默认使用 `.local/emby-task-center.db`、`packages/database/drizzle` 和 `apps/web/dist`。Node 监听没有指定主机名，不能视为仅绑定回环；Docker 的回环访问限制来自 Compose 的宿主端口发布配置。

服务端构建产出 `dist/server/index.mjs`、`dist/server/scan-worker.mjs`、`dist/server/public-library-worker.mjs`、`dist/server/missing-scan-worker.mjs` 和 `dist/server/missing-root-worker.mjs`，部署时须保留整个目录。扫描匹配与差量持久化、门户影视库列表查询、缺集检测的数据准备、当前媒体库的缺集计算分别在 worker 线程运行，使用同一 SQLite 文件，不在 worker 内运行迁移；列表与缺集数据 worker 只读业务数据。Dockerfile 已复制整个服务端产物目录。性能行为及验证边界见 [性能说明](performance.md)。

管理员与会员使用用途隔离的 v2 会话签名。升级到此格式后，旧版管理员、会员 Cookie 都会失效，所有人需重新登录；无需修改数据库内的会话密钥或部署变量。

收到首次 `SIGTERM` 或 `SIGINT` 后立即停止后台任务调度，再等待 HTTP 请求排空与资源关闭。应用收尾预算为 25 秒，Compose 的 `stop_grace_period` 为 30 秒；超过预算、清理失败或再次收到退出信号时以非零状态退出。停止调度不会回滚已经开始的远端写操作，也不承诺所有后台上游操作都已完成。应用计时器无法抢占同步阻塞的主线程，Docker 外层停止宽限仍用于限制这种情况。

未捕获的同步异常或未处理的 Promise 拒绝记录为致命错误，并立即以退出码 1 退出，不再假设进程可以安全继续服务。普通已捕获的请求、上游网络错误仍按原逻辑处理。Compose 的 `restart: unless-stopped` 用于异常退出后的重启，人工停止容器后不会自动恢复；本地 `pnpm start` 需要另行配置服务管理器。此策略遵循 [Node.js 对未捕获异常的说明](https://nodejs.org/docs/latest-v24.x/api/process.html#warning-using-uncaughtexception-correctly)。

SQLite 是位于 `/data/emby-task-center.db` 的进程内数据库，`/data` 对应 Compose 文件同目录下的 `./data` 文件夹（可用 `.env` 的 `DATA_PATH` 覆盖），因此整个数据目录可以直接迁移。Compose 默认把应用端口发布在 `127.0.0.1` 上，不发布数据库端口，也不包含任何凭据值。业务配置（含 TMDB / SMTP / Emby 凭据）保存在 `/data` 内的 SQLite `app_settings` 表，启动后到「管理员后台 → 系统设置」页维护，因此**数据库文件要按敏感文件对待**。Docker 会递归排除构建上下文中的 `.env*` 文件（占位用的 `.env.example` 除外），因此嵌套的前端环境文件不会被编译进 SPA。

## 配置：环境变量只剩部署项

业务配置保存在数据库 `app_settings` 表：TMDB 凭据、Emby、SMTP、资源检索、媒体库扫描、日志保留、会话与登录安全、缺集宽限期（`library.missingGraceHours`）等在「管理员后台 → 系统设置」维护。保存结果会指出需要重启才生效的项，其他设置按实际运行时读取方式生效。

环境变量现在只剩三类，界限很清楚：

**① 启动引导（bootstrap）：必须在"打开数据库之前"就有值，因此只能来自 env。**

| 变量 | 谁在设 | 说明 |
| --- | --- | --- |
| `DATABASE_PATH` | compose 固定 `/data/emby-task-center.db` | 库文件在哪——鸡生蛋问题，不可能存进库里 |
| `MIGRATIONS_PATH` | 默认镜像内 `/app/drizzle` | 迁移脚本目录（容器里已内置） |
| `WEB_DIST_PATH` | compose 固定 `/app/public` | 前端产物目录 |
| `PORT` | 源码 Compose 显式为 `3000`；GHCR 模板不填写，采用代码及镜像默认 `12333` | 原生监听端口；桥接映射的容器端口须与其一致 |
| `NODE_ENV` | compose 固定 `production` | 生产运行模式 |

**② compose 自己的变量：应用根本不读，是 Docker 用来发布端口/挂载卷/设容器时区的。**

`APP_PORT`（宿主机端口）、`APP_BIND_ADDRESS`（发布到哪个地址）、`DATA_PATH`（宿主数据目录）、`TZ`（进程时区，影响"今日更新"的日期判定与日志时间）。

**③ 业务配置 = 数据库唯一权威（系统设置页）。**

注册表部分设置带 env 名（如 `TMDB_TOKEN`、`EMBY_*`、`SMTP_*`、`PANSOU_*`、`LIBRARY_*`、`SESSION_VALIDITY_DAYS`、`MISSING_GRACE_HOURS`），用于**老版本部署的迁移种子**：启动时仅在库里缺少对应键时导入，已有数据库值不覆盖。之后以数据库为准，全新部署可直接在页面填写。

> 已经确认失效、写了也不读的历史键：`SHARED_PASSWORD`、`SESSION_SECRET`（管理员口令走数据库、首启 `admin/admin123`；会话密钥自动生成）、`MEDIA_ROOTS_JSON`、`STRM_PATH`、`LIBRARY_BACKEND`、`EMBY_PROXY_*`（媒体库信息源固定为 Emby）、`TG_API_ID`/`TG_API_HASH`/`TG_SESSION`/`TGTO_BOT_USERNAME`/`TGTO_INGEST_*`、`PANSOU_MAGNET_TARGET`。

**从旧版本升级**：原有的 `.env` 配置会在首次启动时作为种子导入数据库（已有值不覆盖），旧配置表（`concurrency_policy_settings`、`submission_settings`、`notify_retention_settings`、`mail_default_settings`）一并导入；确认后台页里数值正确后，即可删掉这些环境变量，`.env` 只留上面 ①② 里的部署项。

源码 Compose 显式控制 `NODE_ENV`、`PORT`、`DATABASE_PATH`、`WEB_DIST_PATH`；GHCR Host 模板省略 `PORT`，使用代码和镜像原生默认 `12333`。媒体库不再需要任何挂载或根目录配置。

**媒体库以 Emby 为唯一信息源**：媒体库分组、库存、海报、题材与入库时间来自 Emby API（`/Library/VirtualFolders` 与 `/Items`）；TMDB 补充已播分集元数据。本应用同步已有库存和进度，片源下载、转存与 Emby 入库由外部流程管理。资源检索不等于自动入库，应用不派发 AI 或 worker 入库任务。媒体库增删会在下次同步时跟随，消失的库根停用并保留历史库存。邮件用于会员登录、开户、到期与并发限制等账号通知。

媒体内容删除只通过缺集总览的显式确认执行，范围限制为当前选中的启用媒体库。会员开户、改密、账号停启、删除和并发策略也会调用 Emby 写接口，详见 [功能与使用边界](features.md)。

用密码管理器生成密钥，或在装有 OpenSSL 的系统上执行：

```bash
openssl rand -base64 36
```

## 离线部署：把镜像传上服务器

服务器不能访问镜像仓库时，使用 `docker save` 导出的镜像归档。归档使用独立版本标签，放在被忽略的 `release/` 目录；仓库不保存镜像二进制文件。

```bash
# 构建机器：以 linux/amd64 服务器为例，从唯一版本来源读取。
VERSION="$(node -p "require('./package.json').version")"
mkdir -p "release/$VERSION"
docker buildx build --platform linux/amd64 --provenance=false --sbom=false \
  --build-arg "BUILD_VERSION=$VERSION" -t "emby-task-center:$VERSION" --load .
docker save -o "release/$VERSION/emby-task-center-$VERSION.tar" "emby-task-center:$VERSION"
cd "release/$VERSION"
sha256sum "emby-task-center-$VERSION.tar" > checksums.txt
```

上传归档、校验文件和更新说明后，**在服务器现有部署目录中升级**。不要用新包的模板覆盖现有 `.env`、Compose 或数据目录。以下示例假定现有文件名为 `compose.yaml`、服务名为 `app`；若原部署使用 `docker-compose.yml`、`-p`、`--env-file` 或多个 `-f`，请保留原来的文件、项目名和参数，只在最后增加镜像覆盖文件。

```bash
VERSION="1.0.1" # 替换为归档对应的固定版本
COMPOSE_FILE=compose.yaml
sha256sum -c checksums.txt || exit 1
docker load -i "emby-task-center-$VERSION.tar" || exit 1
docker image inspect "emby-task-center:$VERSION" --format '{{.Os}}/{{.Architecture}}'

# 仅覆盖镜像，不改现有端口、环境变量、数据挂载或虚拟库反代端口。
cat > compose.image.yaml <<EOF
services:
  app:
    image: emby-task-center:$VERSION
EOF
docker compose -f "$COMPOSE_FILE" -f compose.image.yaml config --quiet || exit 1

# 从现有容器读取实际 /data 挂载，避免把默认 ./data 当成真正的数据目录。
CONTAINER_ID="$(docker compose -f "$COMPOSE_FILE" ps -aq app)"
test -n "$CONTAINER_ID" || exit 1
DATA_DIR="$(docker inspect "$CONTAINER_ID" --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Source}}{{end}}{{end}}')"
test -n "$DATA_DIR" && test -d "$DATA_DIR" || exit 1
mkdir -p backups
docker compose -f "$COMPOSE_FILE" stop -t 30 app || exit 1
tar -C "$DATA_DIR" -cpf "./backups/emby-task-center-$(date +%Y%m%d-%H%M%S).data.tar" . || exit 1

# 使用刚导入的本地镜像，禁止重新构建或尝试从仓库拉取。
docker compose -f "$COMPOSE_FILE" -f compose.image.yaml up -d --no-build --pull never app
docker compose -f "$COMPOSE_FILE" -f compose.image.yaml ps
docker compose -f "$COMPOSE_FILE" -f compose.image.yaml logs --tail=100 app
# 按现有 APP_PORT 和访问地址检查，例如：
curl --fail http://127.0.0.1:3000/health
```

备份命令失败时先处理备份问题，再运行升级命令。数据备份归档包含业务凭据，应按敏感文件保存；不要上传到公开位置。后续重建和启动时继续带上 `-f compose.image.yaml`，否则 Compose 会重新使用原文件中的镜像标签。容器在新镜像启动时自动执行数据库迁移，回滚需同时恢复升级前的数据快照，不能假定新数据库可直接供旧镜像使用。

新服务器首次离线部署可复制 [镜像模板](../deploy/compose.ghcr.yaml)，将 `image` 改为已导入的本地固定标签，再执行 `docker compose up -d --no-build --pull never app`；不需要 `.env`。现有服务升级不执行初始化步骤。几个容易踩的点：

- **优先使用 `.tar`**：上传后直接 `docker load -i` 导入，保持文件名与校验记录一致。
- **架构要对**：`docker image inspect <镜像> --format '{{.Architecture}}'`。x86 机器上构建出来的是 `amd64`；ARM 服务器（Oracle Ampere、Hetzner CAX、阿里云 ARM 等）要用 `docker buildx build --platform linux/arm64 -t emby-task-center:latest --load .` 重新构建。
- **标签与回滚**：保留旧固定标签和升级前的数据快照；回滚时恢复匹配的数据快照，并把镜像覆盖文件指回旧标签。
- **compose 的变量优先级**：`docker compose` 里 shell 环境变量 > `.env` 文件。若宿主机 shell 里已经存在 `APP_PORT`/`APP_BIND_ADDRESS`，它会盖掉 `.env` 里的值。
- **数据与配置都在 `./data`**：升级前按下方备份步骤停止应用并保存一致快照；换机器时保存完整数据目录。

## 启动与首次登录

启动前先创建宿主机挂载目录，避免 Docker 以 root 意外创建。

```bash
mkdir -p data
docker compose config --quiet
docker compose up -d --build
docker compose ps
curl --fail http://127.0.0.1:3000/health
```

打开服务 HTTP 地址，用首次启动自动创建的默认管理员 **admin / admin123** 登录（后台「系统配置」页会提示尽快改口令）。签发的会话默认持续 90 天（可在系统配置页调整）。同一 IP 登录失败达到阈值（默认 1 次）即触发锁定，锁定时长按基数的幂次递增（默认 60^n：1 分钟、1 小时、60 小时……最多累计到第七次指数）；也可在系统配置页改为固定锁定时长。锁定期间返回 `429 Too Many Requests` 并携带 `retry-after`；计数器在内存中，重启应用进程即重置。登录限流使用直接连接的 IP，不读取转发头中的地址。

源码桥接模板默认 `APP_BIND_ADDRESS=127.0.0.1`，应用无法被其他机器访问。需要其他设备直连时，设置 `APP_BIND_ADDRESS=0.0.0.0`，访问 `http://<宿主机地址>:<APP_PORT>`。GHCR Host 模板直接访问 `http://服务器IP:12333`，无需设置绑定地址或端口映射。管理员与会员会话均支持普通 HTTP。

TMDB 搜索需要在系统配置页填入有效的 API Read Access Token（直接填 token 本身，不要带 `Bearer ` 前缀）。token 失效或错误只会影响搜索/详情；密钥在接口层只回掩码、日志里会被脱敏，不会泄露。

启动扫描不会阻塞 HTTP 就绪。周期扫描不会重叠，失败按根目录记录，单个根目录失败或某个 TMDB 季刷新失败不会中断其余工作。已认证操作员可用 `POST /api/library/roots/:rootId/scan` 手动扫描；重启后仍可从 `GET /api/library/roots/:rootId/inventory` 读取持久化结果。

## HTTP 直连与虚拟库入口

管理后台与会员门户支持 `http://服务器IP:12333` 直连登录；桥接模板按实际 `APP_PORT` 访问。会话 Cookie 保留 `HttpOnly`、`SameSite` 和用途隔离签名，应用不再添加 `Secure` 标记或 HSTS 响应头，也不根据转发头识别代理地址。CSP、防点击劫持、MIME 嗅探、权限、opener 和 referrer 防护继续生效。

未启用虚拟媒体库时，Emby 客户端继续连接原有 Emby / TgtoDrive 入口。使用虚拟媒体库时，客户端连接本服务配置的 Emby 反代端口；桥接网络保留该端口映射，Host 网络直接使用宿主机端口，详见 [虚拟媒体库](virtual-libraries.md)。管理后台和会员门户使用单独的管理端口。

## 安卓本地安装（PWA）

前端是 PWA：提供了 Web App Manifest（`/manifest.json`）、192/512 及 maskable 图标和 Service Worker（`/sw.js`，只缓存应用壳与静态资源，`/api` 一律走网络）。满足以下条件后，安卓 Chrome/Edge 打开站点即可通过浏览器菜单「安装应用 / 添加到主屏幕」把它装成桌面图标的全屏应用：

- PWA 安装需要浏览器安全上下文：通常为 HTTPS，浏览器认可的 localhost 本地开发地址除外。普通服务器或局域网 IP 的 HTTP 地址可正常登录和使用网页，但不支持 Service Worker 注册及 PWA 安装。
- 首次打开后需让 Service Worker 完成一次注册和预缓存（正常加载即可），之后打开安装入口才会出现。
- 更新部署后，客户端下次访问会自动拉取新 `index.html` 与带哈希的新静态资源；Service Worker 版本变更时会在后台清理旧缓存。
- 登录状态与 PWA 无关：安装后的应用仍使用管理员账号或会员邮箱验证码登录，会话规则不变。

## 健康检查与日志

镜像健康检查根据容器 `PORT` 调用 `http://127.0.0.1:<PORT>/health`，未设置时使用镜像默认 `12333`。源码 Compose 的显式 `PORT=3000` 会让健康检查继续访问 `3000`。以下命令查看健康状态和结构化服务器日志：

```bash
docker compose ps
docker inspect --format '{{json .State.Health}}' emby-task-center-app-1
docker compose logs --tail=200 app
```

网页 UI 的「日志」页合并展示前端上报的 API 请求/报错（来源 `web`）与后端 API 请求及内部事件（来源 `server`），支持按级别/来源/关键字过滤和分页。日志持久化在 SQLite 的 `logs` 表中，保留天数和最大行数通过系统设置的 `logs.retentionDays`、`logs.maxRows` 调整；同一份事件也会输出到 stdout，可用 `docker compose logs` 查看。失败退避、队列容量及写锁处理见 [性能说明](performance.md)。

## 备份

数据库就在部署目录的 `./data/` 下（相对路径，随整个文件夹一起迁移）。以下步骤先停止应用，再完整备份数据目录，包括可能存在的 WAL。会有短暂停机；示例使用默认 `./data`，设置了其他 `DATA_PATH` 时须使用实际挂载目录。

```bash
mkdir -p backups
docker compose stop -t 30 app
tar -C ./data -cpf "./backups/emby-task-center-$(date +%Y%m%d-%H%M%S).data.tar" .
docker compose start app
curl --fail http://127.0.0.1:3000/health
```

`.env` 请单独存放在密钥管理器中，不要放进数据库归档。

## 恢复

先停止服务并保留当前完整数据目录，再从选中的完整目录备份恢复。以下仍以默认 `./data` 为例，不要把升级后的 WAL 混入旧快照：

```bash
docker compose stop -t 30 app
mkdir -p backups
mv ./data "./backups/data-before-restore-$(date +%Y%m%d-%H%M%S)"
mkdir ./data
tar -xpf ./backups/emby-task-center-YYYYMMDD-HHMMSS.data.tar -C ./data
docker compose start app
curl --fail http://127.0.0.1:3000/health
```

启动时会应用比恢复文件更新的迁移。在确认登录和任务列表正常之前保留旧备份。

## 升级

```bash
docker compose build --pull app
docker compose up -d app
docker compose logs --tail=200 app
```

数据存放在部署目录的 `./data/` 文件夹，容器重建不影响它。删除 `./data/` 即删除全部应用数据，请先备份。

## 媒体库同步

在系统设置配置 Emby 地址与 API Key，媒体库分组在同步时从 Emby 获取。应用读取 Emby 登记的作品、分集、海报和标签，无需挂载 STRM、片源或旁文件。停用库退出当前库存统计与门户内容查询，历史库存、分集及扫描记录保留，重新启用可恢复展示。

扫描调度与已播进度、缺集检测分别配置，详见 [功能说明](features.md) 和 [性能边界](performance.md)。

## Docker 冒烟测试

Windows PowerShell：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tests/docker-smoke.ps1
```

脚本使用独立 Compose 项目、镜像标签、空环境文件和临时数据目录，验证当前 `/data` 持久化、只读根文件系统、`/tmp` 可写、构建入口、健康检查、SPA 与管理员会话。应用不挂载片源目录。默认清理本轮创建的资源，`-Keep` 保留排查现场；使用方式和浏览器流程见 [测试说明](../tests/README.md)。

没有可用 Docker daemon 时，脚本只完成静态 Compose 与应用构建检查，并以退出码 2 表示容器部分未执行；不能据此认定容器验证成功。实际服务器访问、真实 Emby 与容量仍需在部署环境验证。本地数据库副本的验证范围见 [性能说明](performance.md)。
