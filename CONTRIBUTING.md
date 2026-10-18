# 贡献指南

## 本地运行

先阅读 [README.md](README.md) 和所修改功能的正式文档。需要 Node.js 24、Corepack 与仓库固定的 pnpm 11.16.0，前端和工作区统一使用 pnpm。

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm build
pnpm start
```

本地启动器默认端口为 `3000`；管理后台入口为 `/login`，会员门户为 `/`。业务设置在后台维护。开发与测试使用独立数据库和测试 Emby，不连接或修改生产媒体库。

## 提交变更

- 简述需要解决的问题、变更后的行为和验证结果；影响配置或数据范围时说明兼容性。
- 保持模块职责清晰，单个代码文件原则上不超过 300 行，复杂模块拆分。
- 功能、接口、命令或边界变化时，同步更新相关 README 和正式文档；根 README 保留稳定入口，不堆叠开发流水账。
- 不提交真实 `.env`、配置密钥、Emby/TMDB Token、SMTP 凭据、数据库、备份、运行日志或本地构建产物。配置示例只使用占位值。
- 新增行为修改应有适当验证；数据库变化使用迁移，说明现有数据的处理方式。

提交前运行与改动相关的测试及检查：

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm build
```

只调整文档时检查链接、示例命令和格式即可。浏览器、容器与设备兼容性按实际验证范围描述，详见 [tests/README.md](tests/README.md)。

应用版本由根 `package.json` 的 `version` 统一管理，发布规则见 [版本规范](docs/versioning.md)。不要单独改写前端显示版本或覆盖既有固定镜像标签。

提交到本项目的贡献使用与项目相同的 [MIT 许可证](LICENSE)。引入第三方源码或依赖时保留其必要的许可和署名信息。
