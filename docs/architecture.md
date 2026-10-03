# 架构设计

> **状态：核心实现已落地。** Host、Client 角色设置页、CLI 专属工具与按角色委派均已实现。CLI 的 spawn 包裹链路已通过离线假 CLI 验证，DSH 真机验收尚未执行。本文同时保留 DSH 契约、历史实测与仍适用的设计约束；历史方案被取代处注明当前行为。主代理写工具限制、统一结构化结果契约、并发与预算上限尚未实现；不要把目标形态当作已具备的能力。带「待定」或「未核实」标记的内容仍需验证。

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

### 3.1d preset 机制实测（本项目最关键的机制结论）

21. **当前组合是「根条目启用 + preset 显式 `mount: true`」。** 根实例提供配置同步与自检；角色工具和路由指引只在声明了 `mount: true` 的作用域挂载。
    - **历史实测（以下禁用根条目的方案已被后续 D13 / D14 取代）：** 早期先只「加上 preset 声明」，插件仍报告挂在根上；再把 profile 全局条目设为 `disabled: true`，角色工具才只在选中该 preset 的会话里生效，其他会话连 `switchboard_selftest` 都看不到。当时以 Loader 按包名处理解释该现象，采用了「preset 声明 + 移除全局挂载」。这不是当前的挂载门禁。
    - preset 条目的 `config` 会作为插件配置传入（历史实测 `provider/maxDepth/cwd/roles` 均正确到达）。**当前 preset 不再携带 `roles`**，只声明挂载等作用域配置；常驻 preset 在启动时从 `$DSH_HOME/agent-switchboard/roles.json` 读取，运行期由根实例的 `loader/volatile-update` 持久化后，静态工具在执行期通过文件 resolver 读取（见 D25）。
    - 历史上「bundle 声明 `disabled: true` + preset 再声明一次」确实能激活 preset 插件，`[]` 也曾被确认语法合法；**该方案已被后续决策取代，不能据此禁用当前根条目**。客户端模块扫描跳过 disabled 条目，禁用根条目会让「角色与派发」设置页**静默消失，没有报错**（`cordis.patch.yml` 第 5–15 行）。
    - 历史 A/B 对照曾是：未选 preset 看不到自检和委派工具，选中后有 30 个工具（含自检与 4 个委派工具）。**当前自检在 `mount` 判断之前注册，根作用域及继承它的会话都可看到 `switchboard_selftest`；`delegate_to_*` 仍只在挂载角色的作用域可见。** 不应把旧工具数量或自检不可见作为当前验收条件。
22. **`agentPresets.composedPreset(ctx)` 必须传入「处于该作用域内」的 ctx，否则永远返回 `undefined`。**
    - 实现是 `standingMountFor(ctx)?.presetId`，即**从传入的上下文向上找最近的 preset 挂载**。
    - 本插件的 `apply` 运行在**根上下文**，从那里向上查找永远命中不到 preset 挂载 —— 所以曾一度出现在自检里的 `preset 作用域：根作用域` 是**假信号**，与 preset 是否生效无关（该字段已删除）。
    - 正确用法：在**工具调用时**传 `exec.agent.ctx`（那才处于会话的作用域内）。`dsh-subagent` 里的 `composeFrom(childCtx, parent.ctx)` 同理。
    - ⚠️ **教训：问「我在哪个作用域」时，必须用在作用域内的那个 ctx。用作用域外的 ctx 去问，答案永远是「不在任何作用域」。**
23. **插件的诊断/状态不能放在模块级**：本仓库初版把 `diagnostics` 写成模块级对象，实测出现自相矛盾的自检输出（`codex-scout=失败` 与 `因开关未挂载：（无）` 并存）。
    - 直接原因是当时本插件被**激活两次**（根一次、preset 作用域再一次）：后一次 `apply` 重置了模块级字段，而自检读到的是产生 `mounts` 的那一次。
    - 现已把这份状态改为每次 `apply` 用 `newDiagnostics()` 新建一份（无论将来是否又会变成多实例都正确）。
    - 现状补充：根条目启用，根实例注册自检并同步配置；preset 实例在 `mount: true` 时挂载角色。因此仍必须保持「实例自带状态、不共享模块级可变对象」，不能假定只激活一次。

### 3.1c Phase 2 实测补充：三个会重复踩的坑

18. **必须显式调用 `.volatile()`；把子对象「命名」为 `volatile` 没有任何效果。**
    - `dsh-settings` 的判定是 `if (schema.meta.volatile) return plainSchema(schema)`，即读**节点自身的 `meta.volatile`**。
    - 其 JSDoc 原文：「Select fields whose **nearest volatile ancestor** makes them editable without remounting.」→ 标在一个对象节点上，其**子字段**即自动可编辑；不必逐字段标记。
    - 实测 `.volatile()` 的落点：`z.boolean().volatile()` → 该字段 `meta.volatile: true`；`z.object({a}).volatile()` → **只有对象节点**带标记，`a` 不带。
    - ⚠️ **本插件为此栽过一次**：代码里写的是 `volatile: z.object({...}).default({})` —— 注释还明确写着「volatile 子对象里的字段可在设置页实时编辑」，但**代码里根本没有 `.volatile()`**。典型的文档与实现脱节。离线预检（`scripts/check-config-schema.mjs`）现在会把这条抓出来。

18b. **`.volatile()` 之后，该子对象变成「引用对象」：属性不在自身上，必须用 `.get()` 取值。**
    - 实测（`node -e` 直接跑真实 `Config`；样本字段是当时的 `allowCrossCli`，
      该字段**后来已随「跨 CLI 总开关」一并移除**，但这条机制本身不变 ——
      批次 2a 又移除了 `cliTimeoutSec`，现在仅保留空容器兼容旧配置；以下为历史样本）：
      ```text
      r.volatile                  → {}                  （JSON.stringify 也是 {}）
      r.volatile.<字段>           → undefined           ← 直接读恒为 undefined
      r.volatile.get()            → {"cliTimeoutSec":900}
      ```
    - ⚠️ **这是一个真实且长期潜伏的 bug 的根因**：`src/index.js` 曾写
      `const allowCrossCli = resolved.volatile?.allowCrossCli === true;`
      → **恒为 `false`**，跨 CLI 派发开关**从未真正生效过**。
    - 为什么长期没被发现：自检一直显示「allowCrossCli 未开启」，而那**恰好就是
      默认关闭时的正常表现** —— 失效与默认值的外观完全一致。直到在 preset 里显式
      写入 `volatile.allowCrossCli: true` 仍不生效，才暴露出来。
    - **教训（与本文件 3.1f 第 38 条同一类）**：凡是 `.volatile()` 标过的字段，
      一律经 `readVolatile()` / `readVolatileField()` 取值，**不得直接读属性**。
    - 为什么已有 103+55+55 条断言都没抓住：它们直接调用纯函数
      `planCliMounts(roles, boolean)`，**绕过了 `apply` 层的取值**。
    - 修法与防线：新增 `readVolatile(resolved)`（兼容带 `.get()` 的引用对象与普通对象，
      因为 Loader 经 JSON Schema 投影后可能给出后者），并新增
      `scripts/check-config-volatile.mjs` —— 它刻意**穿过真实 `Config` schema** 取值，
      且先自检「直接读确实取不到值」以证明自己在测真实行为而非测空气。
    - 教训：**「配置通过」不等于「配置被读到」。** 纯函数单测无法覆盖「取值方式」这一类
      错误，必须有一条穿过真实 schema 的路径。
