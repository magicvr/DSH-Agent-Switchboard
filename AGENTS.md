# AGENTS.md

本文件面向在本仓库工作的 AI 代理。人类贡献者请看 [`CONTRIBUTING.md`](./CONTRIBUTING.md)。

## 项目一句话

DSH 插件 `DSH Agent Switchboard`：把主代理限制为「信息流统合器」，把具体任务委派给带角色的子代理；子代理可以走 DSH 内置机制，也可以跨 CLI 派发给本机的 `codex` / `claude` / `grok` 等命令行代理。

## 硬性规则

1. **`raw/` 是临时区，永远不要提交。** 它已被 `.gitignore` 忽略。不要用 `git add -f` 绕过。不要从 `raw/` 里的文件推断项目决策——那里的内容随时会变、可能是过期的草稿。
2. **不要凭空创建实现目录。** 语言与工具链选型已定为「纯 ESM JavaScript、零构建」（`docs/decisions.md` D1），目录结构见 `docs/plan.md`。改动前先读该文件，不要另起一套布局。
3. **不要把未验证的命令写成事实。** 外部 CLI 的子命令与参数必须实际跑过 `--help` 或真实调用确认后，才能写进文档或代码；未确认的标注「未验证」。
4. **跨 CLI 派发是安全敏感面。** 任何执行本地命令的路径都必须满足：可执行文件与参数来自用户配置，模型只能填充受限占位符（如 `{prompt}`、`{cwd}`），不得由模型自由拼装 shell 命令。
5. **不要提交密钥、令牌、本地绝对路径。**

## 约定

- 文本文件以 LF 入库（`.gitattributes` 保证）。
- 提交信息遵循 Conventional Commits，见 [`CONTRIBUTING.md`](./CONTRIBUTING.md)。
- 文档用中文；代码标识符、提交类型、配置键用英文。
- 核心实现已落地并完成真机验收：改动须对照当前代码与已接受决策，保持现有布局和纯 ESM、零构建；文档要区分已实现、历史实测与尚未验证的内容，代码改动执行相应检查。

## 文档地图

| 文件 | 内容 |
| --- | --- |
| [`README.md`](./README.md) | 项目定位、核心设计、状态 |
| [`docs/plan.md`](./docs/plan.md) | **分阶段实施方案、验收标准、风险登记（历史布局与状态待校准）** |
| [`docs/decisions.md`](./docs/decisions.md) | **技术决策记录（含依据、代价与后续修订）** |
| [`docs/architecture.md`](./docs/architecture.md) | 当前实现、已核实的 DSH 契约、历史取证与设计约束 |
| [`docs/cli-backends.md`](./docs/cli-backends.md) | **CLI 后端实测参数表（入口可执行性、模型/强度 flag 及验证方式）** |
| [`CONTRIBUTING.md`](./CONTRIBUTING.md) | 提交规范与自查项 |

## 取证工具

asar 探针仍在 `scripts/` 根目录。归档路径可用 `DSH_ASAR` 环境变量覆盖；Windows 默认由 `LOCALAPPDATA`（缺省时由用户 home）动态推导安装位置，非 Windows 须显式设置：

```bash
node scripts/dsh-probe.mjs list-registry        # 列出归档内所有 DSH 包
node scripts/dsh-probe.mjs ls <dir>             # 列出归档内目录
node scripts/dsh-probe.mjs grep <regex>         # 在归档内搜索
node scripts/dsh-cat.mjs <asar-relative-path>   # 打印归档内单个文件
```

`scripts/` 根目录还保留 check 链与仓库工具；`scripts/lib/` 放共享解析与校验，`scripts/ops/` 放含写入的本机运维工具，`scripts/probes/` 放依赖本机 CLI 与安装环境的现场探针。不要把整个 `scripts/` 当作只读工具集。

检查 DSH 真实接口时，**优先用 `cordis_inspect_query`**（Provider `Service` / `Event` / `Config` / `Tool` / `Slots`），它是运行时权威；探针用于读源码实现细节。
