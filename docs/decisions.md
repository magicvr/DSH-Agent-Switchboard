# 技术决策记录

> 每条决策都标注**依据**。标「已核实」的依据来自对已安装 DSH（`app.asar`，v0.2.0-rc.2）的只读取证与本机实测；标「待验证」的是尚未用真实调用证实的推断。

---

## D1 · 语言与工具链：纯 ESM JavaScript，零构建

**决策：** 源码即产物，用 `.js`（ESM）+ JSDoc 类型标注。不引入 tsc/webpack/vite 构建步骤。

**依据（已核实）：**
- 官方最小插件就是纯 JS 两文件，外部插件不需要构建工具链。
- 本机安装归档内 **0 个 `.d.ts`**（15576 个文件中 grep 命中 0）。也就是说 `@deepseek-ai/dsh-*` 的**类型定义在本机根本不存在**。若采用 TypeScript，`import type { SubagentProvider } from '@deepseek-ai/dsh-subagent'` 之类会直接编译失败，必须先解决基座 `tsconfig.base.json`（也不随安装分发）与类型来源问题。
- Client 半边产物必须是单文件且调用 `window.__ModuleLoader__.load({ id: 包名, ... })`，任何打包器都必须额外保证这一点。

**结论：** 引入 TS 会在第一步就撞上「类型拿不到 + 打包格式有硬约束」两个额外风险，而它换来的收益（类型检查）在本机没有类型源的情况下几乎为零。等插件跑通、上游类型可用后再迁移不迟。

**代价与缓解：** 无静态类型。缓解手段——用 `// @ts-check` + JSDoc 在**不需要 DSH 类型**的纯逻辑模块上做检查；把 DSH 交互面收窄到少数几个薄适配文件，让类型风险集中而非弥散。

---

## D2 · 包与插件形态：dual-face 单包

**决策：** 单个包，Host 与 Client 两半边。

| 契约字段 | 取值 |
| --- | --- |
| `exports["."]` | `./src/index.js`（Host 半边） |
| `exports["./client"]` | `./src/client/index.js`（Client 半边） |
| `dsh.bundle.patch` | `./cordis.patch.yml` |
| `dsh.manifestVersion` | `1` |
| `dsh.client.platform` | `"web"` |
| `peerDependencies` | `@deepseek-ai/cordis` 等运行时强校验项 |

**依据（已核实）：** dual-face 是官方形态（`exports` 子路径 + `dsh.client`）；`peerDependencies` 上的 `@deepseek-ai/dsh*` 会被运行时校验而 `engines.dsh` 不会；`icon` 支持顶层声明（≤256 KiB）。

**待验证：** 包名与插件 id（见文末「需要拍板」）。

---

## D3 · Host 半边导出形态

**决策：** `export function apply(ctx, config)` + `export const inject` + `export const Config` + `export const name`。

**依据（已核实）：** 这是三个官方 subagent provider 包的一致导出（`export { Config, apply, inject, name }`），也是 Host 半边允许的三种形态之一，且最直接。

---

## D4 · 派发架构：统一走 `ctx.subagents`，角色映射为模型可见工具

**决策：** 不发明新的派发层，复用 DSH 的 `ctx.subagents` 服务。两类后端统一到同一个 `SubagentProvider` 抽象之下：

| backend | 实现方式 | 说明 |
| --- | --- | --- |
| `builtin` | 复用 DSH 已注册的 provider（`spawn` / `fork`） | 零额外代码，行为最可预期 |
| `cli` | **本插件自己注册一个 `SubagentProvider`** | 需要新写，见 D7 |

**为什么这是可行且正确的：**

1. `ctx.subagents` 是**具名 provider 注册表**，`registerProvider(provider)` 是公开扩展点（已核实）。
2. `SubagentRun.localAgent` 的类型是 `Agent | undefined`（已核实）。`undefined` 分支的存在本身就是「非 DSH in-process 子代理」的官方预留位——外部 CLI 子代理正是这一形态。
3. 因此 `builtin` 与 `cli` 不是两套体系，而是同一个 `start()` 调用背后换一个 provider 名字。主代理与工具层完全不需要知道线路差异。

