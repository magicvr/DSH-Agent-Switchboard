# 实施方案

> 配套阅读：[`decisions.md`](./decisions.md)（为什么这么选）、[`architecture.md`](./architecture.md)（契约与取证）。

## 目标形态

```
用户输入
   │
   ▼
┌──────────────────────────────────────────────┐
│ 主代理（统合信息流，不亲自下场）                │
│ 可用工具：delegate_scout / delegate_worker /  │
│          delegate_architect / ...            │
└───────────────┬──────────────────────────────┘
                │ 每个工具 = 一个角色
                ▼
     ctx.subagents.start(providerName, request)
                │
      ┌─────────┴──────────┐
      ▼                    ▼
 provider = "spawn"    provider = "switchboard-cli"
 （DSH 内置）           （本插件注册，走 ctx.subprocess）
      │                    │
      ▼                    ▼
  DSH 子代理会话        本机 codex / claude / grok
```

主代理看到的只有「一组按角色命名的委派工具」，看不到线路差异。

## 目录结构

```
.
├── package.json                 契约字段：exports["."] / exports["./client"] / dsh.*
├── cordis.patch.yml             插件条目 + 角色列表（声明式）
├── README.md                    用户视角
├── AGENTS.md  CONTRIBUTING.md  LICENSE  .gitignore  .gitattributes  .editorconfig
├── docs/
│   ├── architecture.md          契约与取证（已完成）
│   ├── decisions.md             技术决策记录（已完成）
│   ├── plan.md                  本文件
│   └── cli-backends.md          三个 CLI 的实测参数表（Phase 3 产出）
├── src/
│   ├── index.js                 Host 半边入口：apply / inject / Config / name
│   ├── schema.js                角色与全局配置的 schemastery schema（两半边共用）
│   ├── roles.js                 角色解析与校验：id/标题/提示词/backend → 工具定义
│   ├── dispatch.js              统一派发：解析 backend → providerName → start()
│   ├── host/
│   │   ├── tools.js             按角色注册模型可见工具（ctx.tools.register）
│   │   └── prompt.js            角色提示词拼装 + 结果契约包装
│   ├── cli/
│   │   ├── provider.js          SubagentProvider 实现（name/capabilities/start）
│   │   ├── run.js               单次 CLI 运行的完整生命周期
│   │   ├── argv.js              参数模板 → argv 数组（占位符替换，无 shell）
│   │   └── output.js            stdout/stderr/退出码 → ContentBlock[]
│   └── client/
│       └── index.js             __ModuleLoader__.load + composer.dock 只读指示
├── scripts/
│   ├── dsh-probe.mjs            只读 asar 取证（已完成）
│   ├── dsh-cat.mjs              只读读取归档内单文件（已完成）
│   └── inline-asar-probe.mjs    底层解析器（已完成）
└── test/                        Phase 2 起
```

## Phase 1 · 最小可加载插件（打通装载链路）

**目标：** 证明这个包能被 DSH 装载、Host 与 Client 两半边都活着。不实现任何派发。

**状态：代码已完成并通过静态与离线验证；真机激活待一次应用重启。**

**产出（已落地）：**

| 文件 | 内容 |
| --- | --- |
| `package.json` | `exports["."]` / `exports["./client"]` / `dsh.bundle.patch` / `dsh.client` / `manifestVersion` / `peerDependencies` 齐全 |
| `cordis.patch.yml` | 一条 `insert` 条目，id `agent-switchboard` |
| `src/index.js` | Host 半边：`Config`（含 `.volatile()` 子对象）+ 自检工具 `switchboard_selftest` |
| `src/client/index.js` | Client 半边：`__ModuleLoader__.load` + `conversation.composer.dock` 只读状态条 |

**已验证（客观证据）：**

