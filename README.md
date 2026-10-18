# DSH Agent Switchboard

> 把 DSH 主代理降级为「信息流统合器」，把具体工作委派给带角色的子代理——并且允许这些子代理活在本机的其他 CLI 里。

[![status](https://img.shields.io/badge/status-implemented-green)](#路线图)
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

面板里的 CLI 下拉框仅提供 **Codex CLI** 与 **Grok CLI** 两个预设。命令、参数、提示词传递与工作目录控件已隐藏，已有配置值保留；模型与思考强度仍可编辑。无法识别的旧配置显示「需重选预设」，不会自动显示成 codex。

> Claude Code 的预设已移除（本项目不再使用它）。它的实测记录保留在
> [`docs/cli-backends.md`](./docs/cli-backends.md) §3；当前没有自定义命令入口。

一句话：**主代理是调度台，角色是接线员，CLI 是可选的话务线路。**

选用本插件 preset 时，动态系统提示小节向主代理注入 preset 内部条目 `switchboard-roles.config.supervisorRules` 承载的调度规则：四问路由（事实→scout、执行→worker、方向→architect、正确性→reviewer）、任务包、生命周期、上下文与成本纪律及独立审查；其中派发语义为**异步受理**（`delegate_to_*` 返回子代理 id 后即可继续推进有用的工作，结果以完成通知送达，不轮询、不空转）。只进入可靠识别的主代理；子代理只拿自身 persona，不继承这套主代理规则；身份未知时不输出。字段由 `scripts/gen-preset.mjs` 的 `selfEntry` 生成，Config 仅声明字符串，无默认值、非 volatile，不在根条目，不开放 UI 编辑，模型与强度仍由角色配置和派发适配层决定。

支持的更新路径是先运行 `npm run plugin:upgrade` 预演，审阅后运行 `npm run plugin:upgrade -- --apply` 收敛，再完全退出并重启 DSH：preset 由 bundle 投递、profile 里不再内联副本。DSH 归档可读且仓库 preset 判定为漂移时，`install` / `upgrade --apply` 自动调用既有生成器再同步，无需先手工生成；归档不可用时明确报告未验证，并提示 `npm run gen:preset` 手工回退。自动再生成已有离线验证，真实写入仍未验证；预演的真机证据与待验收项见 [`docs/lifecycle.md`](./docs/lifecycle.md)。不要手改生成的 YAML，下次生成会覆盖。字段缺失、空串或仅空白时不注入、不回退代码副本；`switchboard_selftest` 明确告警并标为“可用但告警”，不阻断派发。`npm run check` 现在以 `node scripts/gen-preset.mjs --check` 收尾，同时比对 `presets/switchboard.patch.yml` 与 `presets/standard-plugins.json` 两个生成物：该漂移检查早先存在，但升级落地时**不在** `npm run check` 主链内，这正是漂移未被发现的原因；现已加入主链。**真机已验证（2026-10-17 重启后）：** 插件正常装载（`switchboard_selftest` 健康：健康、无 fatal）；`plugin:verify` 报 `验证：consistent / 下一步：已就绪`，运行时 `0.2.1-rc.2`、`DSH peers：compatible`、无需豁免（`0.2.1-rc.1 → rc.2` 只改版本坐标：全部代码树逐字节相同，无需改任何代码，只需重 pin）；**四个角色 preset 全部注册成功**——preset roster 出现 `switchboard-role-scout|worker|architect|reviewer`，`preset 异常行：（无异常行）`。profile 已用 `node scripts/ops/plugin-lifecycle.mjs upgrade --apply` 重新注入（写后复读验证通过，原文件备份为 `cordis.patch.yml.bak-lifecycle-2026-10-17T09-03-32-369Z-226b6e831bdd`），`check-profile-wiring` 为 `13 通过 / 0 失败`。

**尚待验收的一项：** 上面的自检来自**根实例**——根条目只注册自检并同步配置，不挂载角色工具。要确认 `delegate_to_*` 的实际挂载与一次真实派发，需要一个**选中 Switchboard preset** 的会话（那里自检会报 `已挂载角色工具：4`）。在默认 `standard` preset 下看不到角色工具是设计使然，不是失败。

这取代了此前依靠 `raw/AGENTS.md` 在触碰临时文件时偶然注入的状态：现在正式来源是受版本控制的适配文本，不读取临时草稿。官方工作区指令插件对子目录文件的动态注入仍可能把 `raw/AGENTS.md` 带入触碰 `raw/*` 的子代理；本插件未改动该机制。实现与离线验证见 [D29](./docs/decisions.md#d29--主代理调度规则硬编码并按-preset-动态注入)，真机提示词待验收。

### 插件生命周期与版本管理

`plugin:status` / `plugin:verify` 只读检测登记、preset、角色文件与兼容性；`plugin:install` / `plugin:upgrade` / `plugin:uninstall` 默认预演，显式 `--apply` 才收敛派生制品。工具不安装包、不修改依赖登记、不执行 pnpm，人工包步骤由 DSH 官方通道完成。`version:show` 检查版本，`version:bump` 默认展示计划，显式 `--apply` 才同步版本与 CHANGELOG，永不自动 commit 或 tag。**DSH 升级后先用 `npm run dsh:delta` 判定**：它只读地比对「仓库 pin 的版本」与本机运行时版本在契约面 12 个包上的逐文件差异，回答「只改版本坐标（可放心重 pin）」还是「接口真的变了（必须先改代码）」，并顺带报告上游 preset 是否变化；退出码 `2` 表示无法判定，**不等于安全**。命令参数、退出码、升级仪式、安装 / 升级 / 安全卸载顺序及验证边界见 [`docs/lifecycle.md`](./docs/lifecycle.md)。

## 核心设计

### 1. 角色（Role）

角色是一份声明式的配置，描述「这个子代理是谁、能干什么、要交什么」：

- **身份**：名称、一句话职责、给子代理看的系统提示词。
- **能力边界**：工具构成、能否写文件、是否允许继续往下派发子代理（防止无限套娃）。自 `0.2.1-rc.1` 起这三项是**组合期**事实：它们写在角色的独立 Agent Preset 里（见「派发方式」），改动需要重新注册 preset（当前实现为重新挂载 / 完整重启）。
- **产物契约**：期望的回传格式（例如「结论 + 证据 + 未决问题」），便于主代理机械地汇总而不是重新读一遍全过程。
- **派发方式**：走内置子代理，还是走某个本地 CLI。

### 2. 派发方式（Dispatch）

每个角色独立选择派发后端。两种后端均通过角色委派工具调用内置 `SubagentProvider`，主代理与工具层看不到线路差异：

- **`builtin`** — 复用 DSH 已注册的子代理 provider。当前的 `BUILTIN_PROVIDERS` 只剩 **`spawn`**：`fork` 后端已移除，因为 `dsh-subagent-fork-in-process` 声明 `capabilities.agentPreset: false` 且 `inheritsParentContext: true`，而 `dsh-tool-subagent` 对这类 provider 配置 `agentPreset` 会直接抛错——fork 子代理在机制上无法拥有自己的角色指令与工具限制。`backend: 'fork'` 现在被角色校验拒绝。上下文、沙箱、流式事件仍由 DSH 统一管，行为最可预期，也是默认选项。
- **`cli`** — 内置 spawn 子代理调用角色专属 CLI 工具，通过 `ctx.subprocess` 执行外部编码代理；结束后返回有界结果，由子代理简洁汇报。适合复用已有模型、额度或工具链。

**角色的 persona 与工具构成由一个独立 Agent Preset 承载（`0.2.1-rc.1` 起）。** 该版本删除了 `dsh-tool-subagent` 的 `persona` / `toolFilter` 两个配置字段，并对仍带这两个键的配置**在装载期直接抛错**（`backgroundMode` / `enableRunInBackground` 同样已从 Config 删除）；官方给出的迁移路径是「把 persona 与工具插件写进 Agent Preset，再用 `agentPreset` 选中」。本插件据此为**每个角色**注册一个 preset（`src/role-presets.js`，id 形如 `switchboard-role-<roleId>`）：角色指令成为该 preset 里 `@deepseek-ai/dsh-persona` 行的 `config.prefix`，工具清单由生成物 `presets/standard-plugins.json` 按角色裁剪而来。子代理不再「继承父 preset 再过滤」，而是挂载一个自带完整工具清单的独立 preset。`instructions` / `readOnly` / `allowNestedDispatch` 因此属于组合期，`model` / `effort` 仍是执行期 getter。理由、代价与被否决的替代方案见 [D32](./docs/decisions.md)。

**派发一律是异步受理，但两种后端的受理形态不同。**

- `spawn` 角色（官方 `dsh-tool-subagent` 委派）：返回 `{ kind: 'activation', subagentId }`，
  子代理结果稍后以完成通知送达。
- `cli` 角色（**直派后台任务**）：返回 `{ status: 'accepted', jobId }`，CLI 进程由
  `dsh-tool-jobs` 托管，完成通知送达后用 `job_output` 读输出。

两者都不阻塞等待结果；没有前台/后台模式，主代理不应轮询或空转。

CLI 运行中的 stdout / stderr 通过内置 Jobs 回流；**任务 owner 是发起派发的那个 agent**
（顶层派发即主代理，嵌套派发即那个子代理）。所有终态均不主动删除记录，交由 Jobs 的保
留策略处理（未核实）。
在一次性子代理侧边栏输入区上方可实时查看**该子会话**的 CLI 输出，有界只读面板不依赖
`turn/end`，默认自动滚到底，上滚暂停、可一键回到底部；始终保留官方一次性子智能体记录文案，
不提供输入或取消任务能力。侧边栏没有顶部任务列表所需的 header，不能依赖该列表呈现；
具体接入与真机验收见 [`docs/architecture.md`](./docs/architecture.md#62-cli-实时输出在一次性子会话输入区的呈现用户要求)。
Jobs 不可用时 CLI 照常执行，结果标注回流不可用。CLI 没有运行时长上限，实时日志不逐块进入
任何模型的上下文；既有调用方停止、任务取消及 owner 销毁链路保持不变。

> ⚠️ **`cli` 后端会真的在你的机器上执行本地命令。** 可控性来自两点：角色的 `backend` 必须被**显式**设为 `cli`，且该角色只在选中了 Switchboard preset 的会话里挂载。面板只让你**选一个 CLI**（codex / grok），命令与参数由 Host 按策展表（`src/cli/drivers.js`）填入并校验其完整形态；插件不会去猜、也不会自动发现你装了哪些 CLI。
>
> 安全上有一道结构性保障：调用走的是 **argv 数组 + 显式工作目录**（`ctx.subprocess.spawn`），全程没有 shell 参与，模型只能填充受限占位符，无法拼接出任意命令。

### 3. 配置（Plugin Panel）

「角色与派发」设置页在**legacy 模式**下采用官方「模型」页的卡片式交互：每角色一张折叠卡片，卡片头展示标题、id、机制徽标（内置 spawn 或外部 codex / grok）、模型与权限徽标，以及带可读 aria-label 的 8×8 状态圆点。绿点表示客户端配置校验通过，红点表示必填缺失、重复 id 或 CLI 预设需重选；不代表本机 CLI 已实测可用。点击「编辑」仅在该卡片原位展开，本地草稿须显式保存；取消、收起或切换编辑对象均丢弃未保存改动。列表底部「+ 新增角色」原位展开添加卡片，删除采用卡片内「确认删除 / 取消」两步确认。保存校验沿用原有规则与预设识别，并携带读取 revision。该卡片改版已通过离线检查，真实 GUI 观感与保存往返待验收。**split 模式**下同一位置渲染旋钮表单（见下）。

官方页面同样自绘：平台自动表单只支持标量字段，无法编辑变长对象数组。外部客户端插件禁止引入 Harness Client 包，因此本插件不复用官方 Modal/Button 等 UI 包，全部用手写 `h()` 和主题 token 实现，删除确认使用卡片内控件。

设置页按**模式**渲染两种形态：

- **split 模式**（设置层提供 `roleSettings`；迁移后的默认形态）——每个角色一行**旋钮**：
  派发方式（spawn / cli）、模型、思考强度。`backend: cli` 的行**额外**出现
  「外部 CLI」下拉（codex / grok；已有的 `custom` 或未知 id 原样显示，不锁死）。
  页面底部是操作区（**取消在左、保存在最右**）。
  ⚠️ **只读**与**能否继续派发**不在这里 —— 它们决定角色 preset 的构成（组合期事实），
  属**角色定义**、住在 `roles.json`；面板只如实显示当前值。
  驱动选择只写 **id**：命令与参数由 Host 按 `src/cli/drivers.js` 的策展表派生
  （`cliFieldsFor(driver, readOnly)`），面板**没有**逐字段编辑 argv 的入口 ——
  「argv 来自用户配置、模型只能填受限占位符」这条约束不该被一个网页表单打开缺口。
- **legacy 模式**（设置里仍是完整 `roles`，尚未迁移）——保留卡片式编辑器（每条卡片的
  展开 / 草稿 / 保存语义不变）。

角色的**真源是分开的两份**：

| 内容 | 住哪 |
| --- | --- |
| **定义**：title / description / instructions / **只读** / **可派发目标 `canDispatch`** / CLI argv 契约 | `$DSH_HOME/agent-switchboard/roles.json` 的 `roles`（**权威**） |
| **旋钮**：backend / model / effort / provider / cliDriver（只放**执行期**事实） | 根条目 `agent-switchboard` 的 `config.roleSettings`（设置页唯一可写的命名空间） |

生效角色 = `roles`（定义）⨝ 文件 `overrides` ⨝ 设置 `roleSettings`，逐字段合并、后者胜出。
根实例在 `loader/volatile-update` 返回前把**旋钮覆盖**同步进文件的 `overrides` ——
它**永不覆盖 `roles`**，所以手改 `roles.json` 的定义不会被设置顶掉；反过来，面板也不提供
定义字段的编辑入口（要改 persona 或 argv 就编辑文件）。

`backend: cli` 的角色**直接作为后台任务派发**：受理即返回 job 句柄，输出由 `dsh-tool-jobs`
显示，完成后由完成通知送达，模型用 `job_output` 读输出。它**没有**中继（转交）子代理，
因此**也没有** Agent Preset —— `switchboard-role-<cliId>` 不会出现在预设列表里。
`spawn` 角色仍走官方 `dsh-tool-subagent` 委派。直派工具**按 agent 安装**（与官方 standing
组合同构），嵌套子代理不会继承它 —— `allowNestedDispatch: false` 因此不会被绕过。

`instructions` / `readOnly` / `allowNestedDispatch` 属**组合期**事实：改这三项会重建角色
preset（当前实现：派发前热同步；不确定时完整重启 DSH）。`model` / `effort` / `cliDriver`
在执行期读取，下次派发即生效。Host 源码改动必须**完全退出并重启**（Node 模块缓存不能驱逐）。
文件损坏时保留上一份有效缓存并标记陈旧；无有效缓存时拒绝派发。
根条目直接注册 owning Fiber 的 `loader/volatile-update` 监听；事件载荷只含路径，监听器从
Volatile 引用读取已提交新值。同步失败会进入当前健康诊断（恢复后清除旧错误）。
CLI 可执行文件在**执行期**解析：自检装载时明确标「尚未验证」，执行后报告解析结果或失败。
**preset 不再携带 `config.roles`**：preset 是常驻单例，新会话只继承它，不重新 `apply`；
配置更新由文件 resolver 驱动。增删角色 / 改 id / toolName / backend 仍会改变工具集
（阶段 3，未实现）——当前实例拒绝结构变化的派发，并在自检中提示需重新挂载。

```jsonc
// ① 旋钮层：根条目 agent-switchboard 的 config（DSH 持久化在 profile patch 里）。
//    只放「会变的旋钮」，不含 persona / argv —— 面板写的就这一份。
{
  "mount": true,
  "provider": "self",
  "roleSettings": [
    { "id": "scout", "backend": "spawn", "model": "<DSH LLM route 的模型名>",
      "effort": "medium", "readOnly": true, "allowNestedDispatch": false },
    { "id": "architect", "backend": "cli", "cliDriver": "codex",
      "model": "gpt-6-luna", "effort": "max", "readOnly": false }
  ]
}
```

```jsonc
// ② 定义层：$DSH_HOME/agent-switchboard/roles.json —— **权威**，面板不编辑它。
{
  "roles": [
    {
      "id": "scout",
      "title": "侦察员",
      "description": "只读调研：定位相关代码、给出证据路径，不做任何修改。",
      "instructions": "只读调研，返回结论与证据路径。"
      // 定义层**可以**省略旋钮字段；缺的由 ① 与下面的 overrides 补。
    },
    {
      "id": "architect",
      "title": "架构师",
      "description": "产出实现方案与接口约定，不写实现代码。",
      "instructions": "分析方案取舍并给出接口约定，不修改文件。",
      // 走外部 CLI 的角色：argv 契约住在**定义**里（安全敏感面，面板不给编辑入口）。
      "cliDriver": "codex",
      "cliCommand": "{node}",
      "cliPrefixArgs": ["{npmRoot}/@openai/codex/bin/codex.js"],
      // 参数模板：只允许 {prompt} / {cwd} / {model} / {effort} 四个受限占位符。
      "cliArgs": [
        "exec", "-s", "read-only", "--skip-git-repo-check",
        "-m", "{model}", "-c", "model_reasoning_effort={effort}", "-"
      ],
      "cliPromptDelivery": "stdin",
      "cliCwd": "C:\\path\\to\\workspace"
    }
  ],
  // ③ 覆盖层：根实例把 ① 的旋钮同步到这里。**只写旋钮**（外加驱动选择），永不覆盖 ② 的定义。
  //    在面板把 architect 换成 grok 之后，这里会出现 { "id": "architect", "cliDriver": "grok" }，
  //    其 argv 由 Host 按策展表物化 —— 设置里不会出现任何命令或参数。
  "overrides": [
    { "id": "architect", "cliDriver": "grok", "model": "grok-4.7" }
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

当前实现提供按角色委派与线路提示；以下机制仍是目标，尚未全部落地：

- 主代理默认拿不到写文件类工具（DSH 提供 `ctx.tools.restrict()` 隐藏工具、`ctx.tools.guard()` 同步拒绝调用，见 [`docs/architecture.md`](./docs/architecture.md) 第 3 节）。
- 派发出去的每个任务都要求子代理回传结构化结果，主代理汇总的是结果而不是原始过程。
- CLI 派发已在回传结果附带角色、线路、argv、耗时与退出状态；内置后端没有等价的返回日志，统一调度记录仍待完善（见架构文档第 7 节）。

## 实现约束（已核实）

这些是从已安装的 DSH 里取证得到的硬事实，直接决定了插件怎么写，细节与证据见 [`docs/architecture.md`](./docs/architecture.md) 第 3 节：

- **外部插件不需要构建工具链。** 最小可用插件只有两个文件（`package.json` + `cordis.patch.yml`），纯 JS 即可安装运行。目录结构本身没有强制约定。
- 真正有约束力的是 `package.json` 里的三个契约字段：`exports["."]`（Host 半边）、`exports["./client"]` + `dsh.client`（Client 半边）、`dsh.bundle.patch`。
- **角色配置面板必须走 Client 半边**，且要能在 GUI 里实时编辑的字段必须标 `.volatile()`——DSH 的设置页只暴露 volatile 字段。
- **运行时的 DSH 版本门禁：`engines.dsh` 优先，否则校验 `peerDependencies`。** `0.2.1-rc.1` 的 `dsh-app-boot.unmetRequirements()` 读插件 manifest：若声明了 `engines.dsh`（必须是字符串），**它单独决定并忽略全部 peers**；否则 `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` 的每个 peer range 都必须匹配运行时版本（取 app-boot 自身版本，预发布参与匹配）。门禁不通过时该 profile bundle 被跳过（只写 stderr），插件行被标 `disabled: true`，**设置页静默消失**——本插件正是先被这样拒载，才发现的。本插件**刻意不声明 `engines.dsh`**：peer 的精确 pin 是唯一真源，写 `engines.dsh` 会静默覆盖 peers、丢掉这条断言。四个 dsh peers 精确 pin 到 `0.2.1-rc.2`（`@deepseek-ai/cordis` 4.0.5、`@deepseek-ai/schemastery` 3.18.5）；为什么用精确 pin 而非范围，见 [D32](./docs/decisions.md)。（旧说法「`engines.dsh` 不被校验」只对 `0.2.0-rc.2` 成立：那个版本从不读 `engines`。）

**最关键的一条：** DSH 的 `ctx.subagents` 是一个**具名 provider 注册表**，`registerProvider()` 是公开扩展点，而 `SubagentRun.localAgent` 的类型是 `Agent | undefined`。这个 `undefined` 分支就是「非 DSH 子代理」的官方预留位——**跨 CLI 派发不需要绕开内置机制，它就是内置机制的一个 provider。**

> 包名为 `@magicvr/dsh-agent-switchboard`，`package.json` 已落地并已 link 进 profile。决策清单见 [`docs/decisions.md`](./docs/decisions.md)。

## 路线图

分四期，每期都有必须真实通过的验收标准，见 [`docs/plan.md`](./docs/plan.md)。

- [x] **Phase 0 · 设计与取证** — 仓库初始化、摸清 DSH 契约、技术决策与实施方案定型
- [x] **Phase 1 · 最小可加载插件** — Host 与 Client 两半边均已生效
- [x] **Phase 2 · builtin 后端** — 5 条角色工具上线；模型按角色切换已用会话记录实证（详见 [`docs/plan.md`](docs/plan.md)）
- [x] **Phase 3 · CLI 后端** — provider、参数模板、输出解析已实现；codex 与 grok 均有真实派发通过记录。codex 的模型/强度有 CLI 自报路由证据；grok 的已记录端到端样本为 `grok-4.7` / `low`，不代表全部模型与强度组合已验证（见 [`docs/cli-backends.md`](./docs/cli-backends.md)）
- [x] **Phase 4 已落地部分** — 角色与派发设置页已实现并真机验收，CLI 调度信息进入主代理可见的回传结果
- [ ] **Phase 4 剩余项** — 并发与预算上限、统一调度记录及用法文档继续完善；内置后端返回日志的限制见 [`docs/architecture.md`](./docs/architecture.md#7-可观测性)

## 文档地图

| 文件 | 内容 |
| --- | --- |
| [`docs/architecture.md`](./docs/architecture.md) | 当前实现、DSH 契约与历史取证 |
| [`docs/decisions.md`](./docs/decisions.md) | 技术决策与后续修订 |
| [`docs/plan.md`](./docs/plan.md) | 分阶段方案、验收证据与风险 |
| [`docs/cli-backends.md`](./docs/cli-backends.md) | CLI 后端实测参数与验证边界 |
| [`docs/lifecycle.md`](./docs/lifecycle.md) | 插件安装、升级、安全卸载与版本管理 |

## 仓库布局

```
.
├── docs/
│   ├── architecture.md   已核实的 DSH 插件契约与取证
│   ├── decisions.md      技术决策记录（含历史方案与后续修订）
│   ├── lifecycle.md      插件安装、升级、卸载与版本管理运维手册
│   └── plan.md           目录结构、分期实施方案、验收标准、风险登记
├── src/                  Host、Client、角色模型与角色 preset（`role-presets.js`）、CLI provider 与配置存储
├── presets/              Switchboard preset 声明与角色 preset 的生成行模板（`standard-plugins.json`）
├── scripts/              根目录保留 check 链与仓库工具（含 asar 探针）
│   ├── lib/              共享路径解析与校验
│   ├── ops/              本机运维工具，含写入、迁移与修复
│   └── probes/           依赖本机安装与 CLI 的现场探针
└── raw/                  临时草稿区，已被 git 忽略，不进入历史
```

当前没有 `test/` 目录；检查位于 `scripts/check-*.mjs`，完整检查入口为 `npm run check`。
分阶段方案见 [`docs/plan.md`](./docs/plan.md#目录结构)，其中历史布局与状态待后续文档批次校准。

## 本地约定

- `raw/` 是临时区：抓取产物、一次性实验、临时素材丢这里。它被 `.gitignore` 忽略，随时可以清空，**不要**把需要长期保留的东西放在这里。
- 文本文件统一以 LF 入库（见 `.gitattributes`）；Windows 下如需 CRLF 由各人本地 git 配置决定。
- 提交信息、分支约定见 [`CONTRIBUTING.md`](./CONTRIBUTING.md)。

## 许可证

[MIT](./LICENSE) © 2026 magicvr