19. **schemastery 没有 `z.enum`。** 枚举要用 `z.union([...])`（真实插件 `dsh-agent-tool-presentation` 即如此写）。沿 zod 的直觉写 `z.enum([...])` 会在**模块加载期**抛 `TypeError: z.enum is not a function`。
    - 症状可用于快速分流：它让条目停在 **`fiberPhase: null`**（fiber 根本没创建），与「`apply` 内出错」的 **`fiberPhase: failed`** 不同。
20. **`toJSON()` 不是 JSON Schema。** 它返回 schemastery 的内部表示（`uid` / `refs` / `dict` / `list` / `inner`），而 `toJSONSchema` 不在 `@deepseek-ai/schemastery` 上（在 typert/loader 侧）。要检查字段是否被描述到，**直接遍历内部表示**即可，不必为检查去复刻一个投影器。
20b. **历史 CLI provider 路径（批次 3a 已取代）的工具配置必须显式写 `maxDepth: 'provider-managed'`，「不写」反而是错的。**
    - `dsh-tool-subagent` 的断言：
      ```js
      if (ctx.subagents.resolveMaxDepth(config.maxDepth) !== void 0
          && !subagentProvider.capabilities.depthLimit)
        throw new Error(`... cannot enforce maxDepth (no depthLimit capability) — set maxDepth: 'provider-managed' to leave the recursion budget to the provider`);
      ```
      而 `resolveMaxDepth` 是：
      ```js
      if (configured === "provider-managed") return void 0;   // ← 只有这一条能绕过断言
      if (configured !== void 0) return configured;
      const depth = this.config.maxDepth.get();               // ← 不写就回落到数字默认值
      ```
    - ⚠️ 本仓库一度按「CLI provider 没有 `depthLimit` 能力，所以**不要**设 maxDepth」来做 —— **依据是反的**。不设 → 回落到数字默认值 → 断言照样触发并抛错。
    - 实测后果：provider 注册成功、自检报 `codex-scout=OK`，但工具**没有**注册，主代理调用时报 `unknown tool "delegate_to_codex_scout"`。断言自己的报错信息就直接给出了正确做法。
20c. **`ctx.plugin()` 的抛错不会传到调用方，所以「挂载成功」必须核实，不能假设。**
    - `ctx.plugin(module, config)` 只是**启动一个 fiber**，插件的 `apply` 在其后运行；插件在 `apply` 里抛的错发生在另一个调用栈上，`try/catch` **抓不到**。
    - 本仓库的 `mountRoleTool` 原先是 `try { ctx.plugin(...); return {ok:true} }` —— 无条件报成功，于是自检在骗人（`OK` + `unknown tool` 并存）。
    - 修法：`ctx.plugin()` 之后 `await` 两个微任务，只记录**首次核验快照**，不保证 fiber 已完成激活（注入/provider 可能稍后才就绪）。查询必须带当前作用域：`ctx.get('tools').get(role.toolName, scopeOf(ctx))`；此时未出现只记录首次核验失败。**当前健康以自检调用时的实时查询结果为准**，快照仅解释历史，不能回落为健康判据。
    - 一般化：**任何「启动型」API 的返回值都不等于「启动成功」。** 要么核实终态，要么明确标注为未核实。

> **离线预检的可行性前提（重要）**：`npm install` 会把 `peerDependencies` 一并装入仓库的 `node_modules`，因此 `@deepseek-ai/schemastery`、`@deepseek-ai/dsh-tools` 等**在仓库里就装得到**，于是 import 插件模块、构造 Config、遍历 schema 都能在 Node 里离线完成，**不必重启 dsh**。这是本项目应对「Host 半边不能热加载」的主要手段。
>
> 注意由此产生的一个认知修正：早期曾以为「`@deepseek-ai/*` 只存在于 asar 内、外部解析必然失败」，那个结论**只对未安装依赖的仓库成立**。装上依赖后它们就是普通本地包。

### 3.1e 插件配置 UI 的实测边界（决定能否「在面板里配角色」）

24. **volatile 字段不得出现在数组元素内部**，所以 `roles` 只能在**数组整体**上标 volatile。
    - 客户端的 `validateVolatileSchema` 在遍历 `schema.list` / `schema.inner` 时把 `blocked` 置为 `true`，其后任何 volatile 节点直接抛
      `volatile fields require a fixed object path without an enclosing volatile field`。
    - 逐行复刻该函数实测：`z.object({roles: z.array(R).volatile()})` → 通过；
      `z.array(z.object({backend: z.union([...]).volatile()}))` → 抛错，路径 `["roles","*","backend"]`。
    - 含义：想让 `roles` 可编辑，必须标在**数组本身**；标在元素内既不生效也会报错。
25. **自动配置表单只处理标量字段。** `ConfigFormController.set(field, value)` / `unset(field)` 的文档原文是 `@param field - scalar field inside the namespace section`。变长对象数组（如 `roles`）**无法**由自动表单渲染。
26. **但服务端支持数组下标路径与增删元素。** `dsh-settings` 的字段编辑识别数字下标：
    ```js
    if (!/^(0|[1-9][0-9]*)$/.test(head) || ...) // roles[0]
    if (rest.length === 0 && op.op === "unset") result.splice(index, 1); // 删除该元素
    ```
    原文注释：「unsetting an array index removes its element」。
    **结论：缺的只是 UI，不是机制** —— 自建设置页即可完整编辑角色数组（见 decisions.md D13）。
27. **DSH 已提供的配置接入点（无需自造机制）：**

    | Slot / 服务 | 用途 |
    | --- | --- |
    | `settings.section` | 一个设置页。注册 `{id, order, label}`；`id` 用自己的即**并列新增**，复用已占用 id 会**替换**该格。现有占用：`account` / `general` / `models` / `plugins` / `agent-presets` |
    | `settings.general.item` | General 里的一行偏好（单设置项，无需独立页） |
    | `settings.plugins.tab` | Plugins 区里的一页 |
    | `configForms.describe()` 返回的**镜像面** | **读**配置：`ensure()`（异步补全）/ `getSnapshot()`（`view.namespaces`、`view.writable`）/ `subscribe()` |
    | `settings.mutate(ns, ops, expectedRevision)` | **写**配置（远程通道 `remote.settings`）；承载数组下标路径。⚠️ 第 27 条曾写 `.mutate(ops, expectedRevision)` 挂在 `configForms.get()` 上，**该形状未经证实**，以本行为准 |

    **官方同构先例**：`agent-presets` 自己就是一个 `settings.section`；官方「模型」页
    （`dsh-client-ui-settings-models`）是最完整的读写样本，见新增的第 3.1f 节。
    ⚠️ 本插件的 Client 半边**禁止 import 任何 Harness Client 包**（第 3 节），因此自建页面时表单需要自绘。