1. 两半边 `node --check` 通过；`package.json` 可解析、四个契约字段指向的文件均存在。
2. Client 半边的 `__ModuleLoader__.load` 的 `id` **严格等于包名**（脚本比对）。
3. 从 profile 目录可直接 import 两半边；Client 半边加载时确实调用了 `load()` 且 id 正确。
4. 包已被 `install_bundle` 成功 link 进 profile（`link:C:/.../DSH-Agent-Switchboard`，pnpm 退出码 0）。
5. **`@deepseek-ai/schemastery` 与 `@deepseek-ai/dsh-tools` 的 import 在运行时可用** —— 曾一度怀疑不可用（磁盘上解析必然失败），最终由报错堆栈中出现 `src/index.js` 行号证明模块加载与 `apply` 执行均成功。
6. `output.schema` 已改为 value schema DSL 写法（属性级 `required: true`），并用**两层预检**验证：DSL 层与编译产物子集层**均 0 violations**，且预检能对两种已知错误写法逐字复现线上报错。
7. ✅ **Client 半边已在运行中的 GUI 生效**（不依赖 Host 半边，有自己的 HMR）。`cordis_inspect_query`（Client `Slots`，root `conversation.composer.dock`）的 `occupants` 现有两项：官方 `stats`（order 0）与我们的 `id: "agent-switchboard"`（order 5），`active: true`。**这条即验收第 4 条，已通过。**
8. ✅ 顺带确认：`dsh.client.platform: "web"` **在桌面版下是正确的**——profile 目录名为 `desktop`，但渲染层就是这套 Web 客户端。

**待完成（阻塞条件明确）：**

- **Host 半边仍为 `failed`。** 第一次重启后模块确实被重新加载（`fiberPhase` 由 `null` 变为 `failed`，`Config` 状态变为 `status: "schema"`），并暴露出真实错误 `schema.required is not supported by the value schema DSL`。该错误已修复——`output.schema` 是 value schema DSL，必需性必须写成**属性级 `required: true`**（见 `architecture.md` 第 3.1 节第 12 条）。
- **修复的真机生效仍需重启。** link 模式下模块被缓存，`set_plugin` 开关与 `install_bundle` 都不重新加载源码（已用落地文件探针证实新代码从未执行）。Client 半边不受此限。
- 重启后跑完验收第 1–3、5 条。

### 教训：验证方法本身出过错

这处 schema 我连错两次、方向相反，根因是**把两层 schema 规则混为一谈**（value schema DSL 与它编译产物的受限 JSON Schema 子集是两套规则）。

但更值得记住的是**验证方法的失败**：第一轮我用「抽取子集校验器去验编译产物」的方式，得出了修复有效的结论——那只覆盖了第二层，完全没有覆盖我实际写错的第一层。**只验产物、不验输入，会给出虚假的成功信号。** 后续任何 schema 改动都必须两层都验，并用已知错误写法做回归对照。

**验收（重启后逐条真实通过）：**
1. `plugin_manager install_bundle` 能把包装进 profile。
2. 插件出现在 Loader 条目列表里，`Config` schema 被 `cordis_inspect_query`（Provider `Config`）读到（当前该条目**没有** config 说明，正是因为未激活）。
3. `switchboard_selftest` 工具在 `cordis_inspect_query`（Provider `Tool`）的清单里出现。
4. GUI 刷新后 `composer.dock` 能看到那个只读状态条。
5. `.volatile()` 字段在设置页可编辑；非 volatile 字段**不**出现（这条用来确认 D9 的前提）。

**这一阶段的真正价值：** 已一次性消灭「装载层」的主要不确定性，并额外换来两条高价值教训（见 `architecture.md` 第 3.1–3.3 节）：schema 子集的真实规则、以及 `failed to import` 这条诊断会把人引向错误方向。

## Phase 2 · builtin 后端与角色工具

**目标：** 主代理能通过角色工具委派给 DSH 内置子代理，并拿回结构化结果。

**状态：已完成并真机验证。**

