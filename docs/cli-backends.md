# CLI 后端实测参数表

> 本文件只记录**实测过**的事实。未实测的一律标注「未实测」，不凭 `--help` 推断行为。
>
> 配套：[`decisions.md`](./decisions.md) D12（模型与思考强度）、[`plan.md`](./plan.md) Phase 3。
>
> 本轮校准依据当前代码与已有实测记录，不重新调用外部 CLI。下列版本、耗时与 help 参数为历史记录；当前探针已改为用户配置驱动，不能仅凭脚本存在复现原来的参数与结果。原始 help 全文及每个候选参数是否仍适用于当前安装版本**未核实**，保留历史原文；help 记录不等于逐项行为实测（`scripts/probes/probe-cli-help.mjs:1`、`:22`，`scripts/lib/probe-cli.mjs:19`）。

## 为什么需要这个文件

`codex`、`claude`、`grok` 三个 CLI 的参数形态**互不相同**，而且有些关键参数**不在 `--help` 里**。
只用 `--help` 推断会得到错误结论（D12 已记录一例：codex 的思考强度参数在 help 中完全未出现）。

## 1. 入口可执行性（Windows）

这是最容易踩的一步：**「命令存在」不等于「能被 spawn」**。本机 `codex` 有三个入口，只有一个可用。

| 入口 | 路径形态 | 能否被 `spawn(shell:false)` 执行 | 实测错误 |
| --- | --- | --- | --- |
| `codex` | `%APPDATA%\npm\codex.ps1`（PowerShell 脚本） | ❌ | `spawnSync codex ENOENT` |
| `codex.cmd` | `%APPDATA%\npm\codex.cmd`（batch 包装） | ❌ | `spawnSync ... EINVAL` |
| `codex.js` | `%APPDATA%\npm\node_modules\@openai\codex\bin\codex.js` | ✅ | — |

**`.cmd` 失败的原因值得记住**：Node ≥19 出于安全禁止在 `shell: false` 下 spawn `.cmd` / `.bat`
（CVE-2024-27980 的缓解措施）。因此**不能靠批处理包装来绕过脚本入口问题**——
这与我最初的设想相反。

**结论（codex）**：必须以 `node <codex.js>` 形式调用，即 `argv = [node 可执行文件, <codex.js>, 'exec', ...]`。

### 1b. 三个 CLI 的入口都实测过了（`scripts/probes/probe-clis.mjs`）

| CLI | 本机入口 | 能否被 `spawn(shell:false)` 执行 |
| --- | --- | --- |
| `codex` | `%APPDATA%\npm\node_modules\@openai\codex\bin\codex.js` | ✅ **但必须走 `node <codex.js>`**（见上） |
| `claude` | `C:\Users\<你>\.local\bin\claude.exe` | ✅ 真 `.exe`，可直接 spawn |
| `grok` | `C:\Users\<你>\.grok\bin\grok.exe` | ✅ 真 `.exe`，可直接 spawn |

即：**「`.exe` 可直接 spawn」这个预期被证实了**，而 codex 是唯一的例外（它是 npm 脚本包装）。
探测方式：`where.exe` 取全部入口 → 优先 `.exe` → 否则回落 `node <包的 bin/*.js>`。

### 1c. 每个 CLI 有**自己的模型命名空间**（重要，实测踩到）

第一轮真机调用（`scripts/probes/probe-cli-run.mjs`）把插件可用的 LLM 路由名 `gpt-6-luna`
填给三个 CLI，结果：

| CLI | 结果 |
| --- | --- |
| codex | ✅ 退出 0，stderr 自报 `model: gpt-6-luna` |
| claude | ❌ 退出 1：`"gpt-6-luna" isn't described by this version's model catalog` |
| grok | ❌ 退出 1：`unknown model id`（`grok models` 才是它的真实列表） |

**结论：`cliArgs` 里的 `{model}` 由用户按各自 CLI 的命名空间填写，插件不提供默认值。**
因此 `normalizeRole` 对 CLI 角色**要求显式给出 model**（缺失即报错）——这不是「必填形式主义」，
而是防止 CLI 静默使用它自己的配置（见 §2.4 结论 4）。

## 2. codex

### 2.1 调用形态

