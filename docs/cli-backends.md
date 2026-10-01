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

> ⚠️ 这条结论**只对 codex 实测过**。`claude`（`.exe`）与 `grok`（`.exe`）是真正的可执行文件，
> 预期可直接 spawn，但**尚未实测**。Phase 3 实现时必须逐个确认，不能假定与 codex 相同。

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

## 3. claude

### 3.1 调用形态（仅来自 `--help`，**未实测**）

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

### 4.1 调用形态（仅来自 `--help`，**未实测**）

- 无独立非交互子命令；`grok [OPTIONS] [PROMPT]` 默认是 TUI。非交互路径**未实测**。
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

## 6. 尚未实测、Phase 3 必须补的项

- [x] ~~codex：`-m` 与 `-c model_reasoning_effort=` 是否真的生效~~ → 已实测，见 §2.4
- [x] ~~codex：`--json` 是否比 `-o` 更适合稳定解析~~ → 已实测：`--json` 会牺牲可读路由事实，不采用
- [ ] codex：`--json` 事件流的确切结构（仅在需要结构化 usage/耗时统计时才值得再查）
- [ ] codex：超时与中断行为（`terminate` 后是否残留子进程）
- [ ] codex：非零退出码的具体语义细分（额度耗尽 vs 参数错误 vs 模型不存在）——目前只知「都会以致码 1 失败」
- [ ] codex：`ctx.subprocess.resolveExecutable` 能否接受 `codex.js` 路径；若只能给出 `codex`/`codex.cmd`，
      则需要在插件内自行解析到 node + js 入口
- [ ] claude：能否直接 spawn；stdin 提示词形态；`--effort` 是否真的生效（**不能只信 help**，
      codex 的教训表明未文档化/已文档化都不等于真的生效）
- [ ] grok：非交互调用形态（是否必须 TTY）
- [ ] 三者：是否需要 TTY（若需要，改用 `ctx.subprocess.spawnTerminal`）