**关键约束（已核实）：** 外部/受管 provider 在 `depthLimit` 上无法自己强制递归上限，官方 README 明确要求：这类 provider 必须声明 `capabilities.depthLimit = false`，并在工具实例上配 `maxDepth: 'provider-managed'`，否则工具侧会直接抛错拒绝装载。

---

## D5 · 角色如何变成主代理能用的工具

**决策：** 本插件**自己用 `ctx.tools.register(defineTool(...))` 为每个角色注册一个模型可见工具**，工具内部调用 `ctx.subagents.start(...)`。不挂载 `dsh-tool-subagent`。

**理由（对比两个方案）：**

| | A. 自己注册工具（选用） | B. 每角色挂载一个 `dsh-tool-subagent` 实例 |
| --- | --- | --- |
| 角色运行时可变 | 可以，角色列表变化时重新注册即可 | 需要动态挂载别的插件，机制未验证 |
| 工具描述/参数 | 完全可控，可按角色定制 | 由 `dsh-tool-subagent` 决定 |
| 需要的能力 | `ctx.tools` + `ctx.subagents`，都已核实 | `dsh-tool-subagent` 的 Config + 动态 `ctx.plugin()` 挂载，**未核实** |
| 风险 | 低 | 中：依赖未验证的装载机制 |

方案 B 的唯一优势是免费获得 `run_in_background`、presentation 等既有能力，但这些对第一期不是刚需。**方案 B 作为后备**保留在 D5-Fallback。

**父代理从哪来（已核实）：** 工具的 `execute` 里没有直接的 Agent 参数，需要通过 `ctx.agents.requireInitiator()` 取得发起该次调用链的 Agent，再作为 `SubagentStartRequest.parent` 传入。

**如果最终需要方案 B**，`dsh-tool-subagent` 的 Config 已核实为：`{ provider, toolName, modelSelectionSettings, enableRunInBackground, backgroundMode, agentOptions, persona, toolFilter, maxDepth }`，且「每个派发目标挂载一个实例、用不同的 `toolName` 区分」是官方 README 明确推荐的用法。

---

## D6 · 子进程执行：优先 `ctx.subprocess`，必要时 PTY

**决策：** CLI 后端的进程执行走 `ctx.subprocess` 服务，不足时再降级到 `spawnTerminal`（PTY）。

**依据（已核实）：** `ctx.subprocess` 明确设计为可插拔 Service（「Subclass, implement spawn, and load the subclass as a plugin」），提供：

- `resolveExecutable(command, env?, signal?)` —— 在「与挂载的文件系统同一执行世界」里解析可执行文件。**这解决了我最担心的 Windows 上 `codex.ps1` 这类脚本入口的解析问题。**
- `spawn(spec)` —— `spec.argv` 是 **argv 数组**，`cwd` 显式，`stdio` 显式，`graceMs` 显式；服务端**不施加任何默认值**。
- `spawnTerminal(spec)` —— 真实终端分配，含 `write` / `resize` / `signalForeground` / `terminate`。

**安全边界（已核实且与项目硬规则一致）：** `argv` 数组 + 显式 `cwd`，无 shell 参与，天然排除了 shell 注入。这正好落地了「模型不得自由拼装 shell 命令」这条要求。

**已知缺口（待验证）：** `spawn` 是纯管道，没有 TTY。部分 CLI 在非 TTY 下行为不同（是否需要 `-p` / `exec` 之类的非交互子命令、是否会拒绝运行）。必须对 `codex` / `claude` / `grok` 逐个实测；若必须 TTY，则改用 `spawnTerminal`。

---

## D7 · CLI provider 的能力声明（诚实降级）

**决策：** CLI provider 声明最小能力集：

```js
const capabilities = {
  agentOptions: false,   // 无法把 DSH 的 provider/model 透传给任意 CLI
  outputSchema: false,   // 无法保证从任意 CLI 文本里稳定得到结构化输出
  depthLimit: false,     // 受管进程无法强制递归上限（强制要求，见 D4）
  toolFilter: false,     // 无法控制外部 CLI 的工具集
  persona: false,        // 不谎称支持；角色提示词由本插件自己拼进 prompt
};
const inheritsParentContext = false;
```