- **非交互子命令**：`codex exec`（别名 `codex e`）。
- **提示词传递**：优先走 **stdin**。`codex exec -` 表示从 stdin 读；不给提示词参数时也读 stdin。
  官方说明：若 stdin 被管道输入且同时给了提示词参数，stdin 会被附加为一个 `<stdin>` 块。
- **工作目录**：`-C, --cd <DIR>`。
- **输出**：`-o, --output-last-message <FILE>` 把最后一条消息写入文件；`--json` 输出 JSONL 事件流。
- **沙箱**：`-s, --sandbox <read-only|workspace-write|danger-full-access>`。

### 2.2 路由信息是**可当场读取的**

codex 会把本次运行的路由事实**明文打印到 stderr**，形如：

```
OpenAI Codex v0.159.2
--------
workdir: <cwd>
model: <model>
provider: openai
approval: never
sandbox: read-only
reasoning effort: ...
```

这使得「参数是否真的生效」成为**可观测事实**，而不是推测。Phase 3 的模型/强度验收因此可以
直接读 stderr 判定，无需旁证。

### 2.3 模型与思考强度

| 项 | 参数 | 说明 |
| --- | --- | --- |
| 模型 | `-m, --model <MODEL>` | 或 `-c model="..."` |
| 思考强度 | `-c model_reasoning_effort=<值>` | **无专用 flag**，且 `--help` 完全未提及 |

强度可用档位**随模型变化**（见 D12：`~/.codex/config.toml` 的
`[desktop] enabled-reasoning-efforts` 是按模型的桌面端设置）。

### 2.4 实测结果

探针：`scripts/probes/probe-codex.mjs`（全部调用使用 `-s read-only`，提示词只要求回一个标记串）。
判据是 codex **自己打印到 stderr 的路由事实行**，因此「参数是否生效」是可观测事实而非推断。

| # | 用例 | 退出码 | 耗时 | codex 自报 `model` | 自报 `reasoning effort` |
| --- | --- | --- | --- | --- | --- |
| 1 | 基线（不传 `-m`） | 0 | 18.2s | `gpt-6-luna` | `max` |
| 2 | `-m gpt-6-luna` | 0 | 20.2s | `gpt-6-luna` | `max` |
| 3 | `-m gpt-6-astra` | 0 | 15.7s | **`gpt-6-astra`** | `max` |
| 4 | `-c model_reasoning_effort=high` | 0 | 14.8s | `gpt-6-luna` | **`high`** |
| 5 | `-c model_reasoning_effort=low` | 0 | 18.1s | `gpt-6-luna` | **`low`** |
| 6 | 反证：`-m no-such-model-xyz-9999` | **1** | 7.2s | `no-such-model-xyz-9999` | `max` |
| 7 | 反证：`-c model_reasoning_effort=not-a-real-level` | **1** | 7.5s | `gpt-6-luna` | `not-a-real-level` |
| 8 | `--json` | 0 | 17.5s | —（stderr 为空） | — |

**结论（全部有对照组支撑，非单例观察）：**

1. **`-m` 确实生效**：用例 3 把模型从 `gpt-6-luna` 换成 `gpt-6-astra`，stderr 的 `model` 行**跟着变**。
2. **`-c model_reasoning_effort=` 确实生效**：`high` / `low` 都被如实反映（用例 4、5）。
   **这是 D12 的关键验证** —— 该参数在 `--help` 里完全未文档化，只能靠真实调用确认。
3. **非法模型与非法强度都以致码 1 失败**，且**不产生 `-o` 输出文件**。
   因此「参数被静默忽略」的风险被排除：写错就会失败，不会静默降级。
   注意用例 6/7 的失败耗时（7.2s / 7.5s）明显短于成功用例（15–20s），说明失败发生在模型调用之前。
4. **不传 `-m` 时取 codex 自身配置**（本机 `~/.codex/config.toml` 为 `gpt-6-luna` + `max`）。
   这意味着**后端必须总是显式传模型**，否则角色模型会被 codex 自己的配置悄悄覆盖。
5. **`--json` 会把事件流改到 stdout，并让 stderr 变空**——因此路由事实不可读。
   本插件的验收依赖可读路由事实，故**实现时不采用 `--json`**，改用 `-o` 取最终消息。

**输出取用方式（实测）**：`-o <file>` 稳定拿到最终消息（20 字节标记串）。stdout 在非 `--json` 模式下
只有 21 字节（标记 + 换行）。两者都可用于回传；`-o` 的好处是把「最终消息」与「过程噪音」分离，
缺点是引入一个临时文件。

