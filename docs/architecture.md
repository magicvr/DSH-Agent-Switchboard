# 架构设计

> **状态：草案。** 本文描述的是**目标形态**，不是已实现的形态。带「待定」标记的地方都还没有结论。

## 1. 问题

单个代理同时承担规划、实现与验证时，上下文预算被细节消耗，角色边界模糊，过程不可审计。

## 2. 目标形态

```
                    ┌─────────────────────────────┐
   你的输入 ───────▶ │  主代理 / Switchboard        │
                    │  只做：理解 → 拆分 → 选角色    │
                    │        → 派发 → 汇总 → 汇报   │
                    └──────────────┬──────────────┘
                                   │  按角色的 backend 选择线路
                 ┌─────────────────┼─────────────────┐
                 ▼                 ▼                 ▼
          ┌────────────┐   ┌────────────┐   ┌────────────┐
          │ builtin    │   │ cli:codex  │   │ cli:claude │
          │ DSH 子代理 │   │ 本地进程   │   │ 本地进程   │
          └────────────┘   └────────────┘   └────────────┘
                 │                 │                 │
                 └─────────────────┼─────────────────┘
                                   ▼
                        结构化结果回流 → 主代理汇总
```

## 3. DSH 插件契约（已核实）

以下事实来自对已安装 DSH 归档（`app.asar`，版本 `0.2.0-rc.2`）与其中内置 Agent Skill 文档的只读取证，**不是推测**。它们构成了本插件的实现约束：

1. **外部插件不需要构建工具链。** 最小可用插件是两个文件：`package.json` + `cordis.patch.yml`。纯 JS 即可安装运行；TS 只是可选的开发体验，需要自己产出符合下述格式的产物。
2. **真正有约束力的是 `package.json` 里的三个契约字段**，目录结构本身是自由的：
   - `exports["."]` — Host 半边入口（惯例 `lib/index.js`）。
   - `exports["./client"]` + `dsh.client` — Client 半边。同一个 package.json 承载两半边（dual-face），不是两个包。
   - `dsh.bundle.patch` — 指向 `cordis.patch.yml`（可为有序数组，按序拼接）。
3. **Host 半边导出形态**（三选一，不可混用）：`export function apply(ctx, config)`（可附带 `export const inject` / `export const Config`），或默认导出 Service class。
4. **Client 半边产物格式是硬约束**：必须调用 `window.__ModuleLoader__.load({ id: <严格等于包名>, factory(require){...} })`，否则 DSH 报 `loaded without registering "<id>"`。React 从浏览器模块表 `require('react')` 取，无需重复安装。
5. **配置 schema** 用 `@deepseek-ai/schemastery` 的 `z.object({...})`，**命名导出 `Config`**。
   - ⚠️ 决定字段能否在 GUI 实时编辑的是 **`.volatile()`** —— `dsh-settings` 只暴露 volatile 字段。这直接决定 D6。
6. **运行时强制校验的是 `peerDependencies`** 上的 `@deepseek-ai/dsh*`；`engines.dsh` **不被校验**，写它只会误导。
7. **Tool 注册**：`ctx.tools.register(defineTool({ name, description, parameters, output, execute, presentCall }))`；`parameters` 是 JSON-Schema 风格对象，**不是** zod。
8. **Event 注册**：普通监听 `ctx.on(name, fn)`；waterfall 形态 `ctx.on(name, async (exec, next) => { ...; return next(); })` —— **必须 `return next()`**。事件名清单**不应**被当作稳定 API 写进文档，实现前用 `cordis_inspect_query`（Provider `Event`/`Service`）查当时的真实契约。
9. **Client UI**：`ctx.slots.inject(slot, () => ctx.slots.register({ name, id, order, inject }, View))`。已知可用 slot 含 `conversation.composer.dock`、`conversation.input.dock`、`shell.overlay` 等；写之前先用 `cordis_inspect_query`（Provider `Slots`）查实时 Slot 树。
   - ⚠️ **禁止 import 任何 Harness Client 包**（官方明令）；只用 `--dsw-alias-*` 主题 token。Client 半边崩溃会让整个 slot 空掉。
10. **安装走 `plugin_manager install_bundle`**，不要手写 profile 的 `package.json` / `cordis.patch.yml`，也不要手动跑 pnpm。

### 3.1 Phase 1 实测新增的装载期约束

以下两条是写 Phase 1 代码时**被真实装载过程教会的**，比上面任何一条都更容易踩：

