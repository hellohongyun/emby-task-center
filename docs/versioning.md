# 版本命名与镜像发布

当前正式版本为 `1.0.5`。正式发布统一采用 `主版本.次版本.补丁版本`（`X.Y.Z`），不再使用日期或功能名称作为新正式版本号，也不加 `v` 前缀。

## 递增规则

| 变更 | 版本递增 | 示例 |
| --- | --- | --- |
| 修复错误、性能优化、兼容的小范围 UI 调整 | 补丁版本 | `1.0.1` → `1.0.2` |
| 向后兼容的新功能 | 次版本，补丁归零 | `1.0.2` → `1.1.0` |
| 不兼容的接口、配置或使用方式变化 | 主版本，其余归零 | `1.1.0` → `2.0.0` |

固定版本发布后不覆盖；需要修改已发布内容时递增版本。已有日期标签与旧离线归档作为历史版本保留，不删除、不改名，也不代表当前最新版。

## 唯一版本来源

根目录 `package.json` 的 `version` 是应用发行版本的唯一来源。工作区子包的版本用于内部包管理，不作为界面或镜像的发行版本。

前端构建读取根版本并显示在界面中；镜像构建也使用相同版本写入 OCI 标签 `org.opencontainers.image.version`。构建失败、版本不合法或镜像版本与前端版本不一致时不得发布。不要分别手写前端版本和镜像版本，也不要在运行时用 `latest` 替代实际应用版本。

## 镜像标签

每次正式发布从同一次构建生成两个标签。例如 `1.0.5`：

```text
ghcr.io/hellohongyun/emby-task-center:1.0.5
ghcr.io/hellohongyun/emby-task-center:latest
```

固定标签用于追溯与回滚，`latest` 用于日常部署。先完成构建和验证，再发布固定版本并更新 `latest`；两个标签的镜像摘要必须一致。前端显示固定版本号，例如 `1.0.5`，而不是 `latest`。

发布前须核对根版本、前端构建版本、镜像 OCI 版本与固定标签一致，并验证容器健康、页面和登录。当前公开镜像平台为 `linux/amd64`。

在构建机器执行以下流程。发布脚本从根 `package.json` 自动读取并校验版本，向 Docker 传入同一版本，拒绝覆盖仓库已有的固定版本标签。Dockerfile 同样校验构建参数与根版本一致。

```bash
# 构建并核对版本，不推送到仓库。
pnpm release:ghcr
```

随后运行 Docker 冒烟，Windows PowerShell 示例（镜像标签替换为根版本）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tests/docker-smoke.ps1 -Image ghcr.io/hellohongyun/emby-task-center:1.0.5
```

验证通过后，在已登录 GHCR 的构建机器发布刚才验证的镜像：

```bash
pnpm release:ghcr --skip-build --publish
```

发布后核对固定版本与 `latest` 的远端摘要一致，并确认公开镜像可匿名拉取。脚本的 `--skip-build` 只用于发布本轮已构建、已验证的镜像。

## 服务器更新

部署模板固定使用 `image: ghcr.io/hellohongyun/emby-task-center:latest`。在原部署目录执行：

```bash
docker compose pull
docker compose up -d
docker compose ps
curl --fail http://127.0.0.1:12333/health
```

仅执行 `restart` 不会拉取新版镜像。更新后核对前端实际版本号；升级前备份完整数据目录，详细步骤见 [部署、备份与升级](deployment.md)。

需要回滚时，将镜像临时指向旧固定版本，并恢复与其匹配的数据快照；新版本数据库不保证可供旧版本使用。恢复跟随正式发布时再改回 `latest`。