### 2.5 端到端实测：角色经 CLI 后端派发（真机通过）

**结论：codex 后端已端到端跑通。** 一次真实取证任务（在选中 `Switchboard` preset 的会话里
调用 `delegate_to_codex_scout`）产生如下日志，其中 `argv` 是**实际传给进程的参数**，
`cli-route` 是 **codex 自报的生效路由**：

```text
[switchboard] role=codex-scout backend=cli command=C:\Program Files\nodejs\node.EXE
[switchboard] argv=["C:\\Program Files\\nodejs\\node.EXE",
                    "...\\@openai\\codex\\bin\\codex.js",
                    "exec","-s","read-only","--skip-git-repo-check",
                    "-m","gpt-6-astra","-c","model_reasoning_effort=medium","-"]
[switchboard] exit=0 duration=67.5s
[switchboard] cli-route {"model":"gpt-6-astra","provider":"openai","approval":"never",
                         "sandbox":"read-only","reasoning effort":"medium"}
```

**这组对照是验收的核心**：`argv` 里的 `-m gpt-6-astra` / `model_reasoning_effort=medium`
与 codex 自报的 `model: gpt-6-astra` / `reasoning effort: medium` **一致**。
只看退出码为 0 是不够的 —— 见 §2.4 结论 4，不传 `-m` 时 codex 会静默使用它自己的配置，
外观上毫无区别。`sandbox: read-only` 同时证明 `-s read-only` 生效。

### 2.6 如何把某个角色切到 CLI 后端

**机制是每个角色自己的属性**（`decisions.md` D13），不是「另建一个 CLI 角色」。
把 `scout` 从内置改为走 codex，只需改这一个角色的字段（`id` 与工具名 `delegate_to_scout` 都不变）：

```yaml
- id: scout
  description: ...
  instructions: ...
  readOnly: true
  backend: cli                                  # ← 从默认的 spawn 改为 cli
  model: gpt-6-astra
  effort: medium
  cliDriver: codex
  cliCommand: "{node}"
  cliPrefixArgs: ["{npmRoot}\\@openai\\codex\\bin\\codex.js"]
  cliArgs: ["exec", "-s", "read-only", "--skip-git-repo-check",
            "-m", "{model}", "-c", "model_reasoning_effort={effort}", "-"]
  cliPromptDelivery: stdin
  cliCwd: "C:\\path\\to\\workspace"
```

**只需要一步**：把角色的 `backend` 改为 `cli` 并填上面那些 `cli*` 字段。
（在设置面板里更简单：`派发机制` 选「外部 CLI」，再从 CLI 下拉框选 `Codex CLI` / `Grok CLI`，
参数模板会自动填好。）

**当前仅支持 codex / grok 预设。** Host 在挂载前核对 command / prefixArgs / args / delivery
完整形态，并独立核对 `readOnly` 与沙箱参数。切换只读会原子更新预设参数。
旧 `custom` 是历史配置：仅完整匹配模板或本机解析后形态时无损识别；否则保留原数据，
在自检「未挂载的角色」及主代理指引中显示待迁移、禁止派发，其他有效角色仍可挂载。
`agentProvider` / `agentModel` 为每角色可选包裹路由，留空继承父代理；本批次只保存这些字段，
实际 spawn 包裹执行留后续批次。命令输入控件也留待后续面板改造。

> ⚠️ **曾经**还需要第二步「打开总开关 `volatile.allowCrossCli: true`」，**该开关已移除**。
> 原因：它后来在面板上被移除、却仍在执行期拦截，于是 CLI 角色永远挂不上、界面只显示
> 「工具不存在」，且自检里那句「因开关未挂载」是唯一的线索 —— 典型的「静默不存在」。
> 实测踩到：`scout=失败(allowCrossCli 未开启，故未挂载（provider 也未注册）)`。
>
> 现在的可控性来自两点：角色的 `backend` 必须被**显式**设为 `cli`，
> 且角色只在声明了 `mount: true` 的 Switchboard preset 会话里挂载。
> 这比一个看不见的全局开关更容易理解和审计。

### 2.6b 换 CLI 或换模型时的两个必查项（都踩过）