28. **写入是否受 volatile 限制，取决于用哪个方法。** `SettingsForms.write(ns, change, expected, paths)` 的 `paths` 参数**默认为空数组**，而 volatile 校验是 `for (const path of paths) if (!isVolatilePath(...))`：

    | 方法 | 传 paths？ | 受 volatile 限制？ |
    | --- | --- | --- |
    | `settings.mutate(ns, ops, rev)` | 是（`ops.map(op => op.path)`） | **是** |
    | `settings.update(ns, patch, rev)` | 否 | 否 |
    | `settings.replace(ns, section, rev)` | 否 | **否** |

    - 因此编辑 `roles` 有两条路：**甲**给 `roles` 标 `.volatile()` 并用 `mutate` 下标路径；**乙**不改 schema，用 `replace` 整块写 `{roles: [...]}`。
    - 本插件选**甲**（`roles` 已标 volatile），设置页整体提交 `set(['roles'], value)` 并携带 `revision` 做并发保护；Host 根实例将角色立即同步到文件。Switchboard preset 是启动时加载的常驻单例，新会话只继承它，不会重新执行 `apply` 或重读文件；根实例写盘后不广播重挂；常驻工具骨架保持不变，后续委派与提示组装通过文件 resolver 使用新快照。文件损坏保留最近有效缓存并由自检报告。 乙是保留方案。
    - 另注：`write` 还要求 `volatileForm(schema) !== undefined`，否则抛 `Plugin entry "…" has no volatile…` —— 一个 volatile 字段都没有的插件**完全无法通过设置页写入**。
29. **`describe()` 是同步的**，返回**数组**（其 JSDoc 写「keyed by unique profile entry ids」，与实现不一致，以实现为准）。行的关键字段：`ns` / `schema` / `value` / `revision` / `writable` / `base` / `user` / `autoGenerate` / `applies`。**没有 `patch` 字段**。
    - 行会被**丢弃**的条件：`schema` 取不到、`entry.fiber` 不存在、`fiber.runtime === null`、`fiber.state !== 2`（ACTIVE），或 `volatileForm(schema) === undefined`。
    - 客户端读当前值：`ctx.configForms.get(ns).getSnapshot()` → `{status, value, base, user, revision, writable, mode}`；跨命名空间用 `ctx.configForms.describe().namespace(ns)`。**首帧可能是 `status: "loading"`**，因为 `ensure()` 是异步的，所以需要 `subscribe()` 后再取。
    - 客户端 `ConfigForms.get(entryId)` / `describe().namespace(ns)` 的 **`ns` 是
      `entry.options.id`，不带 `include:` 前缀**（本插件为 `agent-switchboard`）。
      **实测证据**：本机 20 个 settings 命名空间全部不带前缀（`agent-switchboard`、
      `agent-preset-registry`、`ui-settings` …）。`plugin_manager` 显示的
      `include:agent-switchboard` 是**展示层的组合形式**，不是 `ns`。
      （本条曾写错成「`entryId` 就是 `include:agent-switchboard`」，已据实测修正。）
    - **只有根条目有 settings 行。** `configEditor.entries()`（`dsh-config-editor/lib/index.js`
      第 31 行）先筛 `entry.parent.tree.ctx.fiber.entry?.id === "include"`，再按
      `entry.options.id` 去重。**preset 内的插件声明不在这个集合里**，因此既没有 settings 行、
      也读不到写不到 —— 这是 UI 必须经根条目配置写入的原因（D14 第 1 条）。根配置是设置页的读写桥接面，preset 不携带角色列表；Host 将其同步到角色文件。
30. **`.volatile()` 只能标在数组整体，不能标在数组元素内部。** 这是第 24 条的另一面：数组元素路径经 `schema.inner` → `[...path, '*']` 变成**非固定**路径，客户端 `validateVolatileSchema` 随即抛错。
31. **⚠️ 用 PowerShell 的 `>` 重定向采集探针输出会引入编码损坏 —— 这是本机实测踩到的坑，不是归档的问题。**
    - 实测：`node scripts/dsh-cat.mjs <path> > raw/foo.js` 产出的文件前 4 字节是 `ff fe 77 00`，即 **UTF-16LE**；而用 `execFileSync(..., {encoding:'utf8'})` 或管道（`|`）采集时同一文件是**纯 UTF-8、零 NUL**。
    - 三个文件实测均为 UTF-8 / NUL=0：`dsh-settings/lib/index.js`、`dsh-client-ui-settings/lib/client.js`、`dsh-client-ui-permission-presets/lib/client.js`。
    - 后果很隐蔽：`read` 工具会把被写成 UTF-16 的副本判为二进制而拒读，看起来像「这个文件是二进制」。
    - 做法：采集归档内容时用 `execFileSync` 的 `encoding: 'utf8'` 或管道，**不要用 `>`**。若已用 `>`，检查头两字节是否为 `ff fe`，是则 `buf.toString('utf16le')` 可救回。
    - 教训：这处曾让我把「我的采集方式有问题」误判成「归档里编码不统一」，并据此写出过错误结论。

### 3.1f 客户端可用的远程通道边界（决定「UI 能不能直接改文件」）

32. **客户端可用的远程命名空间是构建期生成的静态清单，外部插件无法新增。**
    - 客户端装配处是一个**硬编码数组**（`dsh-api-remotes/lib/client.js` 第 13512 行起）：
      `for (const contribution of [TYPERT_REMOTE$24, …, TYPERT_REMOTE$22]) disposers.push(await ctx.remote.$mount(contribution))`。
    - `dsh-api-gateway` 的客户端服务注释原文：**「no JavaScript Proxy participates in
      method lookup, invocation, or type exposure」** —— 没有动态代理，`ctx.remote.<ns>`
      只能命中已挂载的 contribution。
    - `remote.$mount(contribution)` 还要求**严格 codec**（构建期产物）：
      `requireStrictInputs` → `if (codec.mode !== "strict") throw … has no strict codec`。
    - **结论：自建远程服务给自家设置页用是不可行的**（本项目曾据此实现，客户端永远调不到）。
33. **实测客户端可用命名空间恰好 29 个**，与「配置读写」相关的只有两个方向：
    - `workspaceFiles` = `read` / `readBytes` / `stat` / `list` / `changes` —— **只读**。
      **客户端没有任何写文件的能力。**
    - `settings` = `describe` / `mutate` / `replace` / `update` —— **唯一的写通道**，写的是
      插件配置（profile patch）。
    - 另有 `settings.openSettingsDocument` 可在 Host 桌面打开配置文件供**原生编辑**。
    - 含义：**「UI 直接编辑那个 JSON 文件」在客户端侧做不到**。可行形态是
      「UI 写插件配置 → Host 侧同步到文件」（Host 才有完整文件能力）。
34. **官方「模型」页的读写分工（照抄它即可）：**
    ```js
    const inject = [ ..., "remote.settings", "remote.session", "configForms", ... ];
    const controller = new ModelsSettingsStore(ctx, schema, ctx.configForms.describe());
    ctx.remote.$on("settings/document-updated", () => { ... });

    async load() {
      await this.describeFace.ensure();                 // 异步补全镜像
      const mirrored = this.describeFace.getSnapshot();
      if (mirrored.view === void 0) … "settings are unavailable in this browser"
      const views = mirrored.view.namespaces;           // ns → view
      const writable = mirrored.view.writable;
    }
    // 写：ctx.remote.settings.mutate(ns, ops, expectedRevision)
    ```
    - **读走 `configForms` 镜像面，写走 `remote.settings.mutate`。**
    - 只用 `remote.settings.describe()` 读是错的路子 —— 实测表现是页面报
      「取不到 remote.settings 通道」。
    - `ensure()` 是**异步**的，**首帧通常还没有自己的行**，必须先 `await` 再取 snapshot，
      并订阅镜像以便补全后自动重读。
    - `SettingsPathOp` 形状（运行时 `Service` provider 权威确认）：
      `{op:'set', path: string[], value}` | `{op:'unset', path: string[]}`；
      `mutate(ns, ops, expectedRevision?) => Promise<void>`，且文档确认
      「unsetting an array index removes its element」。
