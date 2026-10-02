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
  DSH 子代理会话        本机 codex / grok（+ 自定义命令）
```

主代理看到的只有「一组按角色命名的委派工具」，看不到线路差异。

## 目录结构

```
.
├── package.json                 契约字段：exports["."] / exports["./client"] / dsh.*
├── cordis.patch.yml             启用 bundle 根条目，不携带角色列表
├── presets/switchboard.patch.yml  preset 声明，本插件只带 mount: true
├── README.md                    用户视角
├── AGENTS.md  CONTRIBUTING.md  LICENSE  .gitignore  .gitattributes  .editorconfig
├── docs/
│   ├── architecture.md          契约与取证（已完成）
│   ├── decisions.md             技术决策记录（已完成）
│   ├── plan.md                  本文件
│   └── cli-backends.md          三个 CLI 的实测参数表（Phase 3 产出）
├── src/
│   ├── index.js                 Host 入口、Config、配置桥接、角色工具挂载与自检
│   ├── config-file.js           roles.json 路径、读取、原子写入与格式校验
│   ├── roles.js                 角色解析与校验：id/标题/提示词/backend → 工具定义
│   ├── cli/
│   │   ├── provider.js          SubagentProvider 实现（name/capabilities/start）
│   │   ├── drivers.js           codex / grok / custom 驱动预设
│   │   ├── argv.js              参数模板 → argv 数组（占位符替换，无 shell）
│   │   └── output.js            stdout/stderr/退出码 → ContentBlock[]
│   └── client/
│       ├── index.js             __ModuleLoader__.load + 角色与派发设置页
│       └── logic.js             可离线检查的客户端校验逻辑
└── scripts/
│   ├── lib/                     paths / cli-config / capture / probe-cli 共享模块
│   ├── ops/                     写入、迁移、修复脚本（批次 2d-2 已归类）
│   │   ├── migrate-roles-to-file.mjs  角色文件迁移
│   │   ├── fix-cli-models.mjs         CLI 模型与 cwd 修复
│   │   ├── consolidate-config.mjs     重复配置收敛
│   │   ├── collapse-role-fork.mjs     实验角色分支收敛
│   │   ├── experiment-dormant.mjs     preset 挂载实验与还原
│   │   ├── seed-root-roles.mjs        根条目角色播种
│   │   ├── probe-preset.mjs           preset 校验与注入
│   │   └── gen-role-config.mjs        角色配置块生成
│   ├── probes/                  环境相关取证与实机实验（批次 2d-1 已归类）
│   │   ├── probe-claude-isolate.mjs  Claude 隔离调用探针
│   │   ├── probe-cli-help.mjs        CLI help 候选筛选
│   │   ├── probe-cli-run.mjs         第一轮 CLI 调用探针
│   │   ├── probe-cli-run2.mjs        第二轮 CLI 调用探针
│   │   ├── probe-clis.mjs            CLI 入口发现与显式探针
│   │   ├── probe-codex.mjs           Codex 非交互探针
│   │   └── check-cli-live.mjs        可选真实 CLI 派发检查
│   ├── check-*.mjs              12 个检查入口，串联在 npm run check
│   ├── cli-probes.example.json / cli-probes.example.md  CLI 探针配置示例与说明
│   ├── dsh-probe.mjs            只读 asar 取证（已完成）
│   ├── dsh-cat.mjs              只读读取归档内单文件（已完成）
│   ├── inline-asar-probe.mjs    底层解析器（已完成）
│   ├── gen-preset.mjs           preset 声明生成
│   └── inspect-sessions.mjs     会话记录取证
```

上表是当前布局，不是初期拆分设想。原拟 `schema.js` 的 Host schema 合并进
`src/index.js`；原拟 `dispatch.js` / `host/tools.js` 的路由配置与挂载分由
`src/roles.js`（`toolConfigFor`）和 `src/index.js`（`mountRoleTool`）承担，未另建
`host/`。原拟 `host/prompt.js` 的角色指引在 `roles.js`，CLI 提示词拼装及原拟
`cli/run.js` 的进程生命周期在 `cli/provider.js`。客户端另抽出 `client/logic.js`。
未创建 `test/`；检查由 `scripts/check-*.mjs` 承担（`package.json` 的 `scripts.check`）。

脚本按副作用与环境依赖分类：`lib/` 只提供共享解析和校验，`ops/` 承载业务允许的写入，
`probes/` 承载安装环境与外部 CLI 取证；离线检查保留在 `scripts/`。批次 1 仅新增
`lib/`，已有脚本不移动。批次 2d-1 已将上述 7 个探针移入 `probes/`；
批次 2d-2 已将上述 8 个运维脚本移入 `ops/`，目录归类完成。路径契约见 D15。

## Phase 1 · 最小可加载插件（打通装载链路）

**目标：** 证明这个包能被 DSH 装载、Host 与 Client 两半边都活着。不实现任何派发。

**状态：已完成并真机验收；修复后的应用重启与真实派发均已完成。**

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

**历史阻塞（已解除，保留排障记录）：**

- **Host 半边曾为 `failed`。** 第一次重启后模块确实被重新加载（`fiberPhase` 由 `null` 变为 `failed`，`Config` 状态变为 `status: "schema"`），并暴露出真实错误 `schema.required is not supported by the value schema DSL`。该错误已修复——`output.schema` 是 value schema DSL，必需性必须写成**属性级 `required: true`**（见 `architecture.md` 第 3.1 节第 12 条）。
- **当时修复需重启才生效。** link 模式下模块被缓存，`set_plugin` 开关与 `install_bundle` 都不重新加载源码（当时已用落地文件探针证实新代码尚未执行）。Client 半边不受此限；这仍是后续 Host 改动的验证约束，不是本阶段的待办。
- **重启后已验收。** 已有真机记录显示四个角色全部 `OK`、`已挂载角色工具：4`，并完成真实派发（`exit=0`）。自检当前实时查询工具注册表（`src/index.js` 的 `liveRoleTools` / `selftestTool`）；本轮文档校准未重新执行真机派发。

### 教训：验证方法本身出过错

这处 schema 我连错两次、方向相反，根因是**把两层 schema 规则混为一谈**（value schema DSL 与它编译产物的受限 JSON Schema 子集是两套规则）。

但更值得记住的是**验证方法的失败**：第一轮我用「抽取子集校验器去验编译产物」的方式，得出了修复有效的结论——那只覆盖了第二层，完全没有覆盖我实际写错的第一层。**只验产物、不验输入，会给出虚假的成功信号。** 后续任何 schema 改动都必须两层都验，并用已知错误写法做回归对照。

**验收（重启后逐条真实通过）：**
1. `plugin_manager install_bundle` 能把包装进 profile。
2. 插件出现在 Loader 条目列表里，`Config` schema 被 `cordis_inspect_query`（Provider `Config`）读到；此前未激活时没有 config 说明的状态已解除。
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
- `scripts/ops/gen-role-config.mjs`：把 `raw/agents/*.toml` 转成插件 Config（含 YAML 校验与备份）

**验收结果（全部真机通过）：**

| # | 验收项 | 结果 | 证据 |
| --- | --- | --- | --- |
| 1 | 角色工具出现在工具清单 | ✅ | 4 个 `delegate_to_*` 工具上线 |
| 2 | 真实派发并拿回结果 | ✅ | 向 scout 派发三个可核对问题，答案与引用均正确 |
| 3 | `readOnly` 约束生效 | ✅ | scout 拒绝修改文件；其工具清单无 `write`/`edit`/`pwsh`，而 worker 有 |
| 4 | `persona` 生效 | ✅ | scout 按角色的「证据优先」格式作答，给出 `src/roles.js:24–32` 等精确引用 |
| 5 | 嵌套派发默认关闭 | ✅ | 角色工具配置 `maxDepth: 1`，子代理无法再派 |
| 6 | 路由指引传达给主代理 | ✅ | 系统提示中出现 `## Subagent roles` 段 |
| 7 | **模型按角色切换** | ✅ | 见下 |

**第 7 条：验证方式与决定性证据（本阶段最重要的一条）**

模型名**不会**出现在子代理自己的上下文里——实测 worker 回答 `not stated in my context` 并拒绝猜测，这正是它该有的行为。因此改用**持久化会话记录**取权威答案。

记录位置：`~/.dsh/sessions/<workspace>/<childId>/session.v4.jsonl.zstd`，每个子会话都记有 `data.header.config`：

| 会话 | `provider` / `model` / `reasoningEffort` |
| --- | --- |
| 子会话（scout 角色） | `self` / **`gpt-6-luna`** / **`medium`** |
| 子会话（worker 角色） | `self` / **`gpt-6.1-sol`** / **`high`** |
| 主会话（主代理） | `deepseek-account` / `deepseek-flash` / high |

**为什么这是决定性证明：** 子代理用的是**角色配置的模型**，而非父代理的 `deepseek-flash`；`reasoningEffort` 也逐字匹配。而 `gpt-6-luna` 与 `gpt-6.1-sol` 这两个 id **只存在于本插件的角色配置中**（`raw/agents/*.toml` → profile patch），没有其他来源，不可能凭空出现在子会话记录里。D12「模型由角色固定」至此得到实证。

**⚠️ 读取方法（踩过两个坑，脚本已固化于 `scripts/inspect-sessions.mjs`）：** 会话文件由**多个 zstd frame** 顺序拼成（单个会话实测 6–1646 个 frame）。`zstdDecompressSync` 只解第一个 frame，而 `createZstdDecompress` 流式解码**同样只产出第一个 frame**。必须按 frame 边界逐个解压再拼接。

截断的解压结果看起来是「成功」的，因此极易被误判为「记录里没有该信息」——**我一度正是据此得出了「模型无法验证」的错误结论**，并差点把它写进文档当作事实。这条失败模式值得记住：解压器「没报错」不等于「读全了」。

## Phase 3 · CLI 后端

**目标：** 至少一个外部 CLI 能作为角色后端跑通。

**状态：核心实现已落地，codex 已完成角色派发真机验收；其它 CLI 的历史探针结果与未验证边界分开记录。**

**产出：**
- `docs/cli-backends.md`：codex / grok 的实测参数表与 Claude 历史取证，逐项区分 help 候选、调用被接受、实际生效与仍未实测内容
- `src/cli/*`：provider、argv 校验与输出处理；`drivers.js` 用参数模板映射 `{model}` / `{effort}` 并声明 `effortValues`
- 插件面板可配可执行文件路径与超时

**验收：**
1. 对一个真实 CLI 跑通一次完整委派，结果文本回到主代理。
2. **模型与强度确实生效**：用两种明显不同的档位各跑一次，从 CLI 的输出/日志中**可验证**其接收到了指定模型与强度（不能只看退出码为 0）。特别是 `codex`，其强度参数未经 help 文档化，必须用真实调用确认 `-c model_reasoning_effort=<值>` 被接受且生效。
3. **非法强度不静默降级**：给一个后端声明不支持的档位，装载期即报错并指出该后端支持的档位。
4. 失败语义正确：命令不存在 / 非零退出 / 超时，分别产生可读错误，主代理不会把它当成成功。
5. `argv` 全程是数组，日志中可证明没有任何 shell 参与；`{model}` / `{effort}` 的替换结果始终是独立 argv 元素。
6. 取消：中断主代理时子进程被终止，不残留孤儿进程。

**首个 CLI 的历史选择与结果：** 先做 **`codex`**。入口试验已完成：`.ps1` / `.cmd` 无法在 `shell:false` 下直接执行，当前预设使用 `node <codex.js>`（见 `cli-backends.md` §1）。当前内置驱动为 `codex` / `grok` / `custom`；Claude 曾做探针取证，但预设已移除，用户可通过 custom 自行接入。

**验收结果（codex 部分真机通过）：**

真机证据（在选中 `Switchboard` preset 的会话里，真实调用 `delegate_to_codex_scout`，一次真实取证任务）：

```text
[switchboard] argv=[...,"codex.js","exec","-s","read-only","--skip-git-repo-check",
                    "-m","gpt-6-astra","-c","model_reasoning_effort=medium","-"]
[switchboard] exit=0 duration=67.5s
[switchboard] cli-route {"workdir":"...","model":"gpt-6-astra","provider":"openai",
                         "approval":"never","sandbox":"read-only","reasoning effort":"medium"}
```

| # | 验收项 | 结果 | 证据 |
| --- | --- | --- | --- |
| 1 | 真实 CLI 完整委派，结果回到主代理 | ✅ 真机通过 | 上表 `exit=0`，codex-scout 返回了带文件与行号的答案 |
| 2 | **模型与强度确实生效** | ✅ 真机通过 | `argv` 里的 `-m gpt-6-astra` / `model_reasoning_effort=medium` 与 codex **自报**的 `model: gpt-6-astra` / `reasoning effort: medium` 一致。这一步不可省：实测**省略 `-m` 时 codex 会静默使用它自己 `~/.codex/config.toml` 的值**（`gpt-6-luna` + `max`），外观毫无区别 |
| 3 | 非法强度不静默降级 | ✅ 离线通过 | `normalizeRole` 对非法 `effort` 报错并列出合法档位（`check-roles.mjs` 的「非法输入」小节） |
| 4 | 失败语义（命令不存在／非零退出／超时） | ✅ 离线通过 | 非零退出→可读失败、spawn 抛错不冒泡、模板错误在 spawn 前失败；**超时与未设超时**共 6 条（见下） |
| 5 | `argv` 全程数组、无 shell 参与 | ✅ 真机 + 离线 | 真机日志里 `argv` 是完整 JSON 数组、`argv[0]` 为可执行文件；`{model}`/`{effort}` 替换结果是独立元素 |
| 6 | 取消：中断时不残留孤儿进程 | ✅ 离线通过 | 新增「调用方 abort → 子进程被终止」断言 |

> 第 4、6 条此前**完全没有测试**（第 4 条的超时路径是 Phase 3 才实现的，第 6 条从未测过）。
> 本轮补了 9 条：超时真的中止进程、超时→`error` 且正文含 `timedOut=true` 与原因、
> 诊断不因超时丢失、**未设超时时绝不计时**（否则「默认 900 秒」形同虚设）、
> 调用方 abort 传到子进程。`check-cli-provider.mjs` 因此从 55 → 64 条。

**未完成部分（如实记录）：**
- Claude 与 grok 的入口及非交互调用已做历史实测（见 `cli-backends.md` §3.0 / §4.0），不能再统称未实测。Claude 本机端到端失败，`--effort` 被接受不等于强度实际生效。
- grok 已有 `grok-4.7` + `low` 调用成功记录及非法模型失败记录；其它模型/强度组合与路由生效对照**未实测**。当前预设改用 `promptFile`，本轮仅核对实现，不新增真机结论。
- 超时与取消已有离线检查，但真实 CLI 进程树是否清理干净**仍未实测**（见 `cli-backends.md` §6）。
- CLI 后端的「只读」是**声明性**的：由 CLI 自身的沙箱参数实现（codex 的 `-s read-only`，真机日志里 `sandbox: read-only` 可证），插件无法越过 CLI 强制执行。角色 `readOnly` 对 CLI 后端不产生 `toolFilter`。

## Phase 4 · 可观测性与打磨

- 调度日志：谁派的、派给谁、哪条线路、耗时、退出状态、结果摘要
- **角色设置页（D13 / D14）—— 已落地并实测可见。**
  页面：Client 半边 `settings.section`（`id: agent-switchboard`，标签「角色与派发」）。
  数据：角色文件为 `$DSH_HOME/agent-switchboard/roles.json`（`src/config-file.js`）。
  **当前设置页仍经根条目的 volatile `roles` 桥接**：读走 `configForms.describe()`
  镜像面（`ensure()` → `getSnapshot().view.namespaces`），**写**走
  `remote.settings.mutate(ns, [{op:'set',path:['roles'],value}], revision)`；Host 侧把角色
  同步到角色文件，并非客户端直接写 JSON。preset 中本插件只带 `mount: true`，不得携带 `roles`
  （`scripts/check-profile-wiring.mjs`）；启动时加载的常驻 preset 在本作用域 Cordis 角色非空时优先使用它，否则读文件。
  根实例把保存值写入文件后广播专用事件，驱动常驻 preset 代际重挂；新会话仍只继承现有 preset、不重新 apply。既有会话后续派发与下次提示组装无需重启即可取新配置，非法配置或注册失败回滚，旧代在预检/子代理/后台租约归零后释放。已执行任务与历史上下文不改写。离线集成与变异实验已覆盖，真机保存往返及在途 CLI 验收待执行。历史路径与当前机制见 `decisions.md` D14、D22 修正及 D24。
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
| R6 | 角色列表若仅放 patch，用户在 GUI 里改不了 | 与「面板配置角色」的期望有落差 | **已解决（D13 / D14）**：设置页经根配置桥接，Host 同步角色文件；preset 只带 `mount: true`，不带 `roles`；设置页已实测可见可改 |
| R7 | 外部 CLI 的额度/登录状态不透明 | 派发失败原因难定位 | 结果里保留原始 stderr 与退出码（D8），不做美化丢弃 |
| R8 | **link 模式下 Host 半边改动无法热加载** | 每次改动都需重启 dsh 才能真机验证，迭代慢 | 已实测确认（`architecture.md` 第 3.3 节）。缓解：把逻辑尽可能放进可用抽取方式验证的纯函数；Client 半边不受此限（有 HMR）；角色设置由 D24 事件驱动代际重挂，无需重启，Host 源码仍需重启一次装载 |
| R9 | **`failed to import` 会掩盖真实错误** | 排查方向被误导，可能浪费大量时间（Phase 1 已实际发生） | 已记录取证手法（`architecture.md` 第 3.2 节）：先用落地文件探针判定「模块是否已加载」，再查 `apply` 内部 |
| R10 | **插件自身缺陷可能让应用起不来** | 用户进不去，只能禁用插件；而**禁用操作会重写 profile 并丢弃条目**（实测发生两次） | `apply` 整体包一层兜底 try/catch；**不注册任何 Cordis 服务**（有测试锁死）；客户端不用自建远程命名空间；`decisions.md` D14 第 5、6 条 |
| R11 | **平台能力被「自己发明」而非「照官方实现」** | 连续三次失败、多次重启（实测发生） | 先读同构先例再动手（D14 第 8 条）；`scripts/check-profile-wiring.mjs` 之类的**显式断言**挡住「静默不存在」 |

## 与项目硬规则的对应

| 规则 | 落地位置 |
| --- | --- |
| 主代理只统合、不下场 | 主代理侧只增委派工具；写文件权限不授予主代理 |
| 跨 CLI 可指派 | Phase 3 的 `cli` provider |
| 角色与派发方式可配置 | 角色文件为 `$DSH_HOME/agent-switchboard/roles.json`；UI 经根配置读写桥接，Host 同步文件；preset 只带 `mount: true`，不得携带 `roles`；机制是每个角色自己的 `backend` 字段（D13 / D14） |
| 模型不得自由拼装 shell 命令 | `src/cli/argv.js` 只做受限占位符替换，`argv` 数组直传 `ctx.subprocess.spawn`，全程无 shell |
| `raw/` 不入库 | 已在 `.gitignore`，且 `AGENTS.md` 列为硬规则 |