1. **模型必须符合该 CLI 自己的命名空间。** 驱动选择器**不会**自动改模型
   （每个 CLI 有各自的模型列表，插件给不出通用默认值）。实测：
   grok + `gpt-6-luna` → 退出 1 `unknown model id`；grok + `grok-4.7` → 退出 0。
   查法：`grok models`；codex 直接试用真实模型并看它 stderr 自报的 `model:` 行。
2. **必须有工作目录。** `normalizeRole` 在 `cliCwd` 与插件级 `cwd` 都为空时报
   「cliCwd 未设置，且全局 cwd 也未设置」并**不挂载该角色**。
   因此插件级 `cwd` 应当设置好，否则从面板新建的 CLI 角色会带着空 `cliCwd` 失败。

### 2.7 已知的实现约束（实测踩到，改代码前先读）

- **CLI 角色的工具配置必须显式写 `maxDepth: 'provider-managed'`**，省略反而会抛错：
  `dsh-tool-subagent` 的 `resolveMaxDepth(undefined)` 会回落到它自己的数字默认值，
  于是 depthLimit 断言触发，工具**不会注册**（而 provider 注册成功）。
  详见 `architecture.md` 3.1d 第 20b 条。
- **`ctx.plugin()` 的抛错抓不到**（它只是启动 fiber），因此挂载成功必须**核实**工具是否真的出现，
  不能假设。详见 `architecture.md` 3.1d 第 20c 条。
- **CLI 无运行期限**：已移除单次派发时长上限与 `cliTimeoutSec`。旧值仍可加载，忽略并给出弃用诊断。
  用户可通过现有会话停止入口取消；信号原样传到子进程，结果分类为 `cancelled`、停止原因为 `aborted`。
  `cliGraceMs` 仍是取消后的终止宽限；`cliMaxOutputBytes` / `cliMaxErrorBytes` 仍限制收集容量，
  截断在回传正文及结构化结果中明确标记。

## 3. claude

### 3. claude

> **状态：本插件的驱动预设已移除**（用户长期不用，明确要求排除）。
> 「角色 → CLI」下拉框里**不会出现** Claude Code。
> 历史上可选「自定义命令」接入；当前该入口已移除，恢复支持需要另行决策。
>
> **本节刻意保留**：这些是真实取证，证明「已排查过、卡在哪一层」。删掉等于丢失证据，
> 日后有人想恢复时会重复踩一遍同样的坑。

#### 3.0 实测结论（`scripts/probes/probe-cli-run.mjs` / `scripts/probes/probe-cli-run2.mjs` / `scripts/probes/probe-claude-isolate.mjs`）

| 项 | 实测结果 |
| --- | --- |
| 入口 | `C:\Users\<你>\.local\bin\claude.exe`，可直接 spawn，`--version` → `2.1.285 (Claude Code)` |
| 非交互 | `-p` / `--print` ✅ 被接受 |
| 模型 | `--model <model>` ✅ **确实生效**（报错里回显的正是传入值） |
| 强度 | `--effort <low\|medium\|high\|xhigh\|max>` ✅ 被接受 |
| 只读 | `--permission-mode <acceptEdits\|auto\|bypassPermissions\|manual\|dontAsk\|plan>` |
| **端到端** | ❌ **本机跑不通**，原因在客户端配置，与插件无关 |

**失败根因（已定位到具体层，不是猜的）**：claude 会用它**内置的模型目录**校验 `--model`，
凡是目录里没有的名字一律拒绝：

```
[claude-code:unrecognized_model] {"model":"gpt-6-luna","query_source":"sdk"}
```

已排除的可能：
- **不是** `--model` 没生效 —— 换任意名字，报错就回显那个名字；
- **不是**网关不认 —— 同一台机器的 codex 用 `gpt-6-luna` 通过，且
  `GET <网关>/v1/models` 返回 200 且确实含 `gpt-6-luna`；
- **不是**环境变量覆盖 —— 清掉 `ANTHROPIC_MODEL` 等变量后仍然失败；
- **不是**「名字太新」—— 连 `claude-sonnet-4-5-20250929`、`claude-sonnet-5` 也被拒。

claude 自己给出的官方出路是**把未知模型映射到它认识的模型**：
`behavesAs`（modelPicker 行）或 `modelOverrides`。这属于**该 CLI 的配置工作**，
不由本插件代劳。