35. **`inject` 只许声明内核保证存在的依赖。** 判据是**由谁保证它在装载期存在**，不是名字里
    有没有 `remote.`：
    - `slots` / `configForms` / `remote.settings`：内核插件提供，官方页面也这么注入 ✅
    - 自建且延迟注册的服务：客户端会**永远 pending**，整页起不来 ❌
      （实测报错 `web boot: 1 entry did not activate` +
      `pending (waiting for service: remote.roleConfig)`）
36. **两个 profile 层承载点，缺一即「静默不存在」：**
    - `dsh.profile.bundles` **必须含本包**（`dependencies` 里有**不够**）：Loader 只加载
      `bundles` 列出的包。缺失后果是**应用正常启动、但插件完全不存在**，且**没有任何报错**
      （实测踩到：Loader 条目数 187 而非 188，`include:agent-switchboard` 从未创建）。
    - 根条目**必须启用**，bundle 声明不必携带 `config.roles`；设置页读 `configForms`、写根命名空间 `agent-switchboard` 的 `remote.settings.mutate`，Host 根实例将角色同步到 `$DSH_HOME/agent-switchboard/roles.json`。标准 preset 中本包带 `mount: true` 与 `supervisorRules`（D29 修订），**不得再携带 `roles`**；兼容自定义 preset 的本作用域显式角色数组（含 `[]` 清空），启动和热重载均优先于文件，仅 `undefined` 回落文件。新会话继承现有实例，不重新执行 `apply`；根实例通过 `loader/volatile-update` 写盘；已有 preset 不重挂，执行期读取文件。
    - `scripts/check-profile-wiring.mjs` 显式断言根条目未禁用、preset 的 `mount: true`、`selfRow?.config?.roles === undefined`，以及 `supervisorRules` 为非空字符串并与仓库 preset 生成物逐字符一致（找不到默认 profile 时跳过；显式目标缺失则失败）。
37. **禁用/启用插件这个操作本身会重写 profile，且只保留它认识的条目。** 实测两次：一次
    web boot 失败后，profile 的 `cordis.patch.yml` 从 41,802 字节被削到 670 字节，
    `dsh.profile.bundles` 里本包也消失。**含义：修 bug 时不要靠「禁用插件」作为试探手段；
    动它之前先备份 profile。**
38. **平台能力应先读同构先例，再动手。** 本项目在「客户端如何读写配置」上连续失败三次
    （自建远程服务 → 猜 `remote.settings.describe()` → 猜 slot ctx 上的 `remote`），
    而官方「模型」页早已给出正确写法。**第一动作应是读官方实现。**

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
| 派发抽象 | 内置角色沿用 spawn / fork；CLI 角色通过 spawn 包裹后调用专属工具 | D18；第 3 节补充：`subagents` 是具名 provider 注册表 |
| 角色 → 工具 | 自己注册工具，内部调 `ctx.subagents.start()` | 第 3 节第 7 条 |
| 子进程 | `ctx.subprocess.spawn`（argv 数组，无 shell） | `subprocess` 服务契约 |
| 配置 | 角色文件 + 根条目设置桥接；经 `mutate` 编辑的字段必须 `.volatile()` | 第 3 节第 5、36 条 |

## 5. 角色模型（当前实现）

一个角色至少包含：

- `id` / `title` / `description`
- `instructions` — 子代理的角色提示词
- `readOnly` — 是否允许修改文件
- `allowNestedDispatch` — 该角色创建的 DSH 子代理能否调用受控委派工具（**默认 `false`**）；不决定能否被调用，继续派发仍受剩余深度预算约束，见 `decisions.md` D21
- `backend` — `spawn` / `fork`（内置）或 `cli`
- `model` / `effort` — 角色顶层的模型与思考强度
- `cliCommand` / `cliPrefixArgs` / `cliArgs` / `cliPromptDelivery` / `cliCwd` — CLI 角色的扁平配置；归一化后生成内部 `cli` 对象。提示词传递支持 `stdin` / `argv` / `promptFile`；不设置运行期限。旧 `cliTimeoutSec` 不再声明或执行，残留值不阻止加载。

早期草案的 `systemPrompt`、嵌套 `cli.model` / `cli.effort`、`modelFlag` / `effortFlag` 已被当前 schema 与参数模板取代；`resultContract` 尚未成为配置字段，统一结构化结果契约仍是目标。

其中 `model` 与 `effort` 是**角色级固定配置，主代理无权覆盖**（`decisions.md` D12）。`effort` 取值为 `low | medium | high | xhigh | max`，非法值在角色校验时报错，不静默降级；各 CLI 的真实支持范围仍需以实测为准。

## 6. CLI 派发后端（已实现，保留设计约束）

当前 CLI 数据流（批次 3b，D18 / D19）：

```text
主代理 → delegate_to_<角色> → 内置 spawn 子代理
                              → switchboard_cli_run_<角色>（仅 prompt）
                              → runCli → ctx.subprocess.spawn → 外部 codex / grok
                                           ↓ stdout / stderr 增量 sink
                                    ctx.get('jobs') → job.append → 输出环 → 客户端任务面板
主代理 ← 简洁汇报（交付物、证据、错误、未完成项）← 子代理 ← 有界 CLI 结果
```

有效 CLI 角色的专属工具先注册于同一 preset 作用域，再挂载对应 delegate。旧 `switchboard-cli-*`
provider 已移除；历史文件 `src/cli/provider.js` 原位承载 `createCliTool`，没有第二条可执行派发路径。
自检同时查询两个工具，专属工具注册失败会阻止对应 delegate 挂载，任一工具缺失都报告角色不可用。