11. **`@deepseek-ai/*` 可以被外部插件 import，这个 import 是对的。**
    - 它们在磁盘上**不存在**于 profile 或安装目录的任何 `node_modules`（只在 `app.asar` 内）。从磁盘用原生 node 解析**必然失败**（实测 `ERR_MODULE_NOT_FOUND`）。
    - 但运行时由 dsh 安装处以「**双锚点解析**」供给（官方措辞：module resolution is two-anchor by construction — 先从 dsh 安装的 launcher 包解析，再从 profile 解析），并由 `dsh-app-boot` 把这套解析注入 Node 的 ESM/CJS 解析器。
    - **教训：不要用「磁盘上能不能找到」来判断插件能否 import 某个包。**

12. **工具 schema 是「两层」的：`defineTool` 的 value schema DSL，编译后才交给受限 JSON Schema 子集校验器。**
    - **第一层（写代码时面对的那层）**：`output.schema` 是 **value schema DSL**，必需性用**属性级 `required: true`** 表达。对象级 `required: [...]` 在这层**非法**，报 `schema.required is not supported by the value schema DSL`。
    - **第二层（编译器产出的那层）**：DSL 编译产物（普通 JSON Schema）再被 `assertSupportedJsonSchema` 校验。该层合法关键字仅 `type` / `oneOf` / `properties` / `required` / `additionalProperties` / `items` / `enum` / `const` + 注解 `description` / `title` / `default` / `examples`；`required` 只允许出现在 `type: "object"` 节点上，且必须是**属性名字符串数组**。
    - `object` 节点的 DSL 白名单只有：注解 + `type` + `properties` + `additionalProperties`（**不含 `required`**），且 `additionalProperties` **必须显式给出 `true` 或 `false`**。
    - 属性上的 `required` **只能是 `true`**（写 `false` 报 `must be true when present`）。
    - **DSL 会自动把属性级 `required: true` 装配成对象级 `required` 数组**（`property-map` / `property-map-tail`）。因此手写那个数组等于手写编译产物，必然失败。
    - ⚠️ **本插件为此连错两次，方向相反**：第一版写属性级 `required: true`，却把这一层误判成裸 JSON Schema 而去“修正”，第二版改成对象级 `required: [...]`，反而破坏 DSL。正确写法是只写 DSL 输入，**不要写对象级 `required`**：
      ```js
      output: { schema: { type: 'object', additionalProperties: false,
        properties: { ok: { type: 'boolean', required: true } } } }
      ```
    - 校验器实现位置：`dsh-tools/lib/index.js` 的 `runSchemaCompiler` / `assertAuthorKeys` / `property-map` / `property-map-tail`（DSL 层）与 `checkSchemaNode` / `checkObjectSchemaTail` / `assertSupportedJsonSchema`（子集层）。
    - **验证方法教训**：只对「编译产物」跑子集校验器**不够**，会漏掉 DSL 层错误。必须**两层都验**，并用已知错误写法做回归对照，确认预检本身有效。

### 3.1b Phase 2 实测补充：运行时挂载与 preset 注册

13. **`ctx.plugin(module, config)` 可在运行时挂载其他插件**，返回 `Fiber`（Cordis 文档：「`ctx.plugin()` starts a plugin and returns a `Fiber`」）。传**模块命名空间**即可——Cordis 会取它的 `apply` / `inject` / `Config`，而这三者正是 `dsh-tool-subagent` 的导出。这是「每个角色一个委派工具实例」得以数据驱动的机制基础。
14. **`agentPresets.register(definition)` 可在运行时注册 preset**（返回 `Promise<disposer>`，eagerly loads）。`PresetDefinition = { id, name?, description?, order?, plugins }`，其中 **`plugins` 是内联的 `EntryOptions` 列表，不是对已有条目的引用** —— 所以 preset 可以由数据生成，不必写死在 profile 的 patch 里。
15. **LLM 的 provider route 名 = `llm-pi-ai` 配置里 `providers` 字典的 key**（官方措辞：「each key is the provider route name a request selects with `GenerateOptions.provider`」）。本机该 profile 的 key 为 `self`。
16. **`SubagentStartRequest` 没有沙箱字段**（完整声明：`label` / `prompt` / `parent` / `signal` / `agentOptions` / `outputSchema` / `maxDepth` / `toolFilter` / `persona`）。因此角色的「只读」**只能**用 `toolFilter.deny` 做工具级约束，无法做成沙箱子会话。这一点必须在文档与界面上如实标注，不能含糊成「只读沙箱」。
17. **`dsh-tool-subagent` 的 Config 是每实例一个工具的机制**：官方 `dsh-base` 就是靠挂两个实例（`toolName: subagent` + `toolName: subagent_fork`）同时提供两种派发方式。

