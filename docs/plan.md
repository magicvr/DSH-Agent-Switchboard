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

**产出：**
- `package.json`（D2 的契约字段齐全）
- `cordis.patch.yml`（一条插入条目）
- `src/index.js`：`apply` 里做一件可观测的事（例如注册一个 `switchboard_selftest` 工具，返回固定文本）
- `src/client/index.js`：`composer.dock` 注入一个只读标识

**验收（全部必须真实通过）：**
1. `plugin_manager install_bundle` 能把包装进 profile。
2. 插件出现在 Loader 条目列表里，`Config` schema 被 `cordis_inspect_query`（Provider `Config`）读到。
3. `switchboard_selftest` 工具在 `cordis_inspect_query`（Provider `Tool`）的清单里出现。
4. GUI 刷新后 `composer.dock` 能看到那个只读标识。
5. `.volatile()` 字段在设置页可编辑；非 volatile 字段**不**出现（这条用来确认 D9 的前提）。

**这一阶段的真正价值：** 一次性消灭所有「装载层」的不确定性。此后的问题都只可能是业务逻辑问题。

## Phase 2 · builtin 后端与角色工具

**目标：** 主代理能通过角色工具委派给 DSH 内置子代理，并拿回结构化结果。

**产出：**
- `src/schema.js` / `src/roles.js`：角色模型与校验
- `src/host/tools.js`：每个角色注册一个工具，内部 `ctx.agents.requireInitiator()` 取父代理 → `ctx.subagents.start(provider, request)`
- `src/host/prompt.js`：角色提示词 + 结果契约

**验收：**
1. 配三个角色（`spawn` 后端），工具清单里出现三个对应工具。
2. 真实调用其中一个，主代理收到子代理回传的文本结果。
3. 角色 `backend: cli` 但 `allowCrossCli: false` 时，工具**不注册**（而不是注册后报错）。
4. 角色 maxDepth 递归：子代理再委派时受既定上限约束，不出现无限递归。

## Phase 3 · CLI 后端

**目标：** 至少一个外部 CLI 能作为角色后端跑通。

**产出：**
- `docs/cli-backends.md`：三个 CLI 的**实测**参数表（非交互子命令、提示词传递方式、是否需 TTY、退出码语义、超时表现）
- `src/cli/*`：provider 实现
- 插件面板可配可执行文件路径与超时

**验收：**
1. 对一个真实 CLI 跑通一次完整委派，结果文本回到主代理。
2. 失败语义正确：命令不存在 / 非零退出 / 超时，分别产生可读错误，主代理不会把它当成成功。
3. `argv` 全程是数组，日志中可证明没有任何 shell 参与。
4. 取消：中断主代理时子进程被终止，不残留孤儿进程。

**先做哪个 CLI：** 建议 `claude`（`claude -p` 是干净的非交互入口）。`codex` 与 `grok` 在本机分别以 `.ps1` 与 `.exe` 形式存在，解析路径的行为可能不同，需要 `ctx.subprocess.resolveExecutable` 逐个验证。

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

## 与项目硬规则的对应

| 规则 | 落地位置 |
| --- | --- |
| 主代理只统合、不下场 | 主代理侧只增委派工具；写文件权限不授予主代理 |
| 跨 CLI 可指派 | Phase 3 的 `cli` provider |
| 角色与派发方式可配置 | `cordis.patch.yml`（角色）+ 插件面板（运行时旋钮，D9） |
| 模型不得自由拼装 shell 命令 | `src/cli/argv.js` 只做受限占位符替换，`argv` 数组直传 `ctx.subprocess.spawn`，全程无 shell |
| `raw/` 不入库 | 已在 `.gitignore`，且 `AGENTS.md` 列为硬规则 |