**依据（已核实）：** `SubagentCapabilities` 是一组显式布尔位，`depthLimit` 有强制语义。谎报能力会让工具层按支持的方式调用而对端并不支持，因此宁可声明不支持。

**注意：** `persona` 声明为 `false` 只是说「不由 provider 层的 persona 机制实现」；角色提示词由本插件在构造 prompt 时自行前置，效果等价但机制不同。

---

## D8 · 结果回传：结构化契约 + 文本兜底

**决策：** 角色结果统一为 `SubagentResult { output: ContentBlock[], structured?, diagnostic?, stopReason }`。由于 `outputSchema` 不支持，`structured` 留空，`output` 为退出码信息 + stdout/stderr 文本的 `text` 块；解析失败不算失败，原文照传，另附 `diagnostic`。

**依据（已核实）：** `SubagentResult` 的字段定义；`stopReason` 取值 `completed | aborted | error | max-tokens | refusal`。

**理由：** 主代理汇总时最怕「结果被静默截断或美化」。宁可把原始输出和退出码一起递回去，也不做会丢信息的解析。

---

## D9 · 配置分两层，且必须区分 volatile

**决策：**

| 层 | 内容 | 存储 | GUI 可编辑 |
| --- | --- | --- | --- |
| 角色定义 | 角色列表：id、标题、职责提示词、backend、CLI 参数 | `cordis.patch.yml` 的插件 config | 见下 |
| 运行时旋钮 | `allowCrossCli` 总开关、超时、输出上限、CLI 可执行文件路径 | 插件 `Config`，标 `.volatile()` | ✅ |

**依据（已核实）：** `dsh-settings` **只暴露 volatile 字段**（「Forms expose only volatile fields」）。不标 `.volatile()` 的字段在设置页不会出现——这是「在插件面板配置」这条需求的硬技术前提。

**务实取舍（待你确认）：** DSH 的设置表单对「数组套对象」这类嵌套结构支持有限，角色列表做成复杂数组编辑器不现实。因此第一期：**角色列表来自 `cordis.patch.yml`（声明式、可版本控制、便于评审），运行时旋钮走插件面板可实时编辑**。若你坚持角色也要在面板里增删改，需要先确认 `dsh-config-editor` 对数组字段的实际支持程度，工期更长。

---

## D10 · Client 半边职责

**决策：** 第一期 Client 半边只做一件事——在 `conversation.composer.dock` 注入一个**只读**的开关/状态指示（`allowCrossCli` 是否开启、当前线路）。

**依据（已核实）：**
- 官方四文件模板（`templates/decoration/`）可直接照抄结构。
- **禁止 import 任何 Harness Client 包**（官方明令），只用 `--dsw-alias-*` 主题 token；Client 半边崩溃会让整个 slot 空掉。
- 真实 Slot 树必须先用 `cordis_inspect_query`（Provider `Slots`）查，不能凭记忆写 slot 名。

**为什么只做只读：** 第一期的目标是打通链路而非堆 UI。可写面板涉及配置回写链路（`config-editor` → profile patch），风险与工期都更高，放第二期。

---

## 需要你拍板（阻塞实施）

| # | 事项 | 我的建议 | 为什么需要你 |
| --- | --- | --- | --- |
| Q1 | 包名 | `@magicvr/dsh-agent-switchboard` | 发布形态是你的决定 |
| Q2 | 插件 id（`dsh.client` 与 `__ModuleLoader__.load` 必须严格等于包名，Cordis 条目 id 另取） | 包名同名，条目 id 用 `agent-switchboard` | 影响 profile 与装载 |
| Q3 | 角色列表放 `cordis.patch.yml`（D9 第一期方案）是否可接受 | 可接受 | 直接决定工期 |
| Q4 | `cli` 后端第一期先只支持一个 CLI（建议 `claude`，因为它有干净的 `-p` 非交互模式）还是三个一起 | 先一个 | 三个一起的实测成本高 |
