# AGENTS.md

本文件面向在本仓库工作的 AI 代理。人类贡献者请看 [`CONTRIBUTING.md`](./CONTRIBUTING.md)。

## 项目一句话

DSH 插件 `DSH Agent Switchboard`：把主代理限制为「信息流统合器」，把具体任务委派给带角色的子代理；子代理可以走 DSH 内置机制，也可以跨 CLI 派发给本机的 `codex` / `claude` / `grok` 等命令行代理。

## 硬性规则

1. **`raw/` 是临时区，永远不要提交。** 它已被 `.gitignore` 忽略。不要用 `git add -f` 绕过。不要从 `raw/` 里的文件推断项目决策——那里的内容随时会变、可能是过期的草稿。
2. **不要凭空创建实现目录。** 官方事实是：外部插件不需要构建工具链，约束只在 `package.json` 的 `exports` / `dsh.bundle.patch` / `dsh.client` 三个字段上，目录结构自由。但这不等于可以随手铺空骨架——语言与工具链选型（`docs/architecture.md` 第 4 节 D7）尚未定论，定型前不要预建 `src/`、`test/` 之类目录。
3. **不要把未验证的命令写成事实。** 外部 CLI 的子命令与参数必须实际跑过 `--help` 或真实调用确认后，才能写进文档或代码；未确认的标注「未验证」。
4. **跨 CLI 派发是安全敏感面。** 任何执行本地命令的路径都必须满足：可执行文件与参数来自用户配置，模型只能填充受限占位符（如 `{prompt}`、`{cwd}`），不得由模型自由拼装 shell 命令。
5. **不要提交密钥、令牌、本地绝对路径。**

## 约定

- 文本文件以 LF 入库（`.gitattributes` 保证）。
- 提交信息遵循 Conventional Commits，见 [`CONTRIBUTING.md`](./CONTRIBUTING.md)。
- 文档用中文；代码标识符、提交类型、配置键用英文。
- 当前处于设计阶段：改动应优先落在 `docs/`，实现代码等决策定型后再写。

## 文档地图

| 文件 | 内容 |
| --- | --- |
| [`README.md`](./README.md) | 项目定位、核心设计、配置示意、状态 |
| [`docs/architecture.md`](./docs/architecture.md) | 目标架构与**待定决策清单** |
| [`CONTRIBUTING.md`](./CONTRIBUTING.md) | 提交规范与自查项 |