> **历史状态：** 驱动表曾保留 `claude` 预设，调用形态按上述实测编写，当时本机端到端不可用。
> **当前状态：** Claude 内置预设已移除，驱动表只含 `codex` / `grok`。
> 旧 custom Claude 配置会阻塞为待迁移；模型映射如何配置及配置后是否跑通仍未实测。

#### 3.1 调用形态（`--help` + 上表实测）


- **非交互**：`-p, --print`。help 明确说「useful for pipes」，且在 `-p` 或 stdout 非 TTY 时跳过 workspace trust 对话框。
- **输出格式**：`--output-format <text|json|stream-json>`（仅配合 `--print`）。
- **输入格式**：`--input-format <text|stream-json>`（仅配合 `--print`）。
- **权限**：`--permission-mode <acceptEdits|auto|bypassPermissions|manual|...>`；`--allowedTools` / `--disallowedTools`。
- **工作目录**：`--add-dir <directories...>`。
- 另有 `--session-id <uuid>`、`--resume`、`--system-prompt`、`--restricted`。

### 3.2 仍未实测的项：模型别名、强度生效与回退（历史 `--help` 候选）

| 仍未实测的项 | 历史 help 参数与边界 |
| --- | --- |
| 模型别名及成功路由 | `--model <model>`（help 列别名如 `opus`/`sonnet`）；§3.0 已确认传入模型被目录校验读取，未确认这些别名能成功调用 |
| 思考强度实际生效及逐档覆盖 | `--effort <level>`，help 明示取值 `low, medium, high, xhigh, max`；§3.0 只证明参数被接受，本机端到端失败，不能证明强度生效 |
| 回退模型行为 | `--fallback-model`；仍未实测 |

**注意**：`--effort` 的取值集合是**在 help 里文档化的**，这与 codex 形成对比。

## 4. grok

### 4.0 实测结论（`scripts/probes/probe-cli-run.mjs` / `scripts/probes/probe-cli-run2.mjs`）

| 项 | 实测结果 |
| --- | --- |
| 入口 | `C:\Users\<你>\.grok\bin\grok.exe`，可直接 spawn，`--version` → `grok 1.0.44` |
| 非交互 | `-p` / `--single <PROMPT>` —— 提示词是**参数**，不是 stdin。**无需 TTY** |
| 模型 | `-m <MODEL>`；`grok models` 实测本机可用：`grok-4.7`（默认）/ `grok-4.7-build-fast` / `grok-4.6` / `grok-4.5` |
| 强度 | `--reasoning-effort <EFFORT>`（别名 `--effort`） |
| 只读 | `--permission-mode <default\|acceptEdits\|auto\|dontAsk\|bypassPermissions\|plan>` |
| **端到端** | ✅ **通过**：`-p <prompt> -m grok-4.7 --reasoning-effort low` → 退出 0，stdout 收到标记串 |

**历史调用与当前预设需区分：** 上表实测使用 `-p <prompt>` 的 `argv` 形态。
当前 grok 预设使用 `promptDelivery: 'promptFile'` 与 `--prompt-file {prompt}`
（`src/cli/drivers.js:165`），`{prompt}` 承载临时文件路径；provider 写入包含角色指令的提示词并清理临时文件（`src/cli/provider.js:165`）。
原因是 argv 值拒绝换行 / NUL，多行角色提示词不能直接放入参数。权威枚举在
`src/cli/argv.js:21`、`:80`；`argv` / `promptFile` 模板都必须含 `{prompt}`，
`stdin` 必须不含（`:107`），驱动检查也覆盖该约束（`scripts/check-drivers.mjs:75`）。
本轮未新增 `promptFile` 真机实测；代码中的既有实测说明保留，不扩展成逐模型/强度验证。

### 4.1 调用形态（`--help` + 上表实测）

- 无独立非交互子命令；`grok [OPTIONS] [PROMPT]` 默认是 TUI。**非交互路径已实测**：
  `-p/--single` 可用，不需要 TTY。
- `--json-schema <SCHEMA>`：约束结构化输出，隐含 `--output-format json`。
- `--output-format streaming-messages-json`、`--include-partial-messages`。
- `--cwd <CWD>`、`--allow` / `--deny`、`--always-approve`。
- `grok models` 子命令可列出可用模型。

### 4.2 仍未实测的项：模型/强度逐项覆盖与生效对照