包裹路由取插件级 `volatile.wrapperProvider` / `wrapperModel` / `wrapperEffort`（D22）。
根实例通过既有 `$DSH_HOME/agent-switchboard/roles.json` 的 `volatile` 同步三字段；不新增服务、文件类型或路径。
根实例在 apply 时同步初值，直接监听 owning Fiber 的 `loader/volatile-update` 同步保存值。载荷是路径数组的数组；Loader 先提交 Volatile 再普通 emit，通过发送侧 `Context.filter` 只投递 owning Fiber。监听器不使用 next、prepend 或 receiver 过滤，也无需额外 effect 包装。
工具骨架只注册一次，官方 `dsh-tool-subagent` 在 execute 内读取 getter；每次派发入口现读 model/effort/instructions/readOnly/maxDepth、权限清单与包裹路由，同次执行的 getter 优先读取派发级快照。提示组装也现读角色与可见工具。
文件 resolver 用 mtimeMs+size 缓存：未变不重读，改变重读；损坏保留上一有效快照并标 stale，无有效缓存拒绝挂载/派发且自检不健康。显式 preset roles（含 []）优先，undefined 才回落文件，source 区分 preset/file。
CLI 工具每次执行先复验当前角色的 driver、模板与 readOnly 兼容性，再复制执行快照；命令通过 `ctx.get('subprocess').resolveExecutable` 执行期解析，spawn 使用 argv 数组与 shell:false。装载自检标记“待执行时解析（尚未验证）”，执行后报告解析结果或本次解析失败，不冒充无 CLI 角色。runner 原有解析失败回落字面命令的行为保留，失败会进入可执行文件诊断。
已开始的内置请求和 CLI 执行保留起始快照；工具返回、Jobs 结算、客户端读取分离，owner 仍为子会话，无主动 remove 或运行期限。实例卸载使用官方插件生命周期，不再管理私有代际或租约。
增删角色/改 id/toolName/backend 仍会改变工具集（阶段 3，未实现）；当前实例拒绝结构变化的派发并明确报告需重新挂载，不能宣称已热更新。Host 源码改动仍需重启一次加载。
有效文件 `maxDepth` 优先，缺失或无效时回落 preset，最后默认 3；根就地更新会同步已有文件的 maxDepth。角色配置、CLI 预设/参数和包裹路由用于后续派发；历史模型上下文、正在执行的子代理/CLI/后台 Job 不被改写。
`switchboard_selftest` 的 `roleRoutes` 报告当前 resolver 每个角色的后端、角色 model/effort、source=preset/file 与 stale；CLI 的角色模型/强度指外部 CLI，包裹路由由独立 getter 提供给派发请求，当前 roleRoutes 不单列包裹 LLM 路由。
文件损坏时继续报告上一有效缓存并标 stale=true，工具不可用时标注未挂载；根实例提示在 Switchboard preset 内查看生效路由。
挂载实例只校验有效路由来源：文件含任一 wrapper 字段即整个路由对象优先（包含显式空值），不逐字段补入 preset；
被覆盖的非法 preset 路由忽略。文件没有任何 wrapper 字段时才回落当前实例配置。
这与角色列表的优先级不同——角色列表是「本作用域**未提供** roles 时才回落读文件；显式空数组表示清空，不得复活文件里的旧角色」，而包裹路由是文件优先：preset 可独立选择角色，不能覆盖已经同步的统一包裹路由。
根字段留空或移除会把已保存的统一设置清为空字符串，避免回落到 preset 的旧值。
包裹同步以 `{ ...existing, volatile }` 写回，并保留 volatile 中其它字段；roles 与顶层其它字段均保留，不是整份配置替换。
文件缺失且根含任一合法包裹字段时创建 `{ formatVersion: 1, roles: [], volatile }` 桥接文件（三个 wrapper 字段均写入）；空角色不表示已播种，迁移脚本仍将缺文件或空 roles 视为需播种并保留现有字段。成功创建清除 pending；根没有任何包裹字段时不创建空桥接文件，首次安装缺文件是正常健康空状态。
若创建因权限、锁定或 IO 失败，preset 无法从自身上下文得知根设置存在，仍可能回落自身路由；根自检必须以同步错误及 pending 判为不健康，不得宣称根设置已生效。pending 仅表示根有待桥接设置而文件尚未成功建立，并独立进入 `ok` 门禁。
包裹同步失败进入当前配置错误诊断并去重，相同失败不重复打印日志，失败内容变化时打印；恢复同步即清除旧错误。
仅 CLI 角色把非空 provider / model / effort 映射为 agentOptions.provider / model / reasoningEffort；
三者全空完全不设 `agentOptions`，空白字段直接省略，遵循宿主的路由继承规则，不保证无条件继承父强度。
留空时不指定思考强度：包裹子代理最终使用的 Provider 和模型均与父代理一致时，沿用父代理当前强度；否则按目标模型的默认设置处理。父代理未指定强度时，也按模型默认设置处理。
「父代理当前强度」指最近一次请求配置；尚无请求时取创建配置。已有请求配置但无 effort 时，不恢复创建时的 effort。
`resolveChildAgentOptions` 精确比较 provider / model 标识；显式填写与父相同的两项不算切换，仅改其中一项也算切换，别名不会按指向的模型等价处理。
`dsh-tool-subagent` 预检采用同一原则，但在有 `subagentProvider.agentRouteDefaults` 时合入该默认路由并关闭预检的父强度继承；本机内置 spawn 是否声明该属性未核实。
模型默认设置是默认处理，不保证非空强度：LLM 层用 `requested ?? reasoning.defaultEffort`，模型没有默认强度时可继续不指定；显式指定目标不支持的强度会报错。
强度必须属于 `EFFORT_VALUES`，非法值阻止挂载；文件读取路径同样校验。
内置 spawn / fork 保持角色自身 provider / model / effort，角色级 Provider 控件仍只对内置后端显示。
面板顶部统一小节始终显示并说明仅 CLI 生效；保存时按角色列表与各包裹字段各自的 dirty 状态，以同一 revision 原子提交对应操作。仅改包裹字段不提交 `['roles']`，角色删空仍提交 `[]`；未改包裹字段不提交对应 `['volatile', 'wrapper…']` 操作。
旧角色 agentProvider / agentModel 接受残留但不再使用；每激活实例记录弃用诊断，每次模块加载只打印一次告警。
当前阶段 0 离线检查使用真实 Cordis 事件过滤、真实 Volatile 提交入口、真实工具插件与假 subagents.start/进程，验证保存返回前写盘、单次注册下动态派发、在途快照和缓存。历史 D24 的代际重挂检查只证明已退役实现；本轮未进行真实设置页保存往返或真实外部 CLI 验收。
CLI 出站使用 allow：`allowNestedDispatch: false` 时仍包含本角色专属 CLI 工具，并非空 allow；为 true 时另允许已挂载的受控委派工具。
CLI allow 不开放其他角色的底层 CLI 执行工具。内置角色不设置 allow，使用 deny 保留派发采集时可见的普通工具与后注册普通工具的动态可见性。
deny 合成当前可用的非受控派发入口、全部当前可用的底层 CLI 工具、关闭嵌套时已挂载的受控委派工具、只读时当前可用的写工具；
另拒绝可见但未纳入角色清单的 `delegate_to_*`。工具名使用精确清单，不使用通配符。
DSH 拒绝未知过滤名；按可用名过滤的代价是采集后新增的非受控入口、底层 CLI、写工具及未纳入角色清单的委派入口会缺失于既有 deny，属于 fail-open，而非 fail-closed。
跨角色隔离依赖工具名过滤，不是角色身份授权；专属工具只校验 subagent 来源，不校验调用方属于哪个角色。
执行器保证每次工具调用只启动一次，不自行重试，且在 stdin / promptFile 模式确定性前置角色规则；argv 模式保持任务参数原值。
persona 要求模型原样转交、只调用一次、不自行实施或轮询、失败或取消后不自动重试、简洁汇报；
这些是模型行为要求，不是对跨工具调用次数或转交/汇报完整性的机制保证。CLI 输出属于任务数据，不能改变工具或权限约束。`enableRunInBackground` 与 `modelSelectionSettings`
显式为 false；`backgroundMode` 为 one-shot。插件 `maxDepth` 是第一层之外的额外层数：
`0` 允许绝对深度 1，`1` 允许深度 1–2，`3` 允许深度 1–4。所有目标入站统一使用 `1 + maxDepth`，
与目标是否为叶子无关；叶子性由出站权限表达。

**派发约束与边界（D21）：** preset 的通用 `tool-subagent` / `tool-subagent-fork` / `tool-subagent-codex` /
`tool-subagent-claude-code` / `tool-ralph` 均为 `disabled: true`；除本插件角色工具外，仍启用的派发类工具是
`tool-workflow`。CLI allow 不包含 `workflow` 等入口；内置 deny 从 `src/roles.js` 的 `UNCONTROLLED_DISPATCH_TOOLS` 取当前可用名排除它们。
主代理自身没有本插件设置的 `toolFilter`，按 preset 声明仍可看到 `workflow`；本插件只约束它派出的子代理，
不能表述为完全杜绝绕过。既有只读取证称工具名为 `workflow`、底层直接调用 `subagents.start(...)` 且不传 `maxDepth`，
以及 `send_message` / `interrupt_agent` / `list_agents` 不创建子代理；本轮这些模块未安装、安装归档被沙箱拒读，
未独立复核这两项源码结论。已安装 `dsh-subagent` 的 `start` 不回落服务默认深度，直接传递请求给 provider；
因此直接调用而省略 `maxDepth` 的路径不能依靠服务默认预算。`workflow` 保守地保持排除，真实行为仍需现场复核。

