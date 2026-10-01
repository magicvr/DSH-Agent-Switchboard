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

## D11 · 嵌套派发默认关闭，逐角色放开

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

**为什么要有这一条：** D13 把「自建 Client 设置页 + `configForms` 写回」定为方案，但落地时连续踩到三类失败，最终**推翻了 D13 中关于存储位置与通道的具体判断**。D13 的**目标**不变（机制是角色的属性、要有 UI 配置入口），改的是**做法**。以下是已核实的事实，替代 D13 中相应的推断。

### 1. 角色存在**根条目的 Cordis 配置**里，文件是派生产物

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

### 6. 两个 profile 层的承载点，缺一即「静默不存在」

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
