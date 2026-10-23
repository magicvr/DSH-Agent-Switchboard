# DSH Agent Switchboard

> 把 DSH 主代理变成「信息流统合器」，把具体工作派给带角色的子代理——这些子代理可以跑在 DSH 内置的 spawn 后端，也可以跑在本机的 Codex / Grok CLI 上。

[![status](https://img.shields.io/badge/status-implemented-green)](#状态与验证边界)
[![DSH](https://img.shields.io/badge/DSH-0.2.1--rc.2-blue)](./package.json)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

## 它解决什么

单个代理同时承担规划、实现与验证时，上下文被文件内容和工具输出挤满，角色边界模糊，过程也难以审计。本插件把分工固定下来：

| 角色 | 职责 |
| --- | --- |
| **主代理** | 理解意图、拆分任务、选择角色、派发、汇总与验收。 |
| **角色子代理** | 按固定的 persona、权限边界与产物格式执行单个任务，只回传结论与证据。 |

在「分工调度台」里主代理不亲自实现；「自办调度台」让主代理自己承担实现，事实、设计与独立审查仍交给子代理。子代理的执行线路按角色单独配置：DSH 内置 spawn 子代理，或本机 codex / grok CLI。

## 快速开始

前置：DSH `0.2.1-rc.2`（peer 精确 pin）。仓库脚本需要 Node 与 `npm install`（只声明一个 devDependency `yaml`）；插件本身零构建、无运行时依赖，包管理由 DSH 负责。

1. 在 DSH 的 Plugins 页安装 `link:<仓库绝对路径>` 并启用 `@magicvr/dsh-agent-switchboard`（GUI 按钮文案未核实）。
2. `npm run plugin:status`：确认依赖、`dsh.profile.bundles` 登记与磁盘包体三项齐备。
3. `npm run plugin:install` 预演，审阅后 `npm run plugin:install -- --apply` 同步派生制品。若设置层已是 split 模式而 `roles.json` 没有角色定义，命令会拒绝空播种并退出 `3`：此时须把定义写入 `roles.json`（split 模式下设置页只调旋钮）。
4. **完全退出并重启 DSH**（reload 不会重新加载 Host 模块）。
5. 新会话选择「分工调度台」或「自办调度台」，调用 `switchboard_selftest` 核对健康、preset roster 与各角色工具。
6. 打开 **设置 → 角色与派发** 调整旋钮；角色定义见下方「配置」。首次使用还没有角色时，先在卡片里新增（legacy 模式），或把定义写入 `roles.json`。

## 核心概念

### 角色：定义与旋钮

split 模式下角色分两层保存，面板只写旋钮，定义不被设置覆盖：

| 层 | 字段 | 位置 |
| --- | --- | --- |
| **定义** | `title` / `description` / `instructions` / `readOnly` / `canDispatch` / `cliDriver` / `cliCommand` / `cliPrefixArgs` / `cliArgs` / `cliPromptDelivery` / `cliCwd` | `$DSH_HOME/agent-switchboard/roles.json` 的 `roles`（split 模式） |
| **旋钮** | `backend` / `model` / `effort` / `provider` / `cliDriver` | 根条目 `agent-switchboard` 的 `config.roleSettings` |

split 模式下生效角色 = 定义 ⨝ 文件 `overrides` ⨝ `roleSettings`，逐字段合并、后者胜出。Host 把旋钮同步进 `overrides`，不改写文件里的 `roles`。legacy 模式（设置层尚未迁移为 `roleSettings`）则以根配置的完整 `roles` 优先（未提供时回落文件），面板显示完整卡片编辑器，Host 再把它同步进文件。

`cliDriver` 是定义字段中唯一会随旋钮层落进 `overrides` 的例外：定义层写初始驱动，面板的选择落在旋钮层；Host 以选择为准，按策展表派生 argv。

- `readOnly` 决定 spawn 角色的 preset 工具裁剪；CLI 角色则由 CLI 自己的沙箱参数表达。`canDispatch` 是允许嵌套派发的**显式目标 id 清单**，空清单即不可再派发（旧的布尔 `allowNestedDispatch` 仍兼容读取）。CLI 角色是叶子，指向它的 `canDispatch` 条目会被忽略。
- `instructions` / `readOnly` / `canDispatch` 对 spawn 角色属**组合期**：改动后下次派发前会热同步重建角色 preset；重建失败沿用上一版组合并在自检中报告，不确定时完全重启 DSH。
- `model` / `effort` / `cliDriver` 属**执行期**：下次派发即生效。
- 增删角色或改 `id` / `toolName` / `backend` 会改变工具集；当前实例拒绝这类结构变化的派发，需重新挂载。

### 派发后端

| 后端 | 执行方式 | 受理返回 | 结果 |
| --- | --- | --- | --- |
| `spawn` | 官方 `dsh-tool-subagent` 委派；角色另有独立 Agent Preset 承载 persona 与裁剪后的工具清单。 | `{ kind: 'activation', subagentId }` | 子代理完成后以完成通知送达。 |
| `cli` | 本插件把外部 CLI **直接作为后台任务**派发（`dsh-tool-jobs` 托管），没有中继子代理。 | `{ status: 'accepted', jobId }` | 完成通知送达后用 `job_output` 读有界输出。 |

两种后端都是**异步受理**，不阻塞、不轮询。`fork` 后端已移除：`dsh-subagent-fork-in-process` 不支持 `agentPreset`，fork 子代理无法拥有自己的角色指令与工具限制。

CLI 角色不产出角色 preset，`delegate_to_<role>` 工具按 agent 安装，因此嵌套子代理不会继承它。CLI 驱动只有 **codex** 与 **grok** 两个策展预设（`src/cli/drivers.js`）：面板只选 id，命令与参数由 Host 派生，没有逐字段编辑 argv 的入口；无法无损识别的旧配置会被标为待迁移（legacy 卡片显示「需重选预设」）。Claude Code 预设已移除（本机端到端不可用），实测记录保留在 [`docs/cli-backends.md`](./docs/cli-backends.md) §3。

### 两个 Agent preset

| preset id | 名称 | 组合 |
| --- | --- | --- |
| `switchboard` | **分工调度台** | scout / worker / architect / reviewer |
| `switchboard-solo` | **自办调度台** | scout / architect / reviewer；`excludedRoles: [worker]`，实现由主代理承担 |

两者由 `scripts/gen-preset.mjs` 生成到 `presets/switchboard.patch.yml`，共用同一份 standard 插件清单与角色文件；产品差异只在组合设置（`compositionKey`、`excludedRoles`）与 `supervisorRules`，另有 id、名称、说明与 `order` 不同。不要手改生成的 YAML。两个 preset 同时常驻装载，因此角色 preset id 按组合分命名空间（`switchboard-role-*` / `switchboard-solo-role-*`），避免 `Duplicate agent preset`；每个 spawn 角色一个预设，CLI 角色没有。

> 表中角色 id 是调度规则引用的约定；角色定义（persona、权限、CLI 契约）由使用者维护，仓库不内置角色内容。

选中任一 preset 时，`supervisorRules` 作为系统提示小节只注入主代理：四问路由（事实→scout、执行→worker、方向→architect、正确性→reviewer）或自办版的三问路由，外加任务包、异步受理、上下文与成本纪律。子代理只拿自身 persona。

### 设置页

入口为 **设置 → 角色与派发**。

- **split 模式**（设置层有 `roleSettings`）：每个角色一组旋钮——派发方式、模型、思考强度，spawn 角色另有供应商，`cli` 角色另有外部 CLI 下拉。`readOnly` 与 `canDispatch` 只读显示，属角色定义，不在本页编辑。
- **legacy 模式**（尚未迁移）：完整卡片编辑器，可编辑定义、新增与删除角色；保存后由 Host 同步进文件。卡片上的状态圆点只表示客户端配置校验结果，不代表本机 CLI 已实测可用；无法识别的 CLI 配置标为「需重选预设」。
- split 表单对未知的驱动 id 原样保留，不会猜测成 codex；`cliDriver` 留空表示沿用角色定义。

## 安全边界

`cli` 后端会在本机真的执行命令，可控性来自结构而非文案：

- 角色的 `backend` 必须**显式**设为 `cli`，且只有选中 Switchboard preset 的会话才挂载角色工具。
- 可执行文件与参数来自用户配置或策展预设；模型只能填充受限占位符 `{prompt}` / `{cwd}` / `{model}` / `{effort}`。
- 调用使用 `ctx.subprocess.spawn` 的 **argv 数组 + 显式 cwd**，`shell: false`，全程没有 shell 拼接。
- 只读由 CLI 自己的沙箱参数表达（codex `-s read-only`、grok `--permission-mode plan`），插件不能越过 CLI 强制。
- 插件不自动发现本机装了哪些 CLI。每个 CLI 的模型名属于它自己的命名空间，换 CLI 必须同时换模型，否则通常以退出码 `1` 失败。

## 配置

### 定义层：`$DSH_HOME/agent-switchboard/roles.json`

严格 JSON（由 `JSON.parse` 读取，不能带注释），`formatVersion` 当前为 `1`：

```json
{
  "formatVersion": 1,
  "roles": [
    {
      "id": "scout",
      "title": "侦察员",
      "description": "只读调研：定位相关代码、给出证据路径，不做任何修改。",
      "instructions": "只读调研，返回结论与证据路径。",
      "readOnly": true,
      "canDispatch": []
    },
    {
      "id": "architect",
      "title": "架构师",
      "description": "产出实现方案与接口约定，不写实现代码。",
      "instructions": "分析方案取舍并给出接口约定，不修改文件。",
      "readOnly": true,
      "canDispatch": [],
      "cliDriver": "codex",
      "cliCommand": "{node}",
      "cliPrefixArgs": ["{npmRoot}/@openai/codex/bin/codex.js"],
      "cliArgs": ["exec", "-s", "read-only", "--skip-git-repo-check",
                  "-m", "{model}", "-c", "model_reasoning_effort={effort}", "-"],
      "cliPromptDelivery": "stdin",
      "cliCwd": "C:\\path\\to\\workspace"
    }
  ],
  "overrides": [
    { "id": "architect", "cliDriver": "grok", "model": "grok-4.7" }
  ]
}
```

- `roles` 是定义；`overrides` 由 Host 把旋钮同步进来，**不要手改**。同步只写 `overrides`，不会改写 `roles` 里的定义；合并时 `overrides` 按字段覆盖定义。
- CLI 角色的整份 argv 契约住在定义里（安全敏感面）。`{node}` / `{npmRoot}` 在装载期解析成本机路径，`{model}` / `{effort}` / `{prompt}` / `{cwd}` 在派发时填充。
- `model` 可以省略在定义里，由 `roleSettings` 或 `overrides` 补；但 CLI 角色最终必须有显式模型，否则该 CLI 会静默使用自己的配置。

### 旋钮层：根条目 `agent-switchboard` 的 config

以下是形状示意（实际持久化在 profile patch 的 YAML 中，由设置页写入）：

```jsonc
{
  "mount": false,
  "provider": "self",
  "roleSettings": [
    { "id": "scout", "backend": "spawn", "model": "gpt-6-luna", "effort": "medium" },
    { "id": "architect", "backend": "cli", "cliDriver": "grok",
      "model": "grok-4.7", "effort": "high" }
  ]
}
```

> `cliDriver` 只写「选哪个 CLI」；所选驱动与定义不一致时，Host 按策展表重新物化 argv。模型名请按本机实际的 DSH route / CLI 替换。
>
> codex 必须以 `node <codex.js>` 形式调用：它的 `.ps1` / `.cmd` 入口在 `shell: false` 下都无法 spawn（实测，见 [`docs/cli-backends.md`](./docs/cli-backends.md) §1）。grok 的提示词走 `--prompt-file`，因为多行提示词无法作为单个 argv 元素传入。

## 实现要点（已核实）

- **纯 ESM、零构建、dual-face 单包。** 真正有约束力的是 `package.json` 的三个契约字段：`exports["."]`、`exports["./client"]` + `dsh.client`、`dsh.bundle.patch`。
- **设置页可写字段必须 `.volatile()`**，DSH 只暴露 volatile 字段给 GUI。bundle 的根条目只做配置桥接、不挂载角色工具；角色工具按 preset 会话挂载，不会污染其他 preset。
- **版本门禁以 peer 为准。** 插件刻意不声明 `engines.dsh`（它一旦存在会单独决定并忽略全部 peers），改由 4 个 `@deepseek-ai/dsh*` peer 精确 pin `0.2.1-rc.2`（另 pin `@deepseek-ai/cordis` 4.0.5、`@deepseek-ai/schemastery` 3.18.5）。门禁不通过时该 profile 会静默跳过插件、设置页消失。DSH 升级后用 `npm run dsh:delta` 判断「只改版本坐标」还是「接口真的变了」。
- **角色配置每次派发现读。** 文件按 mtime + size 缓存；损坏时保留上一份有效缓存并标记 stale，没有有效缓存则拒绝派发。
- **CLI 无运行时长上限。** stdout / stderr 经 Jobs 有界回流，实时日志不逐块进入任何模型上下文；任务 owner 是发起派发的 agent。
- **可观测性存在不对称。** CLI 派发会记录角色、线路摘要与退出状态；内置 spawn 后端没有等价的返回日志，统一调度记录仍是目标（见 [`docs/architecture.md`](./docs/architecture.md) §7）。

## 状态与验证边界

Phase 0–3 已实现，Phase 4 部分落地。`npm run check` 覆盖离线检查（含生成物漂移），不代表运行时验收。

**真机已验证：**

- 2026-10-17 完全重启后：插件正常装载、`plugin:verify` 为 `consistent`、根实例 `switchboard_selftest` 健康、四个角色 preset 注册成功。
- 2026-10-18，选中 Switchboard preset 的会话中向 `worker`（`cli(codex)`）真实派发：立即返回 `{status:'accepted', jobId}`，完成通知与 `job_output` 正常；CLI 自述的 `sha256(src/roles.js)` 与 HEAD 已由仓库侧独立重算核对。
- 2026-10-18，主代理 → worker → scout 的嵌套 spawn 派发通过，结果逐级冒泡。
- 2026-10-23，双 preset 完全重启后 roster 正常，`switchboard-solo-*` 命名空间隔离生效。
- codex / grok 的入口可执行性、模型与强度参数均有探针实测记录，见 [`docs/cli-backends.md`](./docs/cli-backends.md)。

**仍未验收：**

- 选中「自办调度台」的会话里实际只挂载 3 个角色工具（无 `delegate_to_worker`）并完成一次真实派发（按当前配置）。
- GUI 取消/停止沿 `exec.signal` 的传播，以及客户端任务面板的视觉表现（折叠、失败自动展开）。
- 生命周期工具：`upgrade --apply` 曾在历史 profile 上收敛成功；`install` / `uninstall` / `restore` 以及当前剥离语义的完整写入往返仍只有预演与离线夹具。Electron Plugins 页的按钮文案也未核实。
- 设置页的真实保存往返；配置格式为 `future` / `unsupported` 时 GUI 尚未展示拒绝原因。
- 子代理在 `0.2.1` 体系下实际拿到的 persona 与工具裁剪（只有离线证据）。

**已知限制：** 主代理的写文件权限没有被机制性剥夺（仅由调度规则约束）；统一结构化结果契约、并发与成本上限、统一调度记录尚未实现。CLI 的模型 × 强度组合也未逐项验证——grok 的已记录端到端样本只有 `grok-4.7` / `low`，且当前预设使用的 `--prompt-file` 传递尚未单独做真机实测。

## 文档地图

| 文件 | 内容 |
| --- | --- |
| [`docs/architecture.md`](./docs/architecture.md) | 当前实现、已核实的 DSH 契约、历史取证与设计约束 |
| [`docs/decisions.md`](./docs/decisions.md) | 技术决策记录（D1 起，含依据、代价与后续修订） |
| [`docs/plan.md`](./docs/plan.md) | 分阶段实施方案、验收标准与风险登记（历史状态待校准） |
| [`docs/cli-backends.md`](./docs/cli-backends.md) | CLI 后端实测参数表与验证边界 |
| [`docs/lifecycle.md`](./docs/lifecycle.md) | 安装、升级、安全卸载与版本管理运维手册 |
| [`CONTRIBUTING.md`](./CONTRIBUTING.md) | 提交规范与自查项 |

## 仓库布局

```
.
├── docs/                 架构、决策、方案、CLI 实测与运维手册
├── src/                  Host、Client、角色模型、角色 preset、CLI provider
├── presets/              生成物：两个 preset 声明与角色 preset 行模板
├── scripts/              检查链与仓库工具（lib/ 共享、ops/ 写入、probes/ 现场探针）
└── raw/                  临时区，已被 git 忽略，不进入历史
```

没有 `test/` 目录；检查位于 `scripts/check-*.mjs`，统一入口为 `npm run check`。

## 本地约定

- `raw/` 随时可清空，长期内容不要放在这里。
- 文本文件以 LF 入库（`.gitattributes`）；提交信息遵循 Conventional Commits，文档用中文。
- 跨 CLI 执行路径必须满足：可执行文件与参数来自用户配置，模型只能填充受限占位符，不得自由拼装 shell 命令。

## 许可证

[MIT](./LICENSE) © 2026 magicvr
