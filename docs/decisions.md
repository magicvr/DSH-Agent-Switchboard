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

**待验证：** 无。包名已定为 `@magicvr/dsh-agent-switchboard`（见「已拍板」Q1/Q2）。

---

## D3 · Host 半边导出形态

**决策：** `export function apply(ctx, config)` + `export const inject` + `export const Config` + `export const name`。

**依据（已核实）：** 这是三个官方 subagent provider 包的一致导出（`export { Config, apply, inject, name }`），也是 Host 半边允许的三种形态之一，且最直接。

---

## D4 · 派发架构：统一走 `ctx.subagents`，角色映射为模型可见工具

> **被取代范围：** CLI 自注册 provider 及其 provider-managed 深度约束已被 [D18](#d18--cli-改为内置-spawn-包裹与角色专属工具批次-3a) 的内置 spawn 包裹取代；下文仅保留历史。

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

> **被取代范围：** CLI provider 能力声明随旧 provider 移除，当前内置 spawn 包裹与专属工具边界见 D18；历史理由保留。

**决策：** CLI provider 声明最小能力集：

```js
const capabilities = {
  agentOptions: false,   // 不承载 DSH 的 AgentOptions 路由，见下方澄清
  outputSchema: false,   // 无法保证从任意 CLI 文本里稳定得到结构化输出
  depthLimit: false,     // 受管进程无法强制递归上限（强制要求，见 D4）
  toolFilter: false,     // 无法控制外部 CLI 的工具集
  persona: false,        // 不谎称支持；角色提示词由本插件自己拼进 prompt
};
const inheritsParentContext = false;
```

**依据（已核实）：** `SubagentCapabilities` 是一组显式布尔位，`depthLimit` 有强制语义。谎报能力会让工具层按支持的方式调用而对端并不支持，因此宁可声明不支持。

**注意：** `persona` 声明为 `false` 只是说「不由 provider 层的 persona 机制实现」；角色提示词由本插件在构造 prompt 时自行前置，效果等价但机制不同。

### 澄清：`agentOptions: false` 不代表「不支持选模型」

早期版本的 D7 把 `agentOptions: false` 的理由写成「无法把 DSH 的 provider/model 透传给任意 CLI」，并据此暗示外部 CLI 无法选模型——**这个结论是错的**，在 D12 中修正。

两者是**不同的命名空间**：

| | DSH 的 `AgentOptions` | 外部 CLI 的模型/强度 |
| --- | --- | --- |
| 形态 | `{ provider, model, reasoningEffort }` | 各自的 flag，如 `-m`、`--model`、`--effort`、`-c model_reasoning_effort=` |
| 命名空间 | DSH 的 LLM route（如 `deepseek-official/deepseek-v4-flash`） | 该 CLI 自己的模型 id（如 `gpt-6-luna`） |
| 本插件是否透传 | **否**，声明为不支持 | **是**，走 D12 的独立字段 |

因为我们不通过 `dsh-tool-subagent` 派发（D5），`capabilities` 这组标志对实际派发路径不构成约束；它的作用是「如有人拿本 provider 配 `dsh-tool-subagent` 实例，工具层会据此正确拒绝 `agentOptions` 请求」。

---

## D12 · 外部 CLI 的模型与思考强度：独立字段，角色固定

**背景（已核实，2026-02 本机实测）：**

| CLI | 模型 | 思考强度 | 备注 |
| --- | --- | --- | --- |
| `codex` | `-m, --model <MODEL>` | **无专用 flag**，只能 `-c model_reasoning_effort=<值>` | `--help` 与 `codex exec --help` **完全未提及** reasoning/effort；真实配置 `~/.codex/config.toml` 含 `model_reasoning_effort = "max"` 与 `enabled-reasoning-efforts = ["low","medium","high","xhigh","ultra","persistent","max"]` |
| `claude` | `--model <model>` | `--effort <level>` | help 明示取值 `low, medium, high, xhigh, max` |
| `grok` | `-m, --model <MODEL>` | `--reasoning-effort <EFFORT>`（别名 `--effort`） | `grok models` 可列出可用模型 |

**决策 1 · 模型与强度是结构化字段，不是塞进 `args` 的裸字符串。**

理由：三者 flag 形态完全不同（尤其 codex 走 `-c key=value` 而另两个走专用 flag）。若只提供 `args` 数组，每个角色都得手写各自 flag，无法校验、无法给默认值、面板里也无法结构化配置。

```jsonc
"cli": {
  "command": "codex",
  // 数组元素级占位符替换，全程无 shell
  "args": ["exec", "{prompt}"],
  "modelFlag": ["-m"],                                  // 模型名作为独立 argv 元素
  "effortFlag": ["-c", "model_reasoning_effort={effort}"],
  "model": "gpt-6-luna",
  "effort": "max",
  "cwd": ".",
  "timeoutSec": 900
}
```

`{model}` / `{effort}` 的替换**始终发生在一个完整 argv 元素内部**，替换结果永不参与字符串拼接，因此 D4 的安全模型（argv 数组、无 shell）完全不受影响。

**决策 2 · 模型与强度由角色配置固定，主代理无权覆盖。**

理由：主代理按设计只做信息统合，不该有成本决策权。这也让工具 schema 不出现模型参数，避免主代理把「选模型」当成一种能力去试探。DSH 自身的子代理模型选择有 `subagentModelSelection` 设置与每实例的 `modelSelectionSettings` 开关，本插件对应地把这项权力收归角色配置。

**决策 3 · 强度用本插件的统一枚举，并显式声明可映射性。**

统一枚举（界面与配置里用同一套词）：

```
minimal | low | medium | high | xhigh | max
```

- 每个 CLI 后端声明 `effortValues`：该后端实际接受的档位。
- 若角色配置的强度**不在该后端的 `effortValues` 内** → **装载/校验期直接报错**，绝不静默降级（静默降级会让「我设了 max 却跑在 low」变成无法察觉的事实）。
- 若某后端某档位无对应值（例如 `codex` 的 `minimal`）→ 视为该后端不支持该档位，同样报错，由用户在角色配置里改。

**诚实的限制（已核实）：** `enabled-reasoning-efforts` 是 codex 的**桌面端每模型**设置，说明**可用档位随模型变化**，并非固定集合。因此：

- 本插件的 `effortValues` 是**保守声明**，取该 CLI 文档化或已实测的交集；它是「本插件保证能映射的档位」，不等于「该 CLI 在该模型上支持的全部档位」。
- 若某 CLI 在该模型上拒绝某档位，错误会在 CLI 侧产生，本插件通过 D8 的机制保留其原始 stderr 与退出码，**不美化、不吞掉**。
- 各 CLI 的最终档位表必须实测后写入 `docs/cli-backends.md`，不得凭推测填写。

### 实测证据留档（2026-02，本机）

保留原始取证，供 Phase 3 直接使用，避免重复调查：

| 事实 | 证据来源 |
| --- | --- |
| `codex -m, --model <MODEL>` 存在 | `codex --help` 输出 |
| `codex` 的 help（含 `codex exec --help`）**零次**出现 `reasoning` / `effort` | 对两处 help 全文检索，命中 0 |
| codex 接受 `model_reasoning_effort` | `~/.codex/config.toml` 含 `model_reasoning_effort = "max"` |
| codex 档位随模型变化 | 同文件 `[desktop] enabled-reasoning-efforts = ["low","medium","high","xhigh","ultra","persistent","max"]` |
| `codex exec` 支持 `--json`、`--output-schema <FILE>`、`-o/--output-last-message <FILE>`、`-C/--cd <DIR>`、`-s/--sandbox` | `codex exec --help` |
| `claude --model <model>`、`--effort <level>`，档位 `low, medium, high, xhigh, max` | `claude --help`（help 明示取值） |
| `claude --fallback-model` 可用 | `claude --help` |
| `grok -m, --model <MODEL>`、`--reasoning-effort <EFFORT>`（别名 `--effort`） | `grok --help` |
| `grok models` 子命令可列出可用模型 | `grok --help` |

> ⚠️ 上表**只证明参数存在**，不证明「指定后确实生效」。Phase 3 的验收标准第 2 条要求用真实调用验证生效，不能只看退出码为 0。
>
> 另注：本机 `codex` 的入口是 PowerShell 脚本 `%APPDATA%\npm\codex.ps1`（内部转发到 `@openai/codex/bin/codex.js`），不是 `.exe`。实测运行时会打印 `failed to clean up stale arg0 temp dirs` 与 `could not create PATH aliases` 的警告，但命令仍正常返回——`ctx.subprocess.resolveExecutable` 对这类脚本入口与这些 stderr 噪音的处理方式必须在 Phase 3 单独确认。

---

## D8 · 结果回传：结构化契约 + 文本兜底

**决策：** 角色结果统一为 `SubagentResult { output: ContentBlock[], structured?, diagnostic?, stopReason }`。由于 `outputSchema` 不支持，`structured` 留空，`output` 为退出码信息 + stdout/stderr 文本的 `text` 块；解析失败不算失败，原文照传，另附 `diagnostic`。

**依据（已核实）：** `SubagentResult` 的字段定义；`stopReason` 取值 `completed | aborted | error | max-tokens | refusal`。

**理由：** 主代理汇总时最怕「结果被静默截断或美化」。宁可把原始输出和退出码一起递回去，也不做会丢信息的解析。

---

## D9 · 配置分两层，且必须区分 volatile

> **被取代范围：** 运行时 cliTimeoutSec 已由 D17 移除；包裹路由、Jobs 回流与清理生命周期分别见 D18 / D19 / D20。本节表格保留历史，不代表当前字段。

> **历史方案已被后续决策取代：** 下文「第一期角色列表来自 `cordis.patch.yml`」及复杂数组编辑器不可行的取舍，已被 D13 / D14 的自建设置页覆盖；原文保留。
> 当前角色文件为 `$DSH_HOME/agent-switchboard/roles.json`，设置页仍经根配置桥接并由 Host 同步文件，preset 只携带 `mount: true`、不得携带 `roles`。依据见 D14 的当前实现补记。

**决策：**

| 层 | 内容 | 存储 | GUI 可编辑 |
| --- | --- | --- | --- |
| 角色定义 | 角色列表：id、标题、职责提示词、backend、CLI 参数 | 根条目的插件 `config.roles` | ✅（自建设置页，见 D14） |
| 运行时旋钮 | `cliTimeoutSec`、输出上限、CLI 可执行文件路径 | 插件 `Config`，标 `.volatile()` | ✅ |

> ⚠️ 本表曾包含 `allowCrossCli` 总开关。**该字段已移除**（见 D14 与本文件末的说明）：
> 它后来在面板上被拿掉、却仍在执行期拦截 CLI 角色的挂载，于是角色永远挂不上而界面只显示
> 「工具不存在」。现在「走不走外部 CLI」由角色的 `backend` 显式表达。

**依据（已核实）：** `dsh-settings` **只暴露 volatile 字段**（「Forms expose only volatile fields」）。不标 `.volatile()` 的字段在设置页不会出现——这是「在插件面板配置」这条需求的硬技术前提。

**务实取舍（待你确认）：** DSH 的设置表单对「数组套对象」这类嵌套结构支持有限，角色列表做成复杂数组编辑器不现实。因此第一期：**角色列表来自 `cordis.patch.yml`（声明式、可版本控制、便于评审），运行时旋钮走插件面板可实时编辑**。若你坚持角色也要在面板里增删改，需要先确认 `dsh-config-editor` 对数组字段的实际支持程度，工期更长。

---

## D10 · Client 半边职责

**决策：** 第一期 Client 半边只做一件事——在 `conversation.composer.dock` 注入一个**只读**的开关/状态指示（当时是 `allowCrossCli` 是否开启、当前线路）。

> ⚠️ 该只读指示所反映的 `allowCrossCli` **已移除**，因此这一期形态已被 D13（角色设置页）
> 取代。保留本节是为了记录当时的取舍依据。

**依据（已核实）：**
- 官方四文件模板（`templates/decoration/`）可直接照抄结构。
- **禁止 import 任何 Harness Client 包**（官方明令），只用 `--dsw-alias-*` 主题 token；Client 半边崩溃会让整个 slot 空掉。
- 真实 Slot 树必须先用 `cordis_inspect_query`（Provider `Slots`）查，不能凭记忆写 slot 名。

**为什么只做只读：** 第一期的目标是打通链路而非堆 UI。可写面板涉及配置回写链路（`config-editor` → profile patch），风险与工期都更高，放第二期。

---

## 已拍板（2026-02，阻塞项已解除）

| # | 事项 | 决定 | 影响 |
| --- | --- | --- | --- |
| Q1 | 包名 | **`@magicvr/dsh-agent-switchboard`** | 写入 `package.json` |
| Q2 | 插件 id | 包名同名用于 `dsh.client` 与 `__ModuleLoader__.load`；Cordis 条目 id 用 `agent-switchboard` | 两者必须区分：前者**严格等于包名**，后者是 profile 里的条目标识 |
| Q3 | 角色列表位置 | **`cordis.patch.yml`（D9 第一期方案）**，面板只管运行时旋钮 | 增删角色需改配置并重载；Phase 4 再评估可写面板 |
| Q4 | CLI 首个目标 | **`codex`** | 本机入口是 `codex.ps1`，因此 Phase 3 必须先用 `ctx.subprocess.resolveExecutable` 验证脚本入口解析（风险 R3 由「可能」升级为「必经」） |
| Q5 | 嵌套派发 | **默认禁止，按角色逐个放开** | 详见下方 D11 |
| Q6 | 角色的派发机制（内置 / 外部 CLI）是否可在界面配置 | **可以，但需自建设置页**（DSH 自动表单不支持变长对象数组） | 详见 D13；与风险 R6 同一件事 |

> **Q3 已被后续决策取代（D13 / D14）：** 上表保留当时裁决，不代表当前待办。角色与派发设置页已落地；当前文件、根配置桥接与 preset 挂载分工见 D14，Phase 4 不再等待评估可写面板。

## D11 · 嵌套派发默认关闭，逐角色放开

> **后续修正：** 本节历史深度落地方式及主代理总深度结论以 [D21](#d21--入站深度预算与出站委派权限分离) 为准；默认关闭的角色开关保留。主代理的非受控入口不由本插件过滤。

> **被取代范围：** CLI provider 的 provider-managed / 提示词派发限制已随 D18 的 spawn 包裹取代；当前数字深度与工具过滤见 architecture.md 第 6 节。本轮 D20 不改深度或权限语义，外部 CLI 自身递归行为仍不由 DSH 机制保证。

**决策：** 新增角色字段 `allowNestedDispatch`，**默认 `false`**。默认情况下角色子代理不得再往下派发子代理，需按角色显式开启。

**依据与收益：**

1. **成本可控**：默认状态下不可能因一次派发意外炸出指数级的子代理调用与额度消耗。
2. **与 D4/D7 自洽**：`cli` provider 本就声明 `depthLimit: false`（无法强制递归上限），而 `builtin` provider 的 `depthLimit: true` 意味着它**可以**强制。默认关闭 + 显式放开，让「谁被允许递归」成为一个清晰的人工决定，而不是继承来的默认值。
3. **实现更简单**：默认路径只涉及一层 `ctx.subagents.start()`。

**落地方式：**
- `builtin` 后端：通过 `SubagentStartRequest.maxDepth` 传给provider（`spawn`/`fork` 都支持 `depthLimit`），值为 `0` 即禁止再派发。
- `cli` 后端：无法由 provider 强制，因此**由本插件在构造 prompt 时不注入任何委派能力**，并在角色提示词里明确禁止；这是「提示词级」而非「机制级」约束，必须在文档与界面上如实标注。
- 主代理自身的委派总深度仍受 DSH 的 `subagentModelSelection` / 工具侧 `maxDepth` 约束（Host 默认 `1`）。

> ⚠️ 诚实标注：`cli` 后端下嵌套禁止的强度**弱于** `builtin`。外部 CLI 是否真的会去派发子代理，本插件无法从机制上阻止，只能从提示词与环境上限制。这是选择 `cli` 后端本身带来的固有代价。

## D13 · 角色的派发机制作为可配置项，并自带设置页

**背景与用户诉求：** 「希望可以让用户配置**角色**使用内置代理还是外部 CLI」，而不是让「内置角色」与「CLI 角色」成为两套并列的东西——即**角色是语义实体，机制是它的一个可切换属性**。

**先澄清一个被测试配置造成的错觉：** 机制可切换这件事**今天就是成立的**。`Config.roles[].backend` 取值 `'spawn' | 'fork' | 'cli'`（默认 `'spawn'`），是**每个角色自己的字段**。仓库里一度同时存在 `scout`（`spawn`）与 `codex-scout`（`cli`）两个条目，那只是为了做 A/B 机制对比而**复制**出来的，**不是**设计要求。把 `backend` 改成 `'cli'` 并填 CLI 参数，同一角色的 `id` 与工具名（`delegate_to_scout`）都不变。**真正缺的不是能力，是编辑入口。**

**决策：** 自建一个 Client 半边的 `settings.section` 页面来编辑角色及其派发机制，通过 `configForms` 写回配置。**不**依赖 DSH 的自动配置表单。

### 依据：两条已实测的硬约束（决定了不能走自动表单）

1. **volatile 字段不得出现在数组元素内部。** 逐行复刻客户端 `validateVolatileSchema` 验证：
   - `roles` **数组整体** `.volatile()` → ✅ 合法（路径固定为 `["roles"]`）
   - 元素内部标 volatile（如 `backend.volatile()`）→ ❌ 抛
     `volatile fields require a fixed object path without an enclosing volatile field @ ["roles","*","backend"]`
   - 机制：遍历 `schema.list` / `schema.inner` 时会把 `blocked` 置为 `true`，其后任何 volatile 节点都报错。
2. **自动配置表单只处理标量。** `ConfigFormController.set(field, value)` / `unset(field)` 的文档原文是
   `@param field - scalar field inside the namespace section`。变长对象数组渲染不了。

### 但服务端**支持**数组编辑（这是本决策可行的关键）

`dsh-settings` 的路径机制识别数字下标并支持增删：

```js
if (!/^(0|[1-9][0-9]*)$/.test(head) || ...) // 识别 roles[0]
if (rest.length === 0 && op.op === "unset") result.splice(index, 1); // 删除元素
```

原文注释：**「unsetting an array index removes its element」**。因此 `roles[0].backend` 这类路径与增删角色都能写回。**缺的只是 UI。**

### 接入点（DSH 已提供，无需自造机制）

| Slot | 用途 |
| --- | --- |
| `settings.section` | 一个设置页。现有占用：`account` / `general` / `models` / `plugins` / `agent-presets`。注册 `{id, order, label}`，`id` 用自己的即并列新增，复用已占用 id 会**替换**该格 |
| `settings.general.item` | General 里的一行偏好（单设置项，无需独立页）。locale→Language、ui-theme→Appearance 即此 |
| `settings.plugins.tab` | Plugins 区里的一页 |
| `configForms.get(entryId)` / `.describe()` / `.mutate(ops, expectedRevision)` | 读写某个插件条目的配置；`mutate` 承载数组下标路径 |

**官方同构先例：** `agent-presets` 本身就是一个 `settings.section`，用 `configForms` 编辑预设配置。本决策做的是同一类事，不是新机制。

### 落地方式（Phase 4）

1. Client 半边新增一个 `settings.section`（`id` 用自己的，如 `agent-switchboard`）：
   - 列出当前 `roles`，每个角色一行：`id`、`backend`（内置 spawn / fork / 外部 CLI）、`model`、`effort`、`readOnly`、`allowNestedDispatch`
   - `backend === 'cli'` 时展开 CLI 专属字段（命令、参数模板、提示词传递方式、cwd）
   - 提供增删角色
2. 写入走 `configForms.get('agent-switchboard').mutate([...])`，路径形如 `roles[2].backend`。
3. **只暴露合法值**：后端选择器只能给出 `spawn` / `fork` / `cli`；`effort` 只能给出 `EFFORT_VALUES`。装载期校验（`normalizeRole`）仍保留为最后一道防线——UI 不该是唯一校验。
4. Client 半边**禁止 import 任何 Harness Client 包**（`docs/architecture.md` 第 3 节），表单需自绘；只可用 `--dsw-alias-*` 主题 token。

### 为什么不在这一轮做

- Phase 3 刚收口，而 Phase 4 本就是「可观测性与打磨」，此项与风险登记 **R6**（「角色列表放 patch，用户在 GUI 里改不了」）是同一件事的具体解法，应一并处理。
- 自绘表单是 Client 半边的工作量，且 Client 半边抛错会让整个 slot 空掉——需要按第 3 节的约束谨慎实现与验证。

### 立即执行的部分（不需重启验证）

把仓库/配置里那个 A/B 测试造成的角色 fork 收敛掉：让同一语义角色通过 `backend` 表达机制，而不是复制成两个条目。这是配置改动，不是代码改动。

### 未落地的替代方案（记录以免重复评估）

- **扁平化 schema**：把机制提到顶层标量（如 `dispatch: { scout: 'cli' }`）以复用自动表单。可行但要求角色 id **预先固定**，增删角色仍须改文件；且把「机制」与「角色」在配置形状上拆成两处，反而弱化了「机制是角色属性」这一诉求。故不采用。
- **保持纯 patch 配置**（原 D9 方案）：可版本控制、可评审，但用户明确要求界面里可配机制。作为回退保留。

---

## D14 · 角色配置的存储与读写通道（对 D13 的修正，含三次失败的原因）

> **记录性质与当前实现补记：** 下文保留当时落地路径与事故取证。第 1、6 条关于 profile 根条目必须携带 `config.roles`、文件仅为派生产物的描述，是历史实现路径，已由后续文件存储与配置桥接实现修订；不能据此要求 bundle / preset 再携带角色列表。
>
> - 当前角色文件为 `$DSH_HOME/agent-switchboard/roles.json`（`src/config-file.js:63`）。bundle 根条目启用且不携带 config；preset 中本插件只带 `mount: true`（`presets/switchboard.patch.yml:18`），不得带 `roles`（`scripts/check-profile-wiring.mjs:115`）。
> - **设置页并未直接读写文件。** 它仍读 `configForms` 的根命名空间 `roles`，写 `settings.mutate`（`src/client/index.js:294`、`:432`）；Host 根实例对非空 Cordis 角色做校验、比对并同步文件，根配置为空时保留已有文件（`src/index.js:788`）。
> - 挂载实例仍兼容非空的本作用域 Cordis 角色，并优先于文件；标准 preset 不携带角色，因此走文件（`src/index.js:849`）。保存不等于已挂载会话立即更新角色工具。
> - 第 6 条所引 profile 检查的当前断言是 bundles / dependencies、bundle 条目启用、preset `mount:true` 且无 `roles`，以及角色文件可解析；不再断言 profile 根条目必须带 `config.roles`（`scripts/check-profile-wiring.mjs:58`、`:79`、`:96`、`:121`）。

**为什么要有这一条：** D13 把「自建 Client 设置页 + `configForms` 写回」定为方案，但落地时连续踩到三类失败，最终**推翻了 D13 中关于存储位置与通道的具体判断**。D13 的**目标**不变（机制是角色的属性、要有 UI 配置入口），改的是**做法**。以下是已核实的事实，替代 D13 中相应的推断。

### 1. 历史实现：角色存在**根条目的 Cordis 配置**里，文件是派生产物

角色放在 profile patch 中根条目（`id: agent-switchboard`）的 `config.roles`。Host 侧在根条目装载时把角色**同步到** `$DSH_HOME/agent-switchboard/roles.json`；preset 会话优先读自己的 Cordis 配置，为空则回落该文件。

**为什么存储位置只能是根条目**（两条实测）：

- `configEditor.entries()` 只取 `parent.tree.ctx.fiber.entry?.id === "include"` 的条目
  （源码第 31 行）。**preset 内的插件声明不在这个集合里**，因此既没有 settings 行、
  也读不到写不到。
- 客户端唯一的写通道是 `settings`，而它的 `ns` 就是 `entry.options.id`。因此能被 UI
  读写的**只有根条目**。

**为什么不再只用文件：** 用户希望「UI 直接编辑那个 JSON 文件」。做不到，原因是下一条。

### 2. 客户端**无法写文件**，也**无法新增自己的远程命名空间**

- 客户端可用的远程命名空间是**构建期生成的静态清单**（`dsh-api-remotes/lib/client.js`
  里一个硬编码的 contribution 数组），且客户端**没有 Proxy** —— 源码注释原文：
  「no JavaScript Proxy participates in method lookup, invocation, or type exposure」。
  实测清点恰好 **29 个**命名空间。
- 那份清单里 `workspaceFiles` 只有 `read` / `readBytes` / `stat` / `list` / `changes`
  —— **客户端没有任何写文件的能力**。
- 唯一的写通道是 `settings`（`mutate` / `replace` / `update`），写的是**插件配置**。

**因此 D13 里「自建远程服务供设置页调用」这条路根本不通**。`src/config-service.js`
（`RoleConfigService`）已删除：它注册的 `roleConfig` 远程方法客户端**调不到**，
而它先后造成两次启动失败（见第 5 条）。

### 3. 官方同构先例与**正确的读写分工**

官方「模型」设置页（`@deepseek-ai/dsh-client-ui-settings-models`）就是同类页面，它的做法是：

```js
const inject = [ ..., "remote.llm", "remote.settings", "remote.session", "configForms", ... ];
const controller = new ModelsSettingsStore(ctx, schema, ctx.configForms.describe());
ctx.remote.$on("settings/document-updated", () => { ... });
```

其 `load()` 的读取形态：

```js
await this.describeFace.ensure();                 // 异步补全镜像
const mirrored = this.describeFace.getSnapshot();
if (mirrored.view === void 0) … "settings are unavailable in this browser"
const views = mirrored.view.namespaces;           // ns → view
const writable = mirrored.view.writable;
```

写入则是 `ctx.remote.settings.mutate(ns, ops, expectedRevision)`。

**结论：读走 `configForms.describe()` 的镜像面，写走 `remote.settings.mutate`。**
只用 `remote.settings.describe()` 读是错的 —— 实测表现是页面报「取不到 remote.settings 通道」。
`ensure()` 是**异步**的，首帧通常还没有自己的行，必须先 `await` 再取 snapshot，
并订阅镜像以便补全后自动重读。

`settings.mutate` 的签名与路径操作形状已由运行时确认（Provider `Service`）：

```
mutate(ns, ops: readonly SettingsPathOp[], expectedRevision?) : Promise<void>
SettingsPathOp = { op:'set', path: readonly string[], value: unknown } | { op:'unset', path: readonly string[] }
```
其文档同时确认「unsetting an array index removes its element」，因此增删角色可用路径操作完成。

> **未验证：** `configForms.describe()` 返回的镜像面**自身**是否也提供 `mutate`
> （即能否完全不依赖 `remote.settings` 就写回）。官方 models 页两者都注入，因此没有
> 现成例证；本文档不对此下结论。

### 4. `settings` 命名空间是 `entry.options.id`，**不带 `include:` 前缀**

`plugin_manager` 显示的 `include:agent-switchboard` 是展示层的组合形式；settings 行的
`ns` 取的是 `entry.options.id`。实测证据：本机 20 个 settings 命名空间全部不带前缀
（`agent-switchboard`、`agent-preset-registry`、`ui-settings` …）。

### 5. `inject` 只许声明**内核保证存在**的依赖 —— 这是两次启动失败的分界

| 依赖 | 由谁保证装载期存在 | 能否进 `inject` |
| --- | --- | --- |
| `slots` / `configForms` / `remote.settings` | 内核插件 | ✅ 官方页面也这么注入 |
| `remote.roleConfig`（自建、延迟注册） | **我们自己** | ❌ 客户端永远 pending |

判据是**由谁保证它在装载期存在**，不是名字里有没有 `remote.`。两次真实事故：

1. 客户端把自建的 `remote.roleConfig` 写成必需注入，而 Host 侧延迟注册 →
   客户端永远 pending → `web boot: 1 entry did not activate`，整页起不来。
2. Host 侧曾在**每个作用域**注册服务；`Service` 的构造函数会**同步**调用
   `ctx.reflect.provide()`（已核实 cordis 源码），而 preset 路径每个会话都走 →
   注册失败即会话失败 → 应用起不来，用户只能禁用插件。

**现状：本插件不再注册任何 Cordis 服务**（有测试断言 `ctx.reflect.provide` 一次都不被调用），
且 `apply` 整体包了一层兜底 try/catch —— **插件的失败绝不能升级成「应用不可用」**。

### 6. 历史实现：两个 profile 层的承载点，缺一即「静默不存在」

| 位置 | 作用 | 缺失后果 |
| --- | --- | --- |
| `dsh.profile.bundles` **含本包** | Loader 才会加载本包的 patch | 条目根本不被创建；**应用正常但插件不存在**，无任何报错 |
| profile patch 里根条目带 `config.roles` | UI 可读写的角色数据 | 设置页找不到配置行 |

`dsh.profile.bundles` 与 `dependencies` 是**两处**，只加后者不够。已由
`scripts/check-profile-wiring.mjs` 断言锁死（在找不到 profile 时优雅跳过，不污染其它环境）。

### 7. 作用域：`mount` 决定「工具是否在本作用域挂载」

根条目 `mount: false`（只承载配置），preset 声明 `mount: true`。因此角色工具**只在选中
本 preset 的会话里出现**，其他 preset 的会话不会被污染。默认 `false` 是刻意的：漏配的
后果是「工具没出现」（显式、可发现），而默认 `true` 的后果是「工具出现在所有会话」（隐性）。

### 8. 教训（方法层面，比上面任何一条都重要）

这一轮连续三次失败，根因不是知识不足，而是**方法错误**：

> **遇到「平台能力应该怎么用」的问题，第一动作必须是读官方实现，而不是设计自己的方案。**

三次都是自己试通道（自建远程服务 → 猜 `remote.settings.describe()` → 猜 slot ctx），
而官方页面早把正确写法摆在那里。用户一句「官方『模型』页是怎么做的？」直接结束了三轮
试错。**先读同构先例，再动手。**


---

## D15 · 脚本路径与目录分类

**决策：** 按 `docs/plan.md` 的既有布局扩展 `scripts/lib/`、`ops/`、`probes/`。
共享模块统一解析路径和校验用户提供的 CLI JSON 配置，离线 `check-*.mjs` 保留在脚本根目录。
批次 1 不移动已有脚本；有写入副作用的运维脚本与环境探针在批次 2 归类。

**依据（已核实）：** 四个 check 脚本和两个 ASAR 入口含本机路径；`configPathFor(home)`
只依赖 Node 模块，CLI 参数校验已有 `src/cli/argv.js` 权威实现，可直接复用。

**路径契约：** 仓库根从模块 URL 推导。home 按 `--home` → `DSH_HOME` →
`os.homedir()/.dsh`，profile 按 `--profile` → `home/profiles/desktop`，patch 按
`--patch` → `profile/cordis.patch.yml`，roles 按 `--roles-file` → `configPathFor(home)`，
CLI cwd 按 `--cwd` → 用户 CLI 用例配置 → 仓库根。profile 不反推 home。
显式相对路径以启动 cwd 为锚点，不做 shell 展开；缺值、冲突、空白或无效配置直接报错，
homedir 不可用时要求 `--home`/`DSH_HOME`，不回退 cwd。解析不创建目录、不读取 roles，
执行前显示路径及来源。默认未安装 profile 可跳过，显式目标缺失必须失败。

CLI 配置只按 `--cli-config` → `SWITCHBOARD_CLI_CONFIG` 读取，未提供即报错，建议使用
已被忽略的 `*.local` 文件。格式为 `{command, prefixArgs, cases: {用例名: {args,
promptDelivery, cwd?}}}`；数组须为字符串数组，占位符复用 argv.js 白名单。
调用方使用 `spawn(command, argv, {shell:false})`，不读取 `.env`、不扫描安装位置后执行。

ASAR 保留 `DSH_ASAR` 覆盖（指定文件缺失不回退）；Windows 默认使用
`LOCALAPPDATA/Programs/DeepSeek Harness/resources/app.asar`，缺 LOCALAPPDATA 时由
homedir 的 `AppData/Local` 推导。后缀来自已有实现；非 Windows 要求显式 DSH_ASAR。

**代价与缓解：** 共享模块成为脚本依赖，错误目标将更早失败；用注入 env/cwd/homedir 的
离线测试和变异实验验证优先级与失败边界。目录归类分两批实施，避免同时改变入口与路径语义。
历史 CLI 实测结论保持原样。

**实施进度（批次 2d-1）：** 7 个环境探针已移入 `scripts/probes/`，含不在离线
`check` 主链中的 `check-cli-live.mjs`；相对导入、npm 入口和说明引用同步更新，
路径解析与脚本功能保持原样。8 个运维脚本仍在 `scripts/`，`ops/` 留待批次 2d-2。

**实施进度（批次 2d-2）：** 8 个运维脚本已移入 `scripts/ops/`；相对导入、preset 文件引用、
npm 入口、文档及脚本用法与运行时命令同步更新。离线 `check` 主链不变，路径解析与脚本功能
保持原样；批次 2d-1 的 7 个探针仍在 `scripts/probes/`，目录归类完成。

**当前目录复核（批次 3b）：** `scripts/ops/` 8 个、`scripts/probes/` 7 个，与上述完成记录一致。
`scripts/lib/` 当前为 `paths.mjs`（目标路径解析）、`cli-config.mjs`（CLI 配置与调用校验）、
`capture.mjs`（无 shell 的输出采集）、`probe-cli.mjs`（配置驱动探针与提示词文件管理）。
根目录保留 12 个 `check-*.mjs`（`package.json:52` 的主链）、`dsh-probe.mjs`、
`dsh-cat.mjs`、`inline-asar-probe.mjs`、`gen-preset.mjs`、`inspect-sessions.mjs` 及 CLI 探针配置示例。
模块依据：`scripts/lib/paths.mjs:43`、`cli-config.mjs:50`、`capture.mjs:55`、`probe-cli.mjs:37`。

---

## D16 · CLI 收敛为两种预设与每角色包裹路由

> **后续修正：** 每角色包裹路由已由 D22 的插件级统一设置取代；本节保留历史裁决与实现阶段记录。

**决策：** 当前只支持 `codex` / `grok`，移除 `custom` 兜底。可执行文件与参数仍来自用户配置，
沿用已验证的预设模板；Host 必须核对实际 command / prefixArgs / args / delivery，不能只信
`cliDriver` 标签，并独立校验 `readOnly` 与沙箱参数。客户端切换只读时原子同步预设字段。
批次 1a 保留现有输入控件与全部 `cli*` schema 字段，命令细节的隐藏留后续面板批次。

**旧配置迁移：** 旧 `custom` 仅完整匹配模板或解析后预设形态时识别为对应驱动，不按文件名猜。
无法识别时保留原始数据，仅阻塞该角色；自检和主代理指引显示待迁移，其他有效角色继续可用。
重复 id 等全局结构错误继续整体拒绝。

**包裹路由：** 每角色新增可选字符串 `agentProvider` / `agentModel`，留空继承父代理路由与模型；
它们与外部 CLI 的 `model` 分离。本批次只完成 schema 与规范化保存，spawn 包裹与路由应用
在后续批次实施。实时输出采用 DSH Jobs 面板，进程执行器及去超时同样留后续批次。

**依据与代价：** 用户已裁决收敛预设、逐角色迁移阻塞及每角色包裹路由。
完整形态校验避免隐藏命令借预设标签执行；代价是任意 CLI 自定义参数不再可挂载，需要重选预设。
离线纯函数与客户端真实回调断言验证迁移、安全边界及原子更新，变异实验验证关键断言判别力；
本批次不新增真实 CLI 调用或真机验收结论。

**实施进度（批次 1b）：** 面板已移除命令、前缀参数、参数模板、提示词传递、工作目录输入及占位符提示，
仅保留 codex / grok 预设选择与外部模型、强度等角色字段；未识别配置显示「需重选预设」。
内置 spawn / fork 新增可留空的 Provider 文本输入；CLI 模式新增每角色 `agentProvider` / `agentModel` 输入，
并明确区分包裹模型与外部 CLI 模型。所有后端新增必填的多行角色指令输入，不自动生成指令。
全部 `cli*` schema、已有隐藏值与工作目录回落语义保留；包裹字段可保存，路由应用仍留后续批次。
本批次仅离线验证源码结构与桩化回调，控件显示、设置保存往返及旧配置提示仍需重启 DSH 后真机验收。

---

## D17 · CLI 无运行期限与独立取消分类

**决策：** 移除 `cliTimeoutSec` schema、读取及注入，以及执行器的时长计时终止。
单次进程逻辑抽到既有 `src/cli/runner.js`，provider 保留 DSH 适配；预留可选输出 sink，
本批次不接 Jobs，不改变现有角色工具路由。保留 `cliGraceMs` 和 stdout/stderr 收集容量上限。

**理由与依据：** 长任务的完成时间无法预设；已核实上层工具的 timeoutMs 只作声明，
subagent 与 subprocess 不强制默认期限。用户用现有会话停止取消，信号直接到 spawn。
取消独立分类为 `cancelled` 并映射 `aborted`，启动失败与进程失败仍区分；
取消和退出以 done 被观察到为终态固定点，只结算一次。

**兼容与代价：** 空 volatile 容器保留旧字段的非 strict 加载行为，旧期限忽略，
一次弃用日志及自检提示不阻止健康状态。失去自动结束挂起任务的期限，需要用户主动停止；
输出容量上限仍在，丢失或截断明确标记。所有终态统一清理提示词文件、监听器和回流轮询。

**验证边界：** 假 spawn、可控 Node 假 CLI、真实 Config 和隔离 DSH_HOME 验证无期限、
取消、清理、唯一终态与旧值兼容；关键断言通过临时生产代码变异及 SHA-256 恢复校验。
本批次不调用真实 codex/grok，GUI 停止及外部进程树终止仍需真机验收。


---

## D18 · CLI 改为内置 spawn 包裹与角色专属工具（批次 3a）

> **后续修正：** 本节每角色 agentProvider / agentModel 的路由来源已由 D22 取代；spawn 包裹与专属工具架构保留。

> **后续修正：** 本节「allow 仅本角色专属工具」已由 [D21](#d21--入站深度预算与出站委派权限分离) 的出站开关规则扩展；角色指令确定性前置限于 stdin / promptFile 模式，argv 保持任务参数原值。

**决策：** CLI 角色的 delegate 改用内置 spawn；子代理调用 `switchboard_cli_run_<角色后缀>`，
工具等待外部 CLI 结束并返回有界结果，子代理简洁汇报交付物、验证证据、错误与未完成项。
移除旧 `switchboard-cli-*` provider 实现与注册；保留历史文件名 `provider.js` 承载专属工具定义。
本批次不接 `ctx.jobs`，输出 sink 留给 3b。

**理由与依据：** 用户要求主代理上下文隔离 CLI 输出。已核实子代理继承 preset 工具视图，
内置 spawn 支持 persona、agentOptions、toolFilter 与数字 depthLimit。
每角色 `agentProvider` / `agentModel` 按需组合，都留空时不设置 agentOptions，继承父代理路由。
专属工具先注册再挂载 delegate，自检实时核对二者，注册失败或缺失都报告角色不可用。

**执行边界：** 包裹 persona 只允许转交与汇报；allow 仅本角色专属工具，关闭后台运行与模型选择，
失败或取消不得自动重试，CLI 输出不能改变工具或权限约束。工具安全访问 origin 并拒绝非 subagent。
AGENTS.md 规则 4 继续由注册时配置快照与仅 prompt 参数落实：可执行文件、模板、cwd、readOnly、
外部模型、强度和限额只取用户配置，模型不能覆盖；沿用受限占位符与 argv 数组，无 shell、无新 flag。
角色 instructions 由 runner 确定性前置，不依赖包裹模型转述。

**代价：** 增加一次内置 LLM 子会话的费用与延迟，最终汇报的完整性依赖包裹模型。
工具结果容量受配置限制，超限明确标记；仍依靠会话停止取消，没有自动运行期限。
包裹路由继承模式可能受父代理可用路由影响；DSH 工具过滤不代替外部 CLI 自身的沙箱。

**验证边界：** 旧 check-cli-provider 入口迁移到工具与 runner；用假 spawn、Node 假 CLI 真进程、
实际工具 schema 和隔离 DSH_HOME 验证配置绑定、来源拒绝、路由事实、容量、取消和注册故障。
关键断言用生产代码变异验证判别力，并以 SHA-256 校验恢复。真实 DSH spawn / 工具继承、
包裹路由、最终汇报和 GUI 停止仍需真机验收；本批次不调用真实 codex / grok。

---

## D19 · CLI 输出使用内置 Jobs 面板回流（批次 3b）

> **被取代范围：** 本节 settled 等待、结算后 remove 与前台删除验收已被 [D20](#d20--cli-执行完成与-jobs结算客户端读取分离) 取代；其余回流路径、owner 和模型容量边界保留。

**决策：** 使用会话顶部的内置任务面板，不新增客户端 UI。工具执行时通过 `ctx.get('jobs')`
读取可选服务，注册 kind=cli、label=角色标题或 id、owner=调用方子会话 `exec.agent.id`。
runner 增量 sink 向 job.append 推送 stdout / stderr，丢失字节显式标记；只使用推送一种路径。
调用方停止、任务取消与 owner 销毁汇入同一 AbortController。done 在资源清理后 resolve，且不 reject。

**等待与模型边界：** 工具前台等待 runner 自己的终态 Promise，finally 等 Jobs settled 后 remove。
不向模型交出 jobId，不把实时输出作为逐块工具结果或 AI 请求；最终正文/错误仍按配置限额返回。
Jobs 的模型侧读取与终态通知另限 4096 字节，客户端输出环沿用平台容量，不代表无限日志存储。
本地 wait 类型文档强制正数且有限的等待界限，因此不调用 jobs.wait，不引入运行期限。
平台对 unawaited 结算可能发送终态通知，这一路不用于运行中的逐块回流，仍需真机核验。

**降级与代价：** jobs 不进 inject；服务缺失或注册预检拒绝时继续执行 CLI，并报告回流不可用。
输出保留窗口溢出会标记丢失，结算后移除任务卡片；owner=子会话的面板可见性待真机验证。
直接等待生产者不使用 Jobs waiter，其 awaited 语义与平台完成通知行为需要现场观察。

**验证边界：** 假 Jobs 服务、Node 假 CLI 真进程与 apply 集成验证实时回流、取消、释放顺序、
前台删除、降级、有界结果与来源防御；关键断言以生产代码变异及 SHA-256 字节校验验证判别力。
不调用真实 codex / grok，不读写用户 DSH_HOME；真实任务面板和 CLI 进程树仍待验收。


---

## D20 · CLI 执行完成与 Jobs结算、客户端读取分离

**决策：** 工具只等待共享执行完成 Promise；该 Promise 先清理调用方 abort 监听器，再派生不 reject 的
JobHooks.done。移除 effect-scoped settled 订阅及等待，成功/失败/取消均不主动 remove。
执行器完成、Jobs 结算、客户端读完互相独立；记录交由 Jobs 的保留策略处理（未核实），不改 owner、不延时删除。
替代 D19 的结算等待与前台删除，D17 / D18 中「本批次不接 Jobs」仅是历史阶段范围，已由 D19 实施。
D16 的包裹路由待实施也已由 D18 实施。

**清理与失败结算：** 成功路径也尝试 waitForExit；失败路径分别尝试 terminate 与 waitForExit，
前者抛错仍确认退出。确认后排空尾部、尝试删除提示词文件，再统一形成结果。终止请求失败、受管范围未确认、
提示词可能残留进入有界诊断，不输出提示词内容。保留进程分类，清理失败的 JobHooks.done resolve failed，
绝不永久挂起，也不声称已完全释放。意外执行器拒绝同样 resolve failed 并明确报告退出未确认。
官方 dsh-tool-subagent 的 settleStart 捕获异常后结算 failed，是不阻塞 owner 销毁的先例。

**保证边界：** 工具权限限制可调用工具；执行器保证每次调用单次启动、不自行重试、角色指令确定性前置。
persona 的原样转交、只调用一次、不重试及简洁汇报属于模型行为要求；不构成跨调用次数或汇报完整性的机制保证。
不修改 maxDepth / toolFilter，不新增运行期限，不新增客户端代码。

**验证边界：** 假 Jobs 保存输出环、仅以 id / total 通知，工具返回且结算后按偏移读取尾部；
模拟丢弃 settled、作用域释放、取消、退出确认失败、终止抛错及提示词删除失败。
测试 watchdog 仅发现测试挂起，不是产品运行期限；关键断言以生产代码变异与 SHA-256 恢复校验验证。
不调用真实 codex / grok、不触碰用户 DSH_HOME；面板可见性、延后读取、平台保留策略及受管进程树仍需真机核验。

---

## D21 · 入站深度预算与出站委派权限分离

**决策：** `allowNestedDispatch` 只表达该角色创建的 DSH 子代理能否继续调用受控委派工具，
不表达该角色能否被调用，也不保证总能继续派发；仍受剩余深度预算及实际挂载清单约束。
插件级 `maxDepth` 是第一层之外的额外层数，所有目标的入站上限统一为 `1 + maxDepth`，与叶子性无关。

| 插件 maxDepth | 允许的绝对深度 |
| --- | --- |
| 0 | 仅 1 |
| 1 | 1–2 |
| 3 | 1–4 |

**修正的回归：** 改造前 CLI 角色走 `provider-managed`，不受 DSH 数字入站深度限制。
改造中一度按目标自身的 `allowNestedDispatch` 计算绝对深度，叶子目标被固定为 1，
导致深度 ≥1 的父代理无法调用叶子 CLI 角色。现在入站只使用插件预算，叶子性改由出站工具权限表达。

**出站权限：CLI 用 allow、内置用 deny。** CLI 角色为 true 时开放「自身专属 CLI 工具 + 已挂载的受控委派工具」，
为 false 时只有自身专属 CLI 工具；任何情况下都不开放其他角色的底层 CLI 执行工具。
CLI 默认 allow 仍包含自身专属工具，并非空 allow；其工具清单稳定，允许冻结。
内置角色不设置 allow：保留派发采集时可见的普通工具，并让采集后新增的普通工具保持动态可见，避免固定白名单的兼容性回归。
deny 合成四部分：当前可用的非受控派发入口、全部当前可用的 `switchboard_cli_run_*`、
关闭嵌套时已挂载的受控委派工具、只读时当前可用的 `WRITE_TOOLS`；另拒绝可见但未纳入角色清单的 `delegate_to_*` 入口。
工具名使用精确清单，不使用通配符；派发时刷新清单。DSH 拒绝未知过滤名，所以非受控入口、底层 CLI 工具、写工具只列采集时可用名。
**代价：采集之后才注册的这些危险工具不在既有 child 的 deny 中，属于 fail-open，而非 fail-closed**；未纳入角色清单的委派入口同样有此窗口。
跨角色隔离依赖 deny 清单，是按工具名隔离；`src/cli/provider.js` 只判 `origin === 'subagent'`，不校验调用方角色身份，不能宣称按角色身份授权。

**非受控派发边界：** 本轮复核 preset 的五个通用入口 `tool-subagent` / `tool-subagent-fork` /
`tool-subagent-codex` / `tool-subagent-claude-code` / `tool-ralph` 均为 `disabled: true`；
除角色工具外，仍启用 `tool-workflow`。CLI allow 不包含 `workflow` 等入口；内置 deny 从 `UNCONTROLLED_DISPATCH_TOOLS` 取当前可用名排除它们。
主代理自身没有本插件设置的 `toolFilter`，按 preset 声明仍可看到 `workflow`；本插件只约束所派子代理，
不保证主代理完全无法绕过。既有只读取证称 `workflow` 工具直接经 `subagents.start(...)` 派发且不传 `maxDepth`，
控制工具 `send_message` / `interrupt_agent` / `list_agents` 不创建子代理；本轮对应模块不可解析，
安装归档被沙箱拒读，以上源码结论未独立复核，不作为新增实测事实。
已安装的 `dsh-subagent/lib/index.js` 中 `start` 只验证并转交请求的 `maxDepth`，不调用 `resolveMaxDepth` 回落默认预算；
故省略该值的直接调用路径不能依靠服务默认深度约束。保留 workflow 排除，并列入真机复核。

**验证边界与缺口：** argv 样本新增非空角色指令哨兵，验证任务参数原值、哨兵不入 argv、stdin 为 ignore；
保留 stdin / promptFile 的角色规则精确前置断言，避免空指令样本造成覆盖假象。
`check-apply` 的派发使用真实 Config / 工具插件但假 ctx、假 `subagents.start`，属于契约模拟，不是真实 spawn 集成。
深度夹具使用 `options.subagentDepth`，由真实 `delegationDepthOf` 确认父深度为 1（旧 `options.delegationDepth` 实为 0）；
start 桩调用真实 `resolveChildDepth`，覆盖父深度 1 调用叶子 CLI 成功，以及预算 0/1/3 的边界成功与超界拒绝。
另以真实 Cordis + ToolRuntime + `applyChildComposition` 验证普通工具的动态可见性、内置角色隔离全部底层 CLI、
CLI 自身工具与受控委派白名单、只读 deny、`allow: []` 拒绝继承工具及 child 自注册例外，也确认后注册写工具的 fail-open 代价。
本轮可导入 `dsh-subagent`，但真实 `dsh-subagent-spawn-in-process` 与 `dsh-agent-preset-registry` 均
`ERR_MODULE_NOT_FOUND`；只装服务不能创建子代理。在不引入依赖的范围内不搭伪集成。
尚需真机验证真实 spawn 上下文隔离、preset 工具继承、完整派发链中的 child 工具过滤，以及不同父深度下
叶子可被调用、组织角色受剩余预算拒绝、子代理不可调用 workflow 或其他角色底层 CLI 工具。

## D22 · CLI 包裹路由改为插件级统一设置

**决策：** 按用户新裁决，包裹子代理的 provider、model、effort 统一放在插件 Config 的
`volatile.wrapperProvider` / `wrapperModel` / `wrapperEffort`，取代 D16 / D18 的每角色
`agentProvider` / `agentModel`。三项可选字符串，空白继承父代理；强度限定为
`EFFORT_VALUES`，非法值报配置错误并阻止挂载。仅影响外部 CLI 的内置 spawn 转交代理，
不改变外部 CLI 的角色 model / effort，也不改变内置 spawn / fork 的角色 provider / model / effort。

**作用域与写入：** 三字段放在 volatile 子树以满足 SettingsForms 可写路径约束。
面板列表前始终展示统一小节，注明仅 CLI 生效；角色与三字段草稿在一次 mutate 中用同一 revision 保存。
根配置沿现有 roles.json 桥接到 preset，文件中的统一路由（含显式空值）优先；文件尚未保存统一设置时
回落当前实例配置。角色列表仍采用本作用域非空 roles 优先、否则读文件，两个来源不能混为一谈。
根字段移除或留空会清除已保存的统一路由。旧角色字段兼容加载但忽略，逐实例记录诊断，模块只告警一次。
根 apply 与 internal/update 更新瀑布均同步三字段，更新钩子继续 next；volatile 就地更新也可供新 preset 读取，
已挂载的子代理保持挂载时路由。该钩子以本地 Cordis 源码及真实 Cordis 离线更新测试核实，DSH Loader 往返仍待真机验证。

**理由与代价：** 用户裁决统一转交代理，减少重复配置与角色间包裹模型漂移。
代价是不能逐 CLI 角色选择不同包裹模型；根配置到 preset 仍依赖文件同步与激活时序。
不新增配置服务、文件、依赖或执行路径，不变更 D21 权限模型与 CLI 生命周期。

**验证边界：** 离线检查覆盖路由组合、清空、非法值、根/preset 优先级、兼容加载与 UI 原子路径；
关键断言以生产代码变异验证判别力。真实设置往返、重启后 preset 路由、父代理继承仍需真机验收。