**离线覆盖边界：** `scripts/check-apply.mjs` 是契约模拟，即使真实 Config 与工具插件执行，
`subagents.start` 仍是调用真实 `resolveChildDepth` 后记录请求的桩，不创建 spawn child。请求中的 allow / deny / persona / maxDepth 有断言，
深度夹具经真实 `delegationDepthOf` 验证，并覆盖预算 0/1/3。另以真实 Cordis + ToolRuntime + `applyChildComposition` 验证 child 工具过滤、
后注册普通工具动态可见、跨角色 CLI 隔离与可用名过滤的 fail-open；真实 spawn 的上下文隔离、preset 工具继承及完整派发链没有集成覆盖，需真机验证（D21）。

专属工具 `execute` 安全访问 `exec.agent.session.header.origin`，仅接受 subagent 来源；主代理虽然能看到
preset 工具，直接调用仍被拒绝。命令、模板、cwd、readOnly、外部 model / effort、限额与角色 instructions
在注册时绑定快照；任务参数不能覆盖。角色规则由 runner 确定性前置到当前 codex 的 stdin / grok 的提示词文件。

工具只等待 CLI 结束并返回 status、exitCode / signal、cancelled、routeSummary（配置线路与 CLI 自报事实）、
stdout、stderr 尾部、diagnostic 及各自截断标记。正文与错误按配置字节限额，摘要与诊断各最多 4096 字节；
不回传 argv 或完整实时日志；新增 `outputFeedback` 为 `jobs` 或 `unavailable`。

### 6.1 CLI 实时输出回流（批次 3b）

专属工具在执行时读取 `ctx.get('jobs')`，不把可选服务加入 inject。以 `kind: 'cli'`、
`label: role.title || role.id`、`owner: exec.agent.id` 注册任务，使用 runner 的增量 sink
向 `job.append(text, { channel, gapBefore? })` 推送，未注册 pull-source，避免双重输出。
runner 每 50ms 读取非消费型收集器，成功和失败都排空尾部；丢失字节标记 gapBefore。
收集器仍受 CLI 输出限额，Jobs 输出环仍受其自身保留容量限制，不能保证无限保留所有日志。
`outputLimitBytes: 4096` 只约束 Jobs 模型侧读取/终态通知，不限制客户端观察者。

调用方 `exec.signal`、面板 cancel 及 owner 销毁均进入同步幂等的 cancel，汇入同一个
AbortController 后传给 spawn。JobHooks.done 映射 completed / killed / failed，不携带日志 result，
不拒绝。runner 在成功路径也调用 waitForExit 确认受管范围；失败路径分别尝试 terminate 与 waitForExit，
前者抛错不跳过后者。退出确认后再次排空输出，尝试删除提示词文件并清理轮询与监听器，再统一形成结果。
退出未确认、终止请求失败或提示词可能残留均进入有界诊断，不暴露提示词内容；JobHooks.done 如实 resolve failed，
不挂起、不声称已完全释放，进程状态仍单独保留。意外执行器拒绝也映射 failed 并报告未能确认受管范围已清空。
共享执行完成 Promise 先清理调用方 abort 监听器，再派生 JobHooks.done。执行器完成、Jobs 结算、客户端读完是
三个独立完成点；工具只等执行器，不订阅 settled，也不以 Jobs 结算或客户端读取为返回前提（D20）。
成功、失败、取消均不主动 remove，记录交由 Jobs 的保留策略处理（未核实），不改 owner、不延时删除。

本地 `dsh-jobs/lib/types/index.d.ts` 的 wait 签名为
`wait(id, timeoutMs: number, caller?, signal?)`，文档要求正数且有限的等待界限；插件不调用它，
没有 CLI 运行期限。缺少 Jobs 或注册预检失败时照常执行，结果如实标注不可用，不重复启动。

模型上下文边界：JobHandle.append 契约仅写输出环、发布输出事件，观察者通过绝对偏移读取；
本插件不调用 Jobs 的模型读取 API，不调用 AI、session.append 或附加上下文 API。
专属工具 execute 持续等待，DSH tools 的 dispatchToolBody 在 await tool.execute 后才构造工具结果。
jobId 由 Jobs 管理，schema、返回值与 render 均不暴露它；客户端通过通知中的 id 与偏移读取输出环。
平台终态通知属于 Jobs controller 的职责；无 jobs.wait 时 settled 的 awaited 为 false，
平台可能在结束/报错时另发有界完成通知，该行为与任务面板的子会话可见性仍需真机核验。
离线验证使用假 Jobs 与 Node 假 CLI 真进程；未调用真实 codex / grok。

### 6.2 CLI 实时输出在一次性子会话输入区的呈现（用户要求）

**状态：客户端与离线断言已实现，待真机验收。** 用户要求在一次性子代理侧边栏输入区上方，持续观察本子会话的 CLI 输出，不等 `turn/end`，也不把实时日志写入模型上下文或历史记录。

**接入方向：** 在 `conversation.composer` 注册独立 `id: 'agent-switchboard-cli-observer'`、`priority: -20` 的只读观察者，仅选择一次性子会话；选择条件为宿主投影 `session.subagent.address.mode === 'one-shot'`（与官方选择器一致）；投影没有稳定的 Switchboard CLI 角色标签，故所有其它一次性子会话也必须忠实复现官方文案、布局与 `role="status"`，无 CLI 任务时面板返回 null。通过 `remote.$stream` 消费 `remote.job.list` / `remote.job.follow` 读取本子会话、`kind: 'cli'` 的任务，呈现有界实时文本面板，并始终忠实保留官方一次性子智能体记录文案。没有 CLI 任务或回流不可用时也保留文案，不提供输入能力或取消任务入口。

**不采用的入口与原因：**

| 入口 | 否定结论 |
| --- | --- |
| 顶部任务列表 | 子代理侧边栏没有 header，不能靠顶部列表呈现本子会话任务。 |
| `turnTail` | 只能在 `turn/end` 后出现，不能满足运行中观察；历史 turn 会重复呈现 footer。 |
| `conversation.composer.dock` | 被一次性子会话的只读 composer chain 隐藏，注入 dock 不会显示。 |
| `conversation.content` / `sidebar.chat.conversation` | 前者是 Component Factory 不是 list；后者是 single，替换整个侧边栏内容区过于侵入。 |
| transcript 外追加 / 工具进度 | `Session.append` 强制校验且只允许五类标准事件；没有 `tool/progress`，`ToolRunContext` 仅有 `deferContext` / `concludeTurn`，不伪造历史记录或逐块工具结果。 |

**chain 的取舍：** `conversation.composer` 不能并列追加观察者，只能由更低 priority 的贡献取代官方静态占位。因此使用独立 id，不复用官方 id；替代视图必须保留官方文案与只读语义，不恢复输入能力。代价是需要维护占位文案及宿主 chain 兼容性，不能将离线检查通过等同于真实侧边栏视觉验收。

**隔离与生命周期：** 只观察 owner 为当前子会话的 CLI 任务，不合并父会话或兄弟子会话日志，不改任务 owner。切换子会话或卸载时释放观察订阅、监听与本地缓冲，丢失或截断明确标记；观察者清理不取消、删除任务，也不等待客户端读完来结算执行器。既有调用方停止、Jobs 取消、owner 销毁及执行器资源清理保持不变（D20）。不把 owner 改为根会话（会改变访问围栏、取消与保留语义），也不省略 owner（会开放给全部 caller，并延迟清理至服务销毁）。元数据和流协议已源码核实；运行中呈现、切换隔离及卸载仍须真机核验，不能以离线桩代替验收。

