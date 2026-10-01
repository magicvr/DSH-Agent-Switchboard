# DSH Agent Switchboard

> 把 DSH 主代理降级为「信息流统合器」，把具体工作委派给带角色的子代理——并且允许这些子代理活在本机的其他 CLI 里。

[![status](https://img.shields.io/badge/status-early%20design-orange)](#路线图)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

---

## 这个项目要解决什么

今天用一个编码代理干完整活，通常是这样：一个上下文里同时装着「该干什么」的规划、「具体怎么写」的实现、以及海量的文件内容与工具输出。结果是主代理的上下文被细节挤爆，注意力被稀释，人也很难判断哪一步是哪个角色做的。

这个插件想换个分工：

| 角色 | 职责 |
| --- | --- |
| **主代理（switchboard）** | 只做信息统合：理解意图、拆分任务、选角色、派发、汇总结果、向你汇报。**不亲自下场写代码。** |
| **角色子代理（role agent）** | 各自带着固定的角色定义（职责、约束、产物格式）执行一个具体任务，只把结论回传给主代理。 |

子代理不一定是 DSH 自己的。这个插件的关键设计是**跨 CLI 派发**：同一个角色可以跑在 DSH 内置子代理上，也可以派给本机已安装的外部 CLI，甚至可以让不同角色跑在不同的 CLI 上。派发方式由你在插件面板里按角色配置。

面板里的 CLI 下拉框**直接列出具体 CLI**（不是笼统的「外部 CLI」），当前提供 **Codex CLI** 与 **Grok CLI** 两个预设，外加「自定义命令」用于任何未收录的 CLI。预设只负责把命令与参数**一键填好**，填好后仍是可编辑的普通字段。

> Claude Code 的预设已移除（本项目不再使用它）。它的实测记录保留在
> [`docs/cli-backends.md`](./docs/cli-backends.md) §3，如需恢复可参考该节的参数形态，
> 或直接用「自定义命令」。

一句话：**主代理是调度台，角色是接线员，CLI 是可选的话务线路。**

## 核心设计

### 1. 角色（Role）

角色是一份声明式的配置，描述「这个子代理是谁、能干什么、要交什么」：

- **身份**：名称、一句话职责、给子代理看的系统提示词。
- **能力边界**：允许使用的工具、能否写文件、是否允许继续往下派发子代理（防止无限套娃）。
- **产物契约**：期望的回传格式（例如「结论 + 证据 + 未决问题」），便于主代理机械地汇总而不是重新读一遍全过程。
- **派发方式**：走内置子代理，还是走某个本地 CLI。

### 2. 派发方式（Dispatch）

每个角色独立选择派发后端。两种后端**收敛到同一个 `SubagentProvider` 抽象**，主代理与工具层看不到线路差异：

- **`builtin`** — 复用 DSH 已注册的子代理 provider（`spawn` / `fork`）。上下文、沙箱、权限、流式事件都由 DSH 统一管，行为最可预期，也是默认选项。
- **`cli`** — 本插件**自己注册一个 `SubagentProvider`**，通过 `ctx.subprocess` 调用外部编码代理，把提示词与工作目录交给它，再把输出收回来。适合复用你已经在别处配好的模型、额度或工具链。

> ⚠️ **`cli` 后端会真的在你的机器上执行本地命令。** 可控性来自两点：角色的 `backend` 必须被**显式**设为 `cli`，且该角色只在选中了 Switchboard preset 的会话里挂载。可执行文件与参数模板全部由你提供（或在面板里从 CLI 预设一键填好），插件不会去猜、也不会自动发现你装了哪些 CLI。
>
> 安全上有一道结构性保障：调用走的是 **argv 数组 + 显式工作目录**（`ctx.subprocess.spawn`），全程没有 shell 参与，模型只能填充受限占位符，无法拼接出任意命令。

### 3. 配置（Plugin Panel）

角色存放在**根条目的插件配置**里（即 profile patch 中 `id: agent-switchboard` 那一行的 `config.roles`），
设置面板直接读写它；Host 侧会把角色同步一份到 `$DSH_HOME/agent-switchboard/roles.json`，
供选中 Switchboard preset 的会话读取。形状如下（**示意**）：

```jsonc
{
  "provider": "self",
  "cwd": "C:\\path\\to\\workspace",
  "roles": [
    {
      "id": "scout",
      "title": "侦察员",
      "description": "只读调研：定位相关代码、给出证据路径，不做任何修改。",
      // 派发机制：内置 spawn / fork，或外部 CLI。
      "backend": "spawn",
      "readOnly": true,
      // 是否允许该角色再往下派发子代理。默认 false，防无限递归。
      "allowNestedDispatch": false
    },
    {
      "id": "architect",
      "title": "架构师",
      "description": "产出实现方案与接口约定，不写实现代码。",
      // 走外部 CLI 的角色：cli* 字段是**扁平**的（便于面板当普通标量渲染）。
      // 在面板里更简单：把「派发机制」选成「外部 CLI」，再从 CLI 下拉框选具体 CLI，
      // 下面这组参数会被一键填好。
      "backend": "cli",
      "cliDriver": "codex",
      "model": "gpt-6-luna",
      "effort": "max",
      "cliCommand": "{node}",
      "cliPrefixArgs": ["{npmRoot}\\@openai\\codex\\bin\\codex.js"],
      // 参数模板：只允许 {prompt} / {cwd} / {model} / {effort} 四个受限占位符。
      "cliArgs": [
        "exec", "-s", "read-only", "--skip-git-repo-check",
        "-m", "{model}", "-c", "model_reasoning_effort={effort}", "-"
      ],
      "cliPromptDelivery": "stdin",
      "cliCwd": "C:\\path\\to\\workspace"
    },
    {
      "id": "worker",
      "title": "实现者",
      "description": "在指定文件范围内落地实现并保证可运行。",
      "backend": "spawn",
      "readOnly": false
    }
  ]
}
```

> `cliCommand` / `cliPrefixArgs` 里的 `{node}` 与 `{npmRoot}` 由 Host 在装载期解析成真实路径，
> 因此预设不必把本机用户名写进仓库。codex 必须以 `node <codex.js>` 形式调用
> —— 它的 `.ps1` / `.cmd` 入口在 `shell: false` 下都无法 spawn（实测，见
> [`docs/cli-backends.md`](./docs/cli-backends.md) §1）。
>
> 每个 CLI 的模型取值属于**它自己的命名空间**，插件不提供默认值：
> codex 用 `gpt-6-luna` 这类网关模型名，grok 用 `grok-4.7`（`grok models` 可列）。
> 换 CLI 后必须一并改模型，否则会以退出码 1 失败。

### 4. 主代理的约束

「主代理不下场」这件事需要被机制保证，而不是靠提示词自觉。规划中的手段：

- 主代理默认拿不到写文件类工具（DSH 提供 `ctx.tools.restrict()` 隐藏工具、`ctx.tools.guard()` 同步拒绝调用，见 [`docs/architecture.md`](./docs/architecture.md) 第 3 节）。
- 派发出去的每个任务都要求子代理回传结构化结果，主代理汇总的是结果而不是原始过程。
- 每次派发都记录「谁派的、派给谁、走哪条线路、耗时、成功与否」，形成可审计的调度日志。

## 实现约束（已核实）

这些是从已安装的 DSH 里取证得到的硬事实，直接决定了插件怎么写，细节与证据见 [`docs/architecture.md`](./docs/architecture.md) 第 3 节：

- **外部插件不需要构建工具链。** 最小可用插件只有两个文件（`package.json` + `cordis.patch.yml`），纯 JS 即可安装运行。目录结构本身没有强制约定。
- 真正有约束力的是 `package.json` 里的三个契约字段：`exports["."]`（Host 半边）、`exports["./client"]` + `dsh.client`（Client 半边）、`dsh.bundle.patch`。
- **角色配置面板必须走 Client 半边**，且要能在 GUI 里实时编辑的字段必须标 `.volatile()`——DSH 的设置页只暴露 volatile 字段。
- 运行时强制校验的是 `peerDependencies` 里的 `@deepseek-ai/dsh*`；`engines.dsh` 不被校验，不要写。

**最关键的一条：** DSH 的 `ctx.subagents` 是一个**具名 provider 注册表**，`registerProvider()` 是公开扩展点，而 `SubagentRun.localAgent` 的类型是 `Agent | undefined`。这个 `undefined` 分支就是「非 DSH 子代理」的官方预留位——**跨 CLI 派发不需要绕开内置机制，它就是内置机制的一个 provider。**

> 包名为 `@magicvr/dsh-agent-switchboard`，`package.json` 已落地并已 link 进 profile。决策清单见 [`docs/decisions.md`](./docs/decisions.md)。

## 路线图

分四期，每期都有必须真实通过的验收标准，见 [`docs/plan.md`](./docs/plan.md)。

- [x] **Phase 0 · 设计与取证** — 仓库初始化、摸清 DSH 契约、技术决策与实施方案定型
- [x] **Phase 1 · 最小可加载插件** — Host 与 Client 两半边均已生效
- [x] **Phase 2 · builtin 后端** — 5 条角色工具上线；模型按角色切换已用会话记录实证（详见 [`docs/plan.md`](docs/plan.md)）
- [~] **Phase 3 · CLI 后端** — provider、参数模板、输出解析均已实现并通过**真实 codex 端到端**验证（14/14）；接入插件的人类可读验收待一次重启
- [ ] **Phase 4 · 可观测性与打磨** — 调度日志、可写面板、并发预算

## 仓库布局

```
.
├── docs/
│   ├── architecture.md   已核实的 DSH 插件契约与取证
│   ├── decisions.md      技术决策记录 D1–D10
│   └── plan.md           目录结构、分期实施方案、验收标准、风险登记
├── scripts/              只读取证探针（见 AGENTS.md）
└── raw/                  临时草稿区，已被 git 忽略，不进入历史
```

`src/`、`test/` 在 Phase 1 落地，结构与理由见 [`docs/plan.md`](./docs/plan.md#目录结构)。

## 本地约定

- `raw/` 是临时区：抓取产物、一次性实验、临时素材丢这里。它被 `.gitignore` 忽略，随时可以清空，**不要**把需要长期保留的东西放在这里。
- 文本文件统一以 LF 入库（见 `.gitattributes`）；Windows 下如需 CRLF 由各人本地 git 配置决定。
- 提交信息、分支约定见 [`CONTRIBUTING.md`](./CONTRIBUTING.md)。

## 许可证

[MIT](./LICENSE) © 2026 magicvr