| 仍未实测的项 | 已有证据与边界 |
| --- | --- |
| 其它模型成功调用及路由对照 | `-m, --model <MODEL>`；§4.0 已有 `grok-4.7` 成功及非法模型失败记录，`grok models` 列出名称不证明每个模型均跑过 |
| 其它强度、别名与实际生效对照 | `--reasoning-effort <EFFORT>`（历史 help 列别名 `--effort`）；已有 `low` 调用成功记录，无逐档调用或 CLI 自报强度对照。驱动声明的 `low / medium / high / xhigh / max`（`src/cli/drivers.js:175`）不等于五档已实测 |

## 5. 对实现的硬性要求

1. **绝不使用 shell**：`argv` 数组直传，本地 Node 探针固定 `shell: false`（`scripts/lib/capture.mjs:55`）。提示词优先走 stdin；当前 grok 走临时文件，argv 只传路径；单行短提示才适合 `argv`（`src/cli/argv.js:63`、`src/cli/provider.js:165`）。
2. **可执行文件与参数全部来自用户配置**，模型只能填充受限占位符（`{prompt}` / `{cwd}` / `{model}` / `{effort}`）。
3. **入口解析必须实测**：不能假定「命令名可 spawn」。codex 的例子证明脚本入口会让整条路径失效。
4. **必须能读到 CLI 自报的路由事实**（如 codex 的 stderr），用于验收「模型/强度确实生效」。
5. **失败语义**：命令不存在、非零退出、用户取消，必须产生可读结果，绝不当作成功。

## 6. 仍未实测的项

- [ ] codex：**手动中断的真实行为**（`terminate` 后是否残留孤儿进程）。
      插件的**代码路径**已有假 CLI 验证（无自行终止、调用方取消终止进程、清理及唯一终态），
      但**未做真机验证** —— 离线断言用的是假 spawn，证明不了真实进程树被清理。
- [ ] codex：`--json` 事件流的确切结构（仅在需要结构化 usage/耗时统计时才值得再查）
- [ ] codex：非零退出码的具体语义细分（额度耗尽 vs 参数错误 vs 模型不存在）——目前只知「都会以致码 1 失败」
- [ ] grok：其它模型/强度组合、强度别名及 CLI 路由生效对照（见 §4.2）。
- [ ] claude：模型别名成功路由、强度逐档生效及回退模型行为（见 §3.2；当前无内置预设）。
- [ ] claude：**如何让它的模型目录接受网关模型**（`behavesAs` / `modelOverrides` 的具体写法）。
      这是该 CLI 的配置工作，不由本插件代劳；本插件当前不支持 custom 接入，能否跑通仍未实测。

## 7. 已关闭的历史实测清单（从原「尚未实测的项」移入，保留记录）

- [x] ~~codex：`-m` 与 `-c model_reasoning_effort=` 是否真的生效~~ → 已实测，见 §2.4
- [x] ~~codex：`--json` 是否比 `-o` 更适合稳定解析~~ → 已实测：`--json` 会牺牲可读路由事实，不采用
- [x] ~~codex：端到端经角色派发是否真的跑通~~ → 已实测，见 §2.5（`exit=0`，`argv` 与自报路由一致）
- [x] ~~codex：`ctx.subprocess.resolveExecutable` 能否解析到可用入口~~ → 已实测：最终采用
      `node` + `codex.js` 绝对路径（`codex.ps1` 与 `codex.cmd` 都不行，见 §1）
- [x] ~~claude：能否直接 spawn；stdin 提示词形态；`--effort` 是否真的生效~~ → 已实测：
      入口可直接 spawn、`-p` + stdin 可用、`--model` 与 `--effort` 都被接受。
      **但本机端到端仍不可用**，原因是 claude 自己的模型目录校验（不是插件问题），见 §3.0。
- [x] ~~grok：非交互调用形态（是否必须 TTY）~~ → 已实测：`-p/--single` 可用，无需 TTY，见 §4.0
- [x] ~~三者：是否需要 TTY~~ → 已实测：codex 与 grok 都不需要；claude 的非交互路径也被接受。

> 上述 Claude 关闭项保留原问题「`--effort` 是否真的生效」的历史措辞；当时实际结论只是参数被接受，强度生效仍列在 §3.2 / §6，不能当作已验证。