**产出（已落地）：**
- `src/roles.js`：纯函数角色模型与校验（不 import DSH 运行时，故可离线单测）
- `src/index.js`：`apply` 时用 `ctx.plugin()` 为每个角色挂载一个 `dsh-tool-subagent` 实例；并注册角色路由指引到 `ctx.systemPrompt`
- `scripts/check-roles.mjs`：61 条离线断言
- `scripts/check-config-schema.mjs`：Config 与依赖解析离线预检
- `scripts/gen-role-config.mjs`：把 `raw/agents/*.toml` 转成插件 Config（含 YAML 校验与备份）

**验收结果（全部真机通过）：**

| # | 验收项 | 结果 | 证据 |
| --- | --- | --- | --- |
| 1 | 角色工具出现在工具清单 | ✅ | 4 个 `delegate_to_*` 工具上线 |
| 2 | 真实派发并拿回结果 | ✅ | 向 scout 派发三个可核对问题，答案与引用均正确 |
| 3 | `readOnly` 约束生效 | ✅ | scout 拒绝修改文件；其工具清单无 `write`/`edit`/`pwsh`，而 worker 有 |
| 4 | `persona` 生效 | ✅ | scout 按角色的「证据优先」格式作答，给出 `src/roles.js:24–32` 等精确引用 |
| 5 | 嵌套派发默认关闭 | ✅ | 角色工具配置 `maxDepth: 1`，子代理无法再派 |
| 6 | 路由指引传达给主代理 | ✅ | 系统提示中出现 `## Subagent roles` 段 |
| 7 | **模型按角色切换** | ⚠️ **未能独立验证** | 见下 |

**未能验证的一项，以及原因（重要）：**

「角色是否真的用上了各自指定的 `model` / `effort`」——配置已下发到每个工具实例的
`agentOptions`（结构上必然被消费），但**我无法从任何模型可见的表面反查实际使用的模型**。已逐一排查并确认这些表面**都不含**该信息：

- 子代理自己的上下文：worker 明确回答 `not stated in my context`，拒绝猜测（这是它的正确行为）
- `ctx.subagents` 的 catalog（`SubagentCatalogEntry`）：不含模型字段
- 持久化会话记录 `session.v4.jsonl.zstd`：当前可读部分只有 header，无 `request/header` 事件
- `list_subagent_models` 工具：需要 `modelSelectionSettings: true` 才注册，而本插件按 D12 设为 false
- Client 侧源码：未发现 per-session 模型展示

**这是一个真实的可观测性缺口，不是本插件的 bug。** 决定性的验证手段是**反证实验**：把某个角色的 `model` 改成一个不存在的 id，重新启用后派发该角色——若失败，即证明 `agentOptions.model` 确实被消费；若仍成功，则说明该字段被忽略。这需要一次重启，尚未执行。

## Phase 3 · CLI 后端

**目标：** 至少一个外部 CLI 能作为角色后端跑通。

**产出：**
- `docs/cli-backends.md`：三个 CLI 的**实测**参数表（非交互子命令、提示词传递方式、是否需 TTY、**模型 flag、思考强度 flag 与各自可用档位**、退出码语义、超时表现）
- `src/cli/*`：provider 实现，含 `modelFlag` / `effortFlag` 映射与 `effortValues` 声明
- 插件面板可配可执行文件路径与超时

**验收：**
1. 对一个真实 CLI 跑通一次完整委派，结果文本回到主代理。
2. **模型与强度确实生效**：用两种明显不同的档位各跑一次，从 CLI 的输出/日志中**可验证**其接收到了指定模型与强度（不能只看退出码为 0）。特别是 `codex`，其强度参数未经 help 文档化，必须用真实调用确认 `-c model_reasoning_effort=<值>` 被接受且生效。
3. **非法强度不静默降级**：给一个后端声明不支持的档位，装载期即报错并指出该后端支持的档位。
4. 失败语义正确：命令不存在 / 非零退出 / 超时，分别产生可读错误，主代理不会把它当成成功。
5. `argv` 全程是数组，日志中可证明没有任何 shell 参与；`{model}` / `{effort}` 的替换结果始终是独立 argv 元素。
6. 取消：中断主代理时子进程被终止，不残留孤儿进程。