**订阅与降级：** 设置页与只读席位保持父插件原有依赖；`ctx.inject(['remote', 'remote.job'], ...)` 在独立子作用域提前捕获 gateway/job face，避免异步重连在 React 调用栈重新解析命名空间。服务缺失只显示「CLI 实时输出暂不可用」，不阻断父插件；服务恢复/撤销驱动观察重启/释放。list/follow 采用 `$stream`，接受 rows/opened 锚点，游标仅原样保存 Host 的 from/next；carrier 中断显式提示，已接受锚点后的意外 EOF 使用公开 restart 立即重订阅，不导入 Harness Client 包；此 EOF 分支不含退避，真实 carrier 异常仍由 `$stream` 原有重试机制处理。订阅终端错误必须显式呈现，不能当成无任务。

**有界呈现：** 最多观察 8 个任务（运行中优先，其次最新结算），每个任务保留 32 Ki UTF-16 字符、256 个通道片段；正文使用文本节点，不解析 HTML/ANSI。运行中默认展开，结算后仍可展开尾部。输出默认自动滚到底；用户上滚后暂停，回到底部或点击「滚动到最下」恢复；每个任务独立维护状态。Host lossy、chunk gapBefore、已有历史缺口与客户端裁切均明确提示；超出任务数也有提示。没有刷新定时器或 CLI 运行时长限制，也没有取消按钮。

调用外部 CLI 至少要考虑：

1. **调用形态**：多数 CLI 支持一次性（print/exec）与非交互会话两种模式，需要确认各自的实际参数。
2. **提示词传递**：已支持命令行参数、stdin 与临时提示词文件；当前 grok 驱动用 `promptFile`，避免多行提示词进入 argv。
3. **工作目录与沙箱**：外部 CLI 自己的沙箱与权限需要单独配置，不能假设它与 DSH 的沙箱一致。`codex` 有独立的 `-s/--sandbox` 与审批策略，必须由用户显式声明，不可与 DSH 的沙箱策略混为一谈。
4. **输出解析**：是否支持结构化输出（如 JSON），不支持时如何从文本里稳定提取结果。
5. **模型与思考强度**：三者 flag 形态完全不同（`codex` 走未文档化的 `-c model_reasoning_effort=`、`claude` 走 `--effort`、`grok` 走 `--reasoning-effort`），且可用档位随模型变化。由本插件的 `model` / `effort` 结构化字段映射，见 `decisions.md` D12。
6. **手动中断**：长任务由调用方取消；子进程被杀后残留状态如何处理。
7. **失败语义**：命令不存在、未登录、额度耗尽、非零退出码，分别如何上报给主代理与用户。
8. **安全**：命令与参数必须来自用户配置，不能由模型自由拼装，否则等于开放任意命令执行。

> 第 8 点是硬性要求：**参数模板由用户提供，模型只能填充受限的占位符（如 `{prompt}`、`{cwd}`、`{model}`、`{effort}`），绝不允许模型自己生成可执行文件名或自由拼接 shell 命令。** 占位符替换始终发生在**单个 argv 元素内部**，替换结果不参与任何字符串拼接。

## 7. 可观测性

当前角色路由在派发前注入提示词；CLI 有界结果留在包裹子代理上下文，由该子代理汇报证据与状态。历史原始日志回传见下节。统一记录任务标识、起止时间与结果摘要仍是观测目标。

### 7.1 「调度日志进主代理可见输出」的现状（已实现，含一处固有限制）

**主代理调度规则（D29）：** preset 装载时另注册 `agent-switchboard:scheduling`（order 10510），与角色清单小节共用 `isMainAgentContext` 身份判据。每次组装按可靠的会话头与深度标记动态读取本 preset 实例的 `config.supervisorRules`（兼容 getter 与普通字符串）或返回空串；规则源于对临时素材的适配，正式运行不读取 `raw/AGENTS.md`。规则仅由 `scripts/gen-preset.mjs` 的 `selfEntry` 写入 `switchboard-roles.config.supervisorRules`，运行时代码无完整副本；Config 声明字符串、无默认值、非 volatile，根条目不携带，客户端不提供编辑控件。只进入主代理，子代理只拿自身 persona，未知身份不输出。内容保留四问路由、最小充分任务包、阻塞派发生命周期、失败路由、上下文卫生、成本纪律与 reviewer 独立性；主代理的小文件/少量代码权限保留但限定为极小局部工作，宽重读取与实现必须委派。

生效链路为 `npm run gen:preset` → `npm run inject:preset` → 重启 DSH；profile 内联展开，多 profile 需分别同步。不得手改 YAML，生成器会全量覆盖。缺失、空串或仅空白时不注入、不回退；自检显示“调度规则：未配置（profile 可能未同步 preset：需 gen:preset → inject:preset → 重启）”，`warnings` 非空、`health` 为“可用但告警”，`ok` 仍仅由既有配置/挂载错误决定，不阻断派发。根实例提示在 Switchboard preset 中自检，不因根条目无此字段告警。

正式小节取代过去依靠触碰 `raw/*` 偶然获得调度规则的状态，但不拦截官方工作区指令插件的子目录注入：触碰该临时区仍可能把未适配素材带入子代理。R01–R14 通过真实 SystemPrompt 组装与静态断言验证主代理包含、三种子代理标记及未知上下文排除、无过时标识、preset 载体不可编辑、缺省不注入但告警以及生成逻辑字节幂等；生产代码变异验证判别力，恢复后校验 SHA-256。离线通过不等于真实会话验收，未调用外部 CLI 或修改用户 DSH 配置。

**决策前可见** —— `roleGuidanceText()` 注入系统提示词，每个角色那两行现在带**线路摘要**
（`routeSummaryFor()`）：

```text
  `delegate_to_worker` · may delegate further · backend=cli(codex) model=gpt-6.1-sol effort=high
  `delegate_to_architect` · read-only · cannot delegate further · backend=spawn model=gpt-6-astra effort=medium
```

⚠️ **为什么必须放进提示词**：工具描述里虽然也有一句「后端：cli」，但那要**调用时**才进入
上下文；主代理在**选择**派给谁的时候看不到任何线路信息。这个不对称是跨 CLI 端到端实验
暴露的。只放线路与模型这类路由事实，**不放 `instructions` 正文**（有回归断言守住，
它是 persona 的内容，放进来会显著抬高主代理的上下文成本）。

`cliLabelOf()` 只对**能确定**的 CLI 给出名字（`grok`；`node` + `codex.js` → `codex`），
推断不出时只显示 `backend=cli` —— **宁可不说，也不要显示可能错的线路名**。
（实测踩到：`{node}` 被解析成绝对路径后，整串匹配失败，曾把 worker 显示成 `cli(node)`。）

**历史决策后可见（3a 前）** —— CLI 路径的 `[switchboard]` 日志是**回传内容的一部分**
（`formatRunResult()` → `output[0].text`），因此主代理确实看得到，不是只进日志：

```text
[switchboard] role=worker backend=cli command=…\node.EXE
[switchboard] 线路=backend=cli(codex) model=gpt-6.1-sol effort=high   ← 与提示词同一套措辞
[switchboard] argv=[…]                                               ← 证明无 shell、参数可审计
[switchboard] exit=0 duration=28.6s
[switchboard] cli-route {"model":"gpt-6.1-sol",…}                    ← CLI **自报**的生效路由
```