### 3.1c Phase 2 实测补充：三个会重复踩的坑

18. **必须显式调用 `.volatile()`；把子对象「命名」为 `volatile` 没有任何效果。**
    - `dsh-settings` 的判定是 `if (schema.meta.volatile) return plainSchema(schema)`，即读**节点自身的 `meta.volatile`**。
    - 其 JSDoc 原文：「Select fields whose **nearest volatile ancestor** makes them editable without remounting.」→ 标在一个对象节点上，其**子字段**即自动可编辑；不必逐字段标记。
    - 实测 `.volatile()` 的落点：`z.boolean().volatile()` → 该字段 `meta.volatile: true`；`z.object({a}).volatile()` → **只有对象节点**带标记，`a` 不带。
    - ⚠️ **本插件为此栽过一次**：代码里写的是 `volatile: z.object({...}).default({})` —— 注释还明确写着「volatile 子对象里的字段可在设置页实时编辑」，但**代码里根本没有 `.volatile()`**。典型的文档与实现脱节。离线预检（`scripts/check-config-schema.mjs`）现在会把这条抓出来。
19. **schemastery 没有 `z.enum`。** 枚举要用 `z.union([...])`（真实插件 `dsh-agent-tool-presentation` 即如此写）。沿 zod 的直觉写 `z.enum([...])` 会在**模块加载期**抛 `TypeError: z.enum is not a function`。
    - 症状可用于快速分流：它让条目停在 **`fiberPhase: null`**（fiber 根本没创建），与「`apply` 内出错」的 **`fiberPhase: failed`** 不同。
20. **`toJSON()` 不是 JSON Schema。** 它返回 schemastery 的内部表示（`uid` / `refs` / `dict` / `list` / `inner`），而 `toJSONSchema` 不在 `@deepseek-ai/schemastery` 上（在 typert/loader 侧）。要检查字段是否被描述到，**直接遍历内部表示**即可，不必为检查去复刻一个投影器。

> **离线预检的可行性前提（重要）**：`npm install` 会把 `peerDependencies` 一并装入仓库的 `node_modules`，因此 `@deepseek-ai/schemastery`、`@deepseek-ai/dsh-tools` 等**在仓库里就装得到**，于是 import 插件模块、构造 Config、遍历 schema 都能在 Node 里离线完成，**不必重启 dsh**。这是本项目应对「Host 半边不能热加载」的主要手段。
>
> 注意由此产生的一个认知修正：早期曾以为「`@deepseek-ai/*` 只存在于 asar 内、外部解析必然失败」，那个结论**只对未安装依赖的仓库成立**。装上依赖后它们就是普通本地包。

### 3.2 一条误导性的诊断信息（重要）

**加载器会把「插件激活失败」一律显示为 `failed to import`。**

已核实其来源：`dsh-app-boot` 的 `inactiveEntries()` 在 `entry.fiber === undefined` 时产出字面量 `"failed to import"`。而 `fiber === undefined` **并不等于**「模块没加载成功」——本插件第一版就是**模块加载完全成功、`apply` 正常进入**（报错堆栈里可见 `src/index.js` 行号），却在 `apply` 内抛错，最终仍被报告为 `failed to import`。

**教训：遇到 `failed to import` 不要只往模块解析方向查。** 取真实错误的办法按可靠性排序：

1. 让模块在 evaluate 时写一个落地文件 —— 文件出现即证明模块已加载，问题在激活阶段。
2. 在 `apply` 里加临时 `console.error`。
3. 用 `cordis_inspect_query` 的 `Config.listConfigs`（`name` 过滤）看条目 `status` 是否为 `inactive`。

### 3.3 link 模式下的模块缓存

**以 `link:` 方式安装的插件，改动源码后 `set_plugin` 开关或 `install_bundle` 都不会重新加载模块。**

实证：修改源码后 `set_plugin` 禁用再启用，报错堆栈里的**行号仍是旧代码的行号**；在模块顶层加落地文件探针后重复开关，**文件始终未生成**——证明新代码从未被执行。官方文档已说明：「replacing an installed package requires restart to load a fresh JavaScript module generation」。

**后果：** 开发迭代中每次 Host 半边改动都需重启 dsh 才能被真实装载验证。无法重启时可用这个办法取得客观结论——把 `dsh-tools` 的校验器逻辑抽取出来对 schema 单独跑。本插件 Phase 1 即以此证明修复有效：抽取版对新 schema 报 0 violations，且能**逐字复现**线上对旧写法的报错文案。

