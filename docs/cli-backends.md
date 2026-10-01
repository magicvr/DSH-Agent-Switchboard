# CLI 后端实测参数表

> 本文件只记录**实测过**的事实。未实测的一律标注「未实测」，不凭 `--help` 推断行为。
>
> 配套：[`decisions.md`](./decisions.md) D12（模型与思考强度）、[`plan.md`](./plan.md) Phase 3。

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

### 1b. 三个 CLI 的入口都实测过了（`scripts/probe-clis.mjs`）

| CLI | 本机入口 | 能否被 `spawn(shell:false)` 执行 |
| --- | --- | --- |
| `codex` | `%APPDATA%\npm\node_modules\@openai\codex\bin\codex.js` | ✅ **但必须走 `node <codex.js>`**（见上） |
| `claude` | `C:\Users\<你>\.local\bin\claude.exe` | ✅ 真 `.exe`，可直接 spawn |
| `grok` | `C:\Users\<你>\.grok\bin\grok.exe` | ✅ 真 `.exe`，可直接 spawn |

即：**「`.exe` 可直接 spawn」这个预期被证实了**，而 codex 是唯一的例外（它是 npm 脚本包装）。
探测方式：`where.exe` 取全部入口 → 优先 `.exe` → 否则回落 `node <包的 bin/*.js>`。

### 1c. 每个 CLI 有**自己的模型命名空间**（重要，实测踩到）

第一轮真机调用（`scripts/probe-cli-run.mjs`）把插件可用的 LLM 路由名 `gpt-6-luna`
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

探针：`scripts/probe-codex.mjs`（全部调用使用 `-s read-only`，提示词只要求回一个标记串）。
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
  cliCommand: node
  cliPrefixArgs: ["C:\\Users\\<你>\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js"]
  cliArgs: ["exec", "-s", "read-only", "--skip-git-repo-check",
            "-m", "{model}", "-c", "model_reasoning_effort={effort}", "-"]
  cliPromptDelivery: stdin
  cliCwd: "C:\\path\\to\\workspace"
