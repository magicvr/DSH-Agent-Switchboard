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

> 参考位置（**仅存在于安装归档内，不是本仓库文件**）：内置 Skill `dsh-agent-preset/skills/cordis-plugin-development/`，含 `SKILL.md`、`references/*.md` 与 `templates/{decoration,mcp}/` 六个模板文件。官方**没有** `create-dsh-plugin` 脚手架，也没有示例插件仓库。
>
> 另有一项尚未本地核实：TS 基座 `tsconfig.base.json` / `tsconfig.base.client.json` **不随安装分发**，外部作者需要去上游仓库取（上游地址 `github.com/deepseek-ai/deepseek-harness`，取自各包 `repository` 字段，**本仓库尚未联网确认**）。

## 4. 待定的关键决策

这些问题决定了实现形态，需要先有结论再写代码：

| # | 决策点 | 备选 | 倾向 |
| --- | --- | --- | --- |
| D1 | 插件半边划分 | 纯 Host 半边 / Host + Client 两半边 | 已基本确定：必须是 dual-face。调度逻辑在 Host，角色配置面板在 Client |
| D2 | 派发后端抽象边界 | 统一接口 + 适配器 / 每个后端各写一套 | 待定。至少要能表达「一次性任务」与「可续聊会话」两种形态 |
| D3 | 结果回传格式 | 自由文本 / 结构化契约 | 待定。倾向结构化契约，否则主代理汇总会退化成读长文 |
| D4 | 主代理限制手段 | 工具白名单 / 提示词约束 / 沙箱权限 | 待定。可用手段已明确：`tools.guard()`（同步拒绝）、`tools.restrict()`（隐藏工具） |
| D5 | 并发与预算 | 串行 / 有限并发 / 不限 | 待定。需要单次派发超时与总量上限 |
| D6 | 配置存储 | DSH 插件 Config（schemastery）/ 独立配置文件 | 倾向 DSH 插件 Config，但**必须给需要 GUI 编辑的字段加 `.volatile()`**，否则面板改不动 |
| D7 | 语言与工具链 | 纯 JS / TS + 自选打包器 | 待定。纯 JS 零构建、上手最快；TS 需要自己保证 `__ModuleLoader__.load` 产物格式 |
| D8 | 跨 CLI 后端子进程如何落地 | 直接子进程 / 复用 DSH 子进程设施 | 待定。DSH 侧存在 `dsh-subprocess-local` 包，是否可复用需先确认 |

## 5. 角色模型（草案）

一个角色至少包含：

- `id` / `title` / `description`
- `systemPrompt` — 子代理的角色提示词
- `readOnly` — 是否允许修改文件
- `allowNestedDispatch` — 是否允许该子代理再往下派发（防无限递归）
- `backend` — `builtin` 或 `cli`
- `cli` — 当 `backend` 为 `cli` 时的可执行文件、参数模板、工作目录、超时
- `resultContract` — 期望的回传结构

## 6. CLI 派发后端（草案）

调用外部 CLI 至少要考虑：

1. **调用形态**：多数 CLI 支持一次性（print/exec）与非交互会话两种模式，需要确认各自的实际参数。
2. **提示词传递**：走命令行参数还是 stdin；参数长度上限。
3. **工作目录与沙箱**：外部 CLI 自己的沙箱与权限需要单独配置，不能假设它与 DSH 的沙箱一致。
4. **输出解析**：是否支持结构化输出（如 JSON），不支持时如何从文本里稳定提取结果。
5. **超时与中断**：长任务如何取消；子进程被杀后残留状态如何处理。
6. **失败语义**：命令不存在、未登录、额度耗尽、非零退出码，分别如何上报给主代理与用户。
7. **安全**：命令与参数必须来自用户配置，不能由模型自由拼装，否则等于开放任意命令执行。

> 第 7 点是硬性要求：**参数模板由用户提供，模型只能填充受限的占位符（如 `{prompt}`、`{cwd}`），绝不允许模型自己生成可执行文件名或自由拼接 shell 命令。**

## 7. 可观测性

每次派发记录：任务标识、角色、后端线路、起止时间、退出状态、结果摘要。用途是让你能回答「这件事到底是谁做的、花了多久、成功没有」。