> 参考位置（**仅存在于安装归档内，不是本仓库文件**）：内置 Skill `dsh-agent-preset/skills/cordis-plugin-development/`，含 `SKILL.md`、`references/*.md` 与 `templates/{decoration,mcp}/` 六个模板文件。官方**没有** `create-dsh-plugin` 脚手架，也没有示例插件仓库。
>
> 另有一项尚未本地核实：TS 基座 `tsconfig.base.json` / `tsconfig.base.client.json` **不随安装分发**，外部作者需要去上游仓库取（上游地址 `github.com/deepseek-ai/deepseek-harness`，取自各包 `repository` 字段，**本仓库尚未联网确认**）。

## 4. 技术决策

**已定型的决策与理由见 [`decisions.md`](./decisions.md)**（编号 D1 起，含依据与风险）。本文件不重复维护决策表，避免两处编号冲突。

与本文档第 3 节契约直接对应的几条结论，速览：

| 决策 | 结论 | 依据小节 |
| --- | --- | --- |
| 语言与工具链 | 纯 ESM JavaScript，零构建 | 第 3 节第 1、4 条（无 `.d.ts`、产物格式硬约束） |
| 插件形态 | dual-face 单包 | 第 3 节第 2 条 |
| 派发抽象 | 统一走 `ctx.subagents`，两类后端收敛到 `SubagentProvider` | 第 3 节补充：`subagents` 是具名 provider 注册表 |
| 角色 → 工具 | 自己注册工具，内部调 `ctx.subagents.start()` | 第 3 节第 7 条 |
| 子进程 | `ctx.subprocess.spawn`（argv 数组，无 shell） | `subprocess` 服务契约 |
| 配置 | 分两层；GUI 可编辑字段必须 `.volatile()` | 第 3 节第 5 条 |

## 5. 角色模型（草案）

一个角色至少包含：

- `id` / `title` / `description`
- `systemPrompt` — 子代理的角色提示词
- `readOnly` — 是否允许修改文件
- `allowNestedDispatch` — 是否允许该子代理再往下派发（**默认 `false`**，防无限递归，见 `decisions.md` D11）
- `backend` — `builtin` 或 `cli`
- `cli` — 当 `backend` 为 `cli` 时：可执行文件、`args` 数组模板、**`model` 与 `effort`（模型与思考强度）**、`modelFlag` / `effortFlag` 映射、工作目录、超时
- `resultContract` — 期望的回传结构

其中 `model` 与 `effort` 是**角色级固定配置，主代理无权覆盖**（`decisions.md` D12）。`effort` 取值来自统一枚举 `minimal | low | medium | high | xhigh | max`，若与后端声明的 `effortValues` 不匹配则**装载期报错，不静默降级**。

## 6. CLI 派发后端（草案）

调用外部 CLI 至少要考虑：

1. **调用形态**：多数 CLI 支持一次性（print/exec）与非交互会话两种模式，需要确认各自的实际参数。
2. **提示词传递**：走命令行参数还是 stdin；参数长度上限。
3. **工作目录与沙箱**：外部 CLI 自己的沙箱与权限需要单独配置，不能假设它与 DSH 的沙箱一致。`codex` 有独立的 `-s/--sandbox` 与审批策略，必须由用户显式声明，不可与 DSH 的沙箱策略混为一谈。
4. **输出解析**：是否支持结构化输出（如 JSON），不支持时如何从文本里稳定提取结果。
5. **模型与思考强度**：三者 flag 形态完全不同（`codex` 走未文档化的 `-c model_reasoning_effort=`、`claude` 走 `--effort`、`grok` 走 `--reasoning-effort`），且可用档位随模型变化。由本插件的 `model` / `effort` 结构化字段映射，见 `decisions.md` D12。
6. **超时与中断**：长任务如何取消；子进程被杀后残留状态如何处理。
7. **失败语义**：命令不存在、未登录、额度耗尽、非零退出码，分别如何上报给主代理与用户。
8. **安全**：命令与参数必须来自用户配置，不能由模型自由拼装，否则等于开放任意命令执行。

> 第 8 点是硬性要求：**参数模板由用户提供，模型只能填充受限的占位符（如 `{prompt}`、`{cwd}`、`{model}`、`{effort}`），绝不允许模型自己生成可执行文件名或自由拼接 shell 命令。** 占位符替换始终发生在**单个 argv 元素内部**，替换结果不参与任何字符串拼接。

## 7. 可观测性

每次派发记录：任务标识、角色、后端线路、起止时间、退出状态、结果摘要。用途是让你能回答「这件事到底是谁做的、花了多久、成功没有」。