```

**两步都要做，缺一不可**：

1. 把角色的 `backend` 改为 `cli` 并填上面那些 `cli*` 字段；
2. **打开总开关** `volatile.allowCrossCli: true`（仓库自带的 `scripts/toggle-cross-cli.mjs --on` 可改，
   面板里也能改）。**默认关闭**——CLI 后端会在本机真的执行外部命令，必须显式开启。

> ⚠️ 只做第 1 步不做第 2 步时，该角色**既不注册 provider 也不挂载工具**（主代理看不到它），
> 这是刻意的：宁可看不见，也不要出现「看得见、一调用就报错」的形态。
> 自检工具（`switchboard_selftest`）的「因开关未挂载」一行会列出被挡下的角色。

> `allowCrossCli` 是**全局**开关，而 `backend` 是**按角色**的。两者是叠加关系：
> 总开关关着时，任何角色都无法走 CLI。这是「会执行本地命令」这类能力的恰当粒度。

### 2.7 已知的实现约束（实测踩到，改代码前先读）

- **CLI 角色的工具配置必须显式写 `maxDepth: 'provider-managed'`**，省略反而会抛错：
  `dsh-tool-subagent` 的 `resolveMaxDepth(undefined)` 会回落到它自己的数字默认值，
  于是 depthLimit 断言触发，工具**不会注册**（而 provider 注册成功）。
  详见 `architecture.md` 3.1d 第 20b 条。
- **`ctx.plugin()` 的抛错抓不到**（它只是启动 fiber），因此挂载成功必须**核实**工具是否真的出现，
  不能假设。详见 `architecture.md` 3.1d 第 20c 条。
- **`timedOut` 无法区分「超时」与「调用方取消」**：两者在信令层都是 abort。当前如实标注为
  `timedOut=true`，不编造区分逻辑。

## 3. claude

### 3. claude

#### 3.0 实测结论（`scripts/probe-cli-run.mjs` / `probe-cli-run2.mjs` / `probe-claude-isolate.mjs`）

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

> 因此驱动表里保留了 `claude` 预设（调用形态是按实测写的），但**本机尚不可用**。
> 一旦它的模型映射配好，该预设即可直接使用 —— 不需要改插件代码。

#### 3.1 调用形态（`--help` + 上表实测）


- **非交互**：`-p, --print`。help 明确说「useful for pipes」，且在 `-p` 或 stdout 非 TTY 时跳过 workspace trust 对话框。
- **输出格式**：`--output-format <text|json|stream-json>`（仅配合 `--print`）。
- **输入格式**：`--input-format <text|stream-json>`（仅配合 `--print`）。
- **权限**：`--permission-mode <acceptEdits|auto|bypassPermissions|manual|...>`；`--allowedTools` / `--disallowedTools`。
- **工作目录**：`--add-dir <directories...>`。
- 另有 `--session-id <uuid>`、`--resume`、`--system-prompt`、`--restricted`。

### 3.2 模型与思考强度（仅来自 `--help`，**未实测**）

| 项 | 参数 |
| --- | --- |
| 模型 | `--model <model>`（接受别名如 `opus`/`sonnet`） |
| 思考强度 | `--effort <level>`，help 明示取值 `low, medium, high, xhigh, max` |
| 回退模型 | `--fallback-model` |

**注意**：`--effort` 的取值集合是**在 help 里文档化的**，这与 codex 形成对比。

## 4. grok

### 4.0 实测结论（`scripts/probe-cli-run.mjs` / `probe-cli-run2.mjs`）

| 项 | 实测结果 |
| --- | --- |
| 入口 | `C:\Users\<你>\.grok\bin\grok.exe`，可直接 spawn，`--version` → `grok 1.0.44` |
| 非交互 | `-p` / `--single <PROMPT>` —— 提示词是**参数**，不是 stdin。**无需 TTY** |
| 模型 | `-m <MODEL>`；`grok models` 实测本机可用：`grok-4.7`（默认）/ `grok-4.7-build-fast` / `grok-4.6` / `grok-4.5` |
| 强度 | `--reasoning-effort <EFFORT>`（别名 `--effort`） |
| 只读 | `--permission-mode <default\|acceptEdits\|auto\|dontAsk\|bypassPermissions\|plan>` |
| **端到端** | ✅ **通过**：`-p <prompt> -m grok-4.7 --reasoning-effort low` → 退出 0，stdout 收到标记串 |

⚠️ 因为提示词是参数，驱动模板里**必须**含 `{prompt}`（`promptDelivery: 'argv'`）。
`scripts/check-drivers.mjs` 有一条断言锁死这个自洽性：`argv` 传递必须含 `{prompt}`，
`stdin` 传递必须不含（否则提示词会被传两次）。

### 4.1 调用形态（`--help` + 上表实测）

- 无独立非交互子命令；`grok [OPTIONS] [PROMPT]` 默认是 TUI。**非交互路径已实测**：
  `-p/--single` 可用，不需要 TTY。
- `--json-schema <SCHEMA>`：约束结构化输出，隐含 `--output-format json`。
- `--output-format streaming-messages-json`、`--include-partial-messages`。
- `--cwd <CWD>`、`--allow` / `--deny`、`--always-approve`。
- `grok models` 子命令可列出可用模型。

### 4.2 模型与思考强度（仅来自 `--help`，**未实测**）

| 项 | 参数 |
| --- | --- |
| 模型 | `-m, --model <MODEL>` |
| 思考强度 | `--reasoning-effort <EFFORT>`（别名 `--effort`） |

## 5. 对实现的硬性要求

1. **绝不使用 shell**：`argv` 数组直传，`shell: false`。提示词走 stdin，不拼进命令行（避免引号与长度问题）。
2. **可执行文件与参数全部来自用户配置**，模型只能填充受限占位符（`{prompt}` / `{cwd}` / `{model}` / `{effort}`）。
3. **入口解析必须实测**：不能假定「命令名可 spawn」。codex 的例子证明脚本入口会让整条路径失效。
4. **必须能读到 CLI 自报的路由事实**（如 codex 的 stderr），用于验收「模型/强度确实生效」。
5. **失败语义**：命令不存在、非零退出、超时，必须产生可读错误，绝不当作成功。

## 6. 尚未实测的项

- [x] ~~codex：`-m` 与 `-c model_reasoning_effort=` 是否真的生效~~ → 已实测，见 §2.4
- [x] ~~codex：`--json` 是否比 `-o` 更适合稳定解析~~ → 已实测：`--json` 会牺牲可读路由事实，不采用
- [x] ~~codex：端到端经角色派发是否真的跑通~~ → 已实测，见 §2.5（`exit=0`，`argv` 与自报路由一致）
- [x] ~~codex：`ctx.subprocess.resolveExecutable` 能否解析到可用入口~~ → 已实测：最终采用
      `node` + `codex.js` 绝对路径（`codex.ps1` 与 `codex.cmd` 都不行，见 §1）
- [ ] codex：**超时与中断的真实行为**（`terminate` 后是否残留孤儿进程）。
      插件的**代码路径**已有离线断言（超时真的中止、调用方 abort 传到子进程），
      但**未做真机验证** —— 离线断言用的是假 spawn，证明不了真实进程树被清理。
- [ ] codex：`--json` 事件流的确切结构（仅在需要结构化 usage/耗时统计时才值得再查）
- [ ] codex：非零退出码的具体语义细分（额度耗尽 vs 参数错误 vs 模型不存在）——目前只知「都会以致码 1 失败」
- [x] ~~claude：能否直接 spawn；stdin 提示词形态；`--effort` 是否真的生效~~ → 已实测：
      入口可直接 spawn、`-p` + stdin 可用、`--model` 与 `--effort` 都被接受。
      **但本机端到端仍不可用**，原因是 claude 自己的模型目录校验（不是插件问题），见 §3.0。
- [x] ~~grok：非交互调用形态（是否必须 TTY）~~ → 已实测：`-p/--single` 可用，无需 TTY，见 §4.0
- [x] ~~三者：是否需要 TTY~~ → 已实测：codex 与 grok 都不需要；claude 的非交互路径也被接受。
- [ ] claude：**如何让它的模型目录接受网关模型**（`behavesAs` / `modelOverrides` 的具体写法）。
      这是该 CLI 的配置工作，不由本插件代劳；配好后驱动预设即可直接使用。