`线路=` 与提示词里的摘要**同源同措辞**，主代理可直接对照「本该走哪条」与「实际走了哪条」。

**固有限制：内置后端（`spawn` / `fork`）没有等价的返回日志。**
`dsh-tool-subagent` 回传时是 `output: result.output`（原样透传子代理输出），
本插件**没有可注入的位置**。因此内置角色只能靠「提示词里写明了它走 `backend=spawn`」
来知情，拿不到 `model` 是否真的生效这种自报事实 —— 那是 CLI 特有的能力
（只有 codex 会把路由打印到 stderr）。

设计取舍：**不为了形式上的对称去伪造一条内置后端日志**。宁可如实说明这条不对称，
也不输出无法验证的「看起来在汇报」的行。

### CLI 执行器与取消（批次 2a）

`src/cli/runner.js` 的 `runCli({ role, prompt, spawn, resolveExecutable?, signal?, routeSummary?, onOutput?, now? })`
负责模板、提示词传递、进程等待、输出与路由解析，以及所有终态的清理。
批次 2a 时 `provider.js` 转换 ContentBlock 与包装 SubagentRun；批次 3a 已改为专属工具定义。`onOutput({ stream, text, lossy })`
可接异步 sink，通过非消费型收集器增量读取；批次 3b 的专属工具将其接入 Jobs 输出环。
输出 sink 失败记诊断；采集容量仍由 subprocess 与执行器限制，截断显式标记。

旧 provider 曾将 `request.signal` 原样传入 spawn；当前专属工具合并 `exec.signal` 与 Jobs cancel 后传入 spawn。
已取消信号不启动进程，解析期间取消也在启动前拦截。
`done` 被观察到时固定终态；此前取消优先，之后取消不能改写完成结果。
执行器只返回一个 Promise 终态，并在 finally 清理监听器、回流轮询及提示词文件；
`done` 拒绝时也执行终止与等待。分类区分 `start-failed` / `process-failed` / `cancelled`，
旧 provider 曾将取消映射为 `stopReason: 'aborted'`；当前专属工具返回 `status: 'cancelled'` 与 `cancelled: true`，不再报 timeout。

旧配置兼容：schemastery 非 strict 对象保留未知字段；空 volatile 容器可取回旧值，
`readConfigFile` 不拒绝额外字段。弃用日志每次模块加载最多一次，相关实例自检保留提示，
不进入配置错误或健康门禁。真实 Config 与隔离 DSH_HOME 的 apply 路径已有离线断言。

现有停止链的源码依据：本地 `dsh-agent/lib/index.js` 的 `workspace/session-stop`
调用 `agent.cancel({ kind: 'user' })`；`dsh-tool-subagent/lib/index.js` 的前台派发
把 `exec.signal` 传给 `subagents.start`。假进程验证取消能终止并清理；
DSH GUI 的完整按钮链与 codex/grok 进程树清理仍需真机验收，本批次不新增 UI。

## 当前机制说明（D25）

现行数据流是：根条目提交 Volatile -> owning Fiber 收到 `loader/volatile-update` -> 原子写入 `roles.json` -> 静态工具在下一次执行时通过 mtime/size resolver 读取。`internal/update`、generation、租约、影子服务、跨作用域广播和 `ctx.root.fiber` 归属均为历史失败路径，不是当前机制。Host 源码改动仍需重启一次加载。

**派发级快照（D27）：** preset 作用域注册公开 `tools/execute` around-dispatch hook；角色插件独立的 tools 服务视图在实际 register 时收集定义对象，hook 用调用代理 scope 下实际可见的定义对象与本实例 WeakSet 比对，仅拦本实例角色委派工具，包括 provider 延迟出现或重注册。同名的其他工具和底层 CLI 执行工具不拦截。进入 hook 时同步调用 resolver，并捕获完整角色、maxDepth、wrapperRoute 与可见/受控委派工具清单，以 `AsyncLocalStorage.run(snapshot, next)` 包裹主体。getter 优先读 ALS，取不到时回落现读；并发执行各有上下文。Cordis Config 校验会物化 getter，因此官方 apply 保留原 liveConfig，而不是使用校验产物的启动快照。

**如实边界：** 冻结点是 `tools/execute` 入口（路由预检之前），不包含模型生成工具调用的时刻。CLI 角色只保证委派阶段的包裹请求同快照；真正执行在 `src/cli/provider.js` 的 execute 中另行捕获当前角色，不能保证整个“委派 → 包裹 LLM → CLI 进程”跨两个生命周期绝对同配置。直接调用裸工具 `.execute()` 会跳过 runtime hook；离线派发快照判据必须经真实 ToolRuntime。文件仍按 mtime+size 缓存，未加强相同时间戳和大小的外部写入检测，也不改权限模型或 CLI 无运行时间上限语义。

**调度指引仅主代理（D28）：** 已安装包的 `assembleContextFor` 传入 `{ agent, scope: agent }`，section text provider 接收原 assembly context。仅在可靠代理上下文存在、会话头 origin 不是 subagent、持久化 delegationDepth 与运行时 options.subagentDepth 都为零（缺省为零）时输出调度指引。子代理与身份未知的组装返回空串，子代理保留自身 persona；继承 preset 不会再被告知“You are the switchboard”。依据为本地包源码与真实 SystemPrompt 组装测试；本轮无可用 cordis_inspect_query，未宣称实时接口查询或真机验收。


### 角色设置页的卡片交互（D26）

客户端使用手写 `h()` 模仿官方 `@deepseek-ai/dsh-client-ui-settings-models/lib/client.js` 的 `rows / rowCard / rowHead / rowIdentity / rowActions / addBlock` 结构。每角色折叠卡片头显示标题与 id、内置 spawn/fork 或外部 codex/grok 的机制徽标、模型/只读/允许再派发徽标；8×8 实心状态圆点使用 `--dsw-alias-state-success-primary` / `--dsw-alias-state-error-primary`，并用 aria-label 说明配置有效或错误原因。它判断配置完整性、重复 id 与 CLI 预设识别，不判断本机 CLI 是否可运行。

`SwitchboardSettings` 持有唯一 `editingId` 和读取 revision，`RoleCard` 持有本卡片 `draftRole` 与删除确认状态，`RoleRow` 保留原字段控件及 readOnly 切换的原子预设同步。卡片 key 随展开状态变化，取消、收起或切换焦点会重新挂载并丢弃旧草稿；保存构造完整角色候选数组，调用原有 validateRoles 与预设识别校验，失败在卡片内显示红色 alert。成功经原 `makeRoleStore` 写入通道一次 mutate，携带 revision；远端失败保留编辑器及草稿。新增位于列表底部，显式保存才入列；删除先原位确认，第二步才提交。包裹小节始终位于列表前，仍逐字段 dirty 提交，wrapper-only 不写 roles。

官方也是自绘：平台自动表单只支持标量字段，configForms.describe 仅作为只读镜像。外部客户端插件禁止引入 Harness Client 包（包括官方 UI primitives 的 Modal/Button），以免版本变化或包缺失让 slot 白屏；本页不 import 官方 UI 包，不引入依赖或定时器，采用原生 button（type=button、aria-expanded）和卡片内两步确认替代 Modal。该改版已完成离线渲染取树、真实回调与变异验证；真实 GUI 观感、焦点体验与设置往返仍待真机验收，不改变 Host、权限、任务生命周期或延迟解析架构。