**先做哪个 CLI：** **`codex`**（已拍板）。注意本机 `codex` 的入口是 PowerShell 脚本 `%APPDATA%\npm\codex.ps1`，而不是 `.exe`——因此 Phase 3 的**第一件事**是用 `ctx.subprocess.resolveExecutable` 验证脚本入口能否正确解析，再写 provider。`claude`（`claude -p`，干净的非交互入口）与 `grok`（`.exe`）作为后续目标。

## Phase 4 · 可观测性与打磨

- 调度日志：谁派的、派给谁、哪条线路、耗时、退出状态、结果摘要
- Client 半边升级为可写面板（需先确认 `config-editor` 对数组字段的支持程度，见 D9）
- 并发与预算上限
- README 补真实用法示例

## 风险登记

| # | 风险 | 影响 | 应对 |
| --- | --- | --- | --- |
| R1 | **没有任何「外部进程 SubagentProvider」的现成先例** | Phase 3 无参考实现，接口虽支持但需自行探索 | 接口契约已完整取证（`SubagentProvider` / `SubagentRun` / `SubagentResult`），Phase 1 先打通装载面，把探索限制在 Phase 3 |
| R2 | CLI 可能需要 TTY | 管道模式下行为异常或直接拒绝 | 实测三个 CLI；必要时切换到 `ctx.subprocess.spawnTerminal`（PTY），该能力已核实存在 |
| R3 | `ctx.subprocess` 在 Windows 上解析 `codex.ps1` 的行为未知 | CLI 后端可能在解析阶段就失败 | 用 `resolveExecutable` 先做独立小实验，再接入 provider |
| R4 | 本机无 DSH 类型定义 | 无法获得编译期类型保障 | D1 已把风险限制在少数薄适配文件；用 `cordis_inspect_query` 作为类型的唯一权威来源 |
| R5 | Client 半边崩溃会清空整个 slot | 可能拖垮 GUI 的一块区域 | 第一期只做只读、最小 DOM；严守「不 import Harness Client 包」 |
| R6 | 角色列表若放 patch，用户在 GUI 里改不了 | 与「面板配置角色」的期望有落差 | D9 已明确分层并记录；Phase 4 评估可写面板 |
| R7 | 外部 CLI 的额度/登录状态不透明 | 派发失败原因难定位 | 结果里保留原始 stderr 与退出码（D8），不做美化丢弃 |
| R8 | **link 模式下 Host 半边改动无法热加载** | 每次改动都需重启 dsh 才能真机验证，迭代慢 | 已实测确认（`architecture.md` 第 3.3 节）。缓解：把逻辑尽可能放进可用抽取方式验证的纯函数；Client 半边不受此限（有 HMR） |
| R9 | **`failed to import` 会掩盖真实错误** | 排查方向被误导，可能浪费大量时间（Phase 1 已实际发生） | 已记录取证手法（`architecture.md` 第 3.2 节）：先用落地文件探针判定「模块是否已加载」，再查 `apply` 内部 |

## 与项目硬规则的对应

| 规则 | 落地位置 |
| --- | --- |
| 主代理只统合、不下场 | 主代理侧只增委派工具；写文件权限不授予主代理 |
| 跨 CLI 可指派 | Phase 3 的 `cli` provider |
| 角色与派发方式可配置 | `cordis.patch.yml`（角色）+ 插件面板（运行时旋钮，D9） |
| 模型不得自由拼装 shell 命令 | `src/cli/argv.js` 只做受限占位符替换，`argv` 数组直传 `ctx.subprocess.spawn`，全程无 shell |
| `raw/` 不入库 | 已在 `.gitignore`，且 `AGENTS.md` 列为硬规则 |
