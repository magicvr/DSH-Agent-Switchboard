/**
 * Agent Switchboard 的 Host 半边。
 *
 * 职责：把「角色」变成主代理可用的委派工具。
 *
 * 设计要点（依据见 docs/decisions.md）：
 *   - 角色写在**本插件的 Config** 里，`apply` 时逐个挂载 `dsh-tool-subagent` 实例。
 *     这样增删角色只需改配置 + 重新启用，不必改 profile 的 patch 文件。
 *   - 角色级固定 model / effort（D12），主代理无权覆盖。
 *   - `readOnly` 通过 `toolFilter.deny` 落地——这是**工具级**约束而非沙箱级，
 *     因为 `SubagentStartRequest` 没有沙箱字段（已核实）。
 *
 * ⚠️ 装载期诊断刻意做得很详细：Host 半边在 link 安装下不能热加载
 * （docs/architecture.md 3.3），每次排错都要重启 dsh，所以必须在**一次**
 * 激活里把「哪个角色失败、为什么」全部报出来。
 *
 * ⚠️ schema 是两层的（architecture.md 3.1 第 12 条）：`output.schema` 用
 * value schema DSL（属性级 `required: true`），不要手写对象级 `required` 数组。
 *
 * @module @magicvr/dsh-agent-switchboard
 */
import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import {
  CLI_BACKEND,
  EFFORT_VALUES,
  cliProviderName,
  normalizeRoles,
  planCliMounts,
  roleGuidanceText,
  toolConfigFor,
} from './roles.js';
import { createCliProvider } from './cli/provider.js';

/** Loader 条目名，与 package.json 的 `name` 保持一致。 */
export const name = 'agent-switchboard';

/**
 * 读取 `volatile` 子对象的实际取值。
 *
 * ⚠️ **这是一个踩过的真坑**：调用 `.volatile()` 后，schemastery 把该子对象变成
 * 一个**引用对象**（Volatile ref），其属性**不在对象自身上** ——
 *   - `JSON.stringify(resolved.volatile)` → `{}`
 *   - `resolved.volatile.allowCrossCli`   → `undefined`（恒为 undefined）
 *   - `resolved.volatile.get()`           → `{ allowCrossCli: true, cliTimeoutSec: 900 }`
 *
 * 因此 `resolved.volatile?.allowCrossCli === true` 这种直接访问**永远**判定为
 * 未开启。实测后果：跨 CLI 派发开关从未真正生效过，而自检一直显示
 * 「allowCrossCli 未开启」，看起来与「默认关闭」的表现完全相同，所以长期未被发现 ——
 * 直到在 preset 里显式写入 `volatile.allowCrossCli: true` 仍不生效才暴露。
 *
 * 这里对两种形态都兼容：带 `.get()` 的引用对象，以及普通对象
 * （Loader 经 JSON Schema 投影后可能给出后者）。拿不到就返回 `{}`。
 *
 * @param {object} resolved - 已校验的插件配置。
 * @returns {object} volatile 字段的普通对象视图。
 */
export function readVolatile(resolved) {
  const value = readVolatileField(resolved, 'volatile');
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

/**
 * 读取一个**被 `.volatile()` 标记过**的字段的实际取值。
 *
 * ⚠️ 这是本插件反复踩到、且症状极隐蔽的一个坑，务必用它而不是直接读属性：
 *
 *   ```js
 *   const r = Config({ roles: [...] });   // roles 标了 .volatile()
 *   typeof r.roles        // 'object'
 *   Array.isArray(r.roles) // false   ← 不是数组！
 *   JSON.stringify(r.roles) // '{}'   ← 看着像空对象
 *   r.roles.get()          // 真正的数组
 *   ```
 *
 * `schemastery` 的 `.volatile()` 把该字段换成**引用对象**（Volatile ref），
 * 属性不在自身上，必须调用 `.get()`。直接读会得到一个「看起来是空对象」的东西。
 *
 * 本插件在三处栽过同一个坑，症状各不相同，这也是它危险的原因：
 *   1. `volatile.allowCrossCli === true` 恒为 false → 跨 CLI 开关从未真正生效；
 *   2. `roles` 标 volatile 后，`Array.isArray(resolved.roles)` 为 false
 *      → 报「roles 必须是数组」，4 个角色全部不挂载；
 *   3. preset 作用域探测读到假信号。
 *
 * 因此封装成通用读取：对带 `.get()` 的引用对象与普通值都兼容
 * （Loader 经 JSON Schema 投影后可能给出普通值）。拿不到就返回 `undefined`，
 * 由调用方决定默认值 —— 不要把「读不到」和「值是空」混为一谈。
 *
 * @param {object} resolved - 已校验的插件配置。
 * @param {string} key - 字段名。
 * @returns {unknown} 该字段的实际取值，或 undefined。
 */
export function readVolatileField(resolved, key) {
  const raw = resolved?.[key];
  if (raw === null || raw === undefined) return undefined;
  if (typeof raw.get === 'function') {
    try {
      return raw.get();
    } catch {
      // 引用对象取值失败不应让插件装载失败 —— 当作未提供处理。
      return undefined;
    }
  }
  return raw;
}

/**
 * 声明式依赖。Cordis 会等到这些 Service 就绪后再调用 `apply`。
 * - `subagents`：注册 CLI provider，并解析内置后端。
 * - `agents`：取发起本次调用的父代理（在被挂载的工具内部使用）。
 * - `systemPrompt`：注册角色路由指引。**必需**——`dsh-tool-subagent` 的
 *   工具描述不可配置，各角色工具的描述完全相同，路由规则只能靠系统提示传达。
 * - `subprocess`：执行本地 CLI。argv 数组直传、`shell: false`，全程无 shell。
 */
export const inject = ['tools', 'subagents', 'agents', 'systemPrompt', 'subprocess'];

/**
 * 新建一份装载诊断记录。
 *
 * ⚠️ 必须是**每次 `apply` 新建一份**，不能放在模块级共享。
 * 原因：preset 机制下同一个插件会被**加载多次**（profile 级一次、每个选中它的
 * 会话作用域再一次）。模块级可变状态会让后一次 `apply` 把前一次的记录清空，
 * 于是自检出现自相矛盾的输出 —— 实测就出现过
 * 「`codex-scout=失败`」与「`因开关未挂载：（无）`」并存。
 *
 * 诊断做得细是有原因的：Host 半边在 link 安装下不能热加载
 * （docs/architecture.md 3.3），每次排错都要重启，所以必须在一次激活里把
 * 「哪个角色失败、为什么」全部报出来。
 *
 * @returns {object} 空的诊断记录。
 */
function newDiagnostics() {
  return {
    configErrors: [],
    mounts: [],
    providers: [],
    executables: [],
    blocked: [],
    fatal: undefined,
  };
}

/**
 * 插件配置。
 *
 * `volatile` 子对象里的字段可在设置页实时编辑；角色列表属于结构性配置，
 * 改动后需要重新启用插件。
 */
export const Config = z.object({
  // ⚠️ `.volatile()` 是必须调用的，仅把子对象**命名**为 volatile 没有任何效果。
  // 依据 dsh-settings 的 volatileForm：
  //   if (schema.meta.volatile) return plainSchema(schema)
  // 其 JSDoc 为「Select fields whose nearest volatile ancestor makes them editable
  // without remounting」—— 标在这一个对象上，其子字段即可在设置页实时编辑。
  // 这里曾漏调用一次，注释写着 volatile、代码却没有，是典型「文档与实现脱节」。
  volatile: z
    .object({
      /** 跨 CLI 派发的总开关。Phase 3 使用。 */
      allowCrossCli: z.boolean().default(false).description('允许把角色派发给本机外部 CLI（会执行本地命令）'),
      /** 单次 CLI 派发的超时（秒）。Phase 3 使用。 */
      cliTimeoutSec: z.number().step(1).min(1).default(900).description('单次 CLI 派发的超时（秒）'),
    })
    .default({})
    .volatile(),
  /** 角色默认使用的 LLM route provider；角色自身可用 provider 覆盖。 */
  provider: z.string().description('角色默认 LLM provider'),
  /** 允许嵌套派发时，子代理可用的深度上限。 */
  maxDepth: z.number().step(1).min(0).default(3).description('允许嵌套派发时的深度上限'),
  /** CLI 角色的默认可执行工作目录；角色自身可用 cliCwd 覆盖。 */
  cwd: z.string().description('CLI 角色的默认工作目录'),
  /** 角色列表。 */
  //
  // ⚠️ `.volatile()` 是**必须**的，而且是可写面板的前提，原因有硬约束（见 3.1e）：
  //   1. 服务端 `SettingsForms.write` 对路径操作做 `isVolatilePath` 校验，
  //      非 volatile 路径一律抛 `Config field "roles.0.backend" is not volatile`。
  //      而 `roles` 是顶层字段，默认不在任何 volatile 子树下 —— 不标就**根本写不进去**。
  //   2. volatile 只能标在**数组整体**上：标在元素内部会被客户端 `validateVolatileSchema`
  //      拒绝（`volatile fields require a fixed object path without an enclosing
  //      volatile field @ ["roles","*","backend"]`），因为元素路径含 `*` 不固定。
  //   3. 标在数组上还顺带修正了一个语义：角色配置原先标为「结构性配置，改动后需重新启用
  //      插件」，而现在角色与机制本就该实时生效，标为 live 才是准确表述。
  //
  // 代价：自动配置面板也会把 `roles` 整棵树暴露为可编辑表单。这不理想但并不危险，
  // 且本插件自带的设置页（Client 半边）提供的是更合适的角色编辑器。
  roles: z
    .array(
      z.object({
        id: z.string().required(),
        title: z.string(),
        description: z.string().required(),
        // --- builtin 后端需要：DSH 的 LLM route ---
        provider: z.string(),
        // model 对 CLI 后端是「外部 CLI 的模型 id」，对 builtin 后端是 DSH route 的
        // model。两者共用一个字段是有意的：同一个角色只应有一个模型来源（见 D12）。
        model: z.string(),
        // ⚠️ schemastery **没有** `z.enum`（沿 zod 的直觉会踩坑）：枚举用 `z.union`。
        effort: z.union(EFFORT_VALUES),
        instructions: z.string().required(),
        readOnly: z.boolean().default(false),
        backend: z.union(['spawn', 'fork', 'cli']),
        allowNestedDispatch: z.boolean().default(false),
        // --- cli 后端需要：可执行文件与参数模板 ---
        // 放在角色**顶层**而非嵌套对象，是为了让设置面板把每一项当普通标量字段渲染。
        cliCommand: z.string(),
        cliPrefixArgs: z.array(z.string()),
        cliArgs: z.array(z.string()),
        cliPromptDelivery: z.union(['stdin', 'argv']),
        cliCwd: z.string(),
        cliGraceMs: z.number().step(1).min(0),
        cliMaxOutputBytes: z.number().step(1).min(1),
        cliMaxErrorBytes: z.number().step(1).min(1),
      }),
    )
    .default([])
    .volatile(),
});

/**
 * 调用 `ctx.subprocess.spawn`，把「服务本身抛错」也变成可上报的失败。
 *
 * `spawn` 的契约是：argv、cwd、env 或 graceMs 非法时**同步抛错**。不可用时
 * （例如没有挂载 subprocess 实现）也在这里失败，而不是让异常穿透到工具层。
 *
 * @param {object} ctx - Cordis 上下文。
 * @param {object} spec - `SubprocessSpawnSpec`。
 * @returns {object} `SubprocessHandle`
 */
function safeSpawn(ctx, spec) {
  if (!ctx.subprocess || typeof ctx.subprocess.spawn !== 'function') {
    throw new Error('ctx.subprocess.spawn 不可用：没有挂载 subprocess 服务实现');
  }
  return ctx.subprocess.spawn(spec);
}

/**
 * 报告 `settings.describe()` 实际为哪些命名空间产出了行。
 *
 * 为什么需要：插件的设置页用 `configForms.get(ns)` 读配置，而 `ns` 是
 * 「profile entry id」。这个值是**运行时事实**，靠读源码推断容易出错
 * （实测踩过：自建设置页读不到值，怀疑 ns 不对，但无法从外部核对）。
 * 把真实列表带进自检，一次重启就能确定，而不是继续猜。
 *
 * 用 `ctx.get('settings')` 而非写进 `inject`：这是一个**可选**依赖，
 * 不满足时只应让这一行诊断降级，绝不能因此让整个插件（含角色工具）不激活。
 *
 * @param {object} ctx - Cordis 上下文。
 * @returns {string} 一行可读的诊断文本。
 */
function settingsNamespacesText(ctx) {
  const service = typeof ctx.get === 'function' ? ctx.get('settings') : undefined;
  if (service === undefined || typeof service.describe !== 'function') {
    return 'settings.describe 不可用';
  }
  try {
    const rows = service.describe();
    if (!Array.isArray(rows)) return `describe() 返回非数组：${typeof rows}`;
    if (rows.length === 0) return '（describe() 返回空数组）';
    return rows.map((r) => `${r.ns}#${r.revision}`).join(' ');
  } catch (error) {
    return `describe() 抛错：${error instanceof Error ? error.message : String(error)}`;
  }
}

/**
 * 读取 preset roster 与构成清单，用于诊断「我们的 preset 为什么加载失败」。
 *
 * 为什么在插件里读而不是靠外部工具：GUI 只显示「加载失败」四个字，而
 * `AgentPresetRow.broken` / `AgentPresetComposition.broken` 携带具体诊断。
 * Host 半边在 link 安装下无法热加载，每次排错都要重启，所以必须让**一次**
 * 自检调用就能把失败原因带出来。
 *
 * `compositionInventory()` 与 `list()` 都是异步的，而 `apply()` 是同步的，
 * 因此这里返回的是「稍后可读」的惰性取值 —— 自检工具在 `execute` 里 await。
 *
 * @param {object} ctx - Cordis 上下文。
 * @returns {{ roster: () => Promise<string>, broken: () => Promise<string> }}
 */
function presetDiagnostics(ctx) {
  const service = typeof ctx.get === 'function' ? ctx.get('agentPresets') : undefined;

  /** 把任意异常压成一行文本。 */
  const brief = (error) => (error instanceof Error ? error.message : String(error));

  return {
    /** @returns {Promise<string>} roster 摘要（含 broken 说明）。 */
    async roster() {
      if (service === undefined || typeof service.list !== 'function') {
        return 'agentPresets.list 不可用';
      }
      try {
        const list = await service.list();
        return (
          list
            .map((p) => `${p.id}${p.isDefault ? '*' : ''}${p.broken ? `<broken: ${p.broken}>` : ''}`)
            .join(' ') || '（空）'
        );
      } catch (error) {
        return `读取失败：${brief(error)}`;
      }
    },
    /** @returns {Promise<string>} 构成清单里非 active 的行。 */
    async broken() {
      if (service === undefined || typeof service.compositionInventory !== 'function') {
        return 'agentPresets.compositionInventory 不可用';
      }
      try {
        const inventory = await service.compositionInventory();
        const out = [];
        for (const comp of inventory) {
          // FiberState.ACTIVE === 2（见 dsh-agent-presets 的类型声明）。
          const bad = (comp.rows ?? []).filter(
            (row) => typeof row.fiberState === 'number' && row.fiberState !== 2,
          );
          if (comp.broken || bad.length > 0) {
            out.push(
              `${comp.id}` +
                (comp.broken ? ` broken=${comp.broken}` : '') +
                (bad.length > 0
                  ? ` 非active: ${bad.map((r) => `${r.entryId ?? r.moduleName}(state=${r.fiberState})`).join(', ')}`
                  : ''),
            );
          }
        }
        return out.length > 0 ? out.join(' | ') : '（无异常行）';
      } catch (error) {
        return `读取失败：${brief(error)}`;
      }
    },
  };
}

/**
 * 自检工具：一次调用即可看清装载结果，避免为每个问题重启一次 dsh。
 *
 * `diagnostics` 由调用方按激活实例传入（**不是**模块级共享），否则同一插件被
 * 多个 preset 作用域加载时会互相覆盖记录。
 *
 * @param {object} ctx - Cordis 上下文（用于读取 preset 诊断）。
 * @param {object} diagnostics - 本激活实例的诊断记录。
 * @returns {object} ToolDefinition
 */
function selftestTool(ctx, diagnostics) {
  const presets = presetDiagnostics(ctx);
  return defineTool({
    name: 'switchboard_selftest',
    description:
      'Report whether the DSH Agent Switchboard plugin is loaded, which role delegation tools it ' +
      'registered, and any configuration or CLI-resolution errors. Takes no arguments and has no side effects.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          phase: { type: 'string', required: true },
          roleCount: { type: 'number', required: true },
          mounted: { type: 'string', required: true },
          providers: { type: 'string', required: true },
          executables: { type: 'string', required: true },
          blocked: { type: 'string', required: true },
          presetRoster: { type: 'string', required: true },
          presetBroken: { type: 'string', required: true },
          settingsNamespaces: { type: 'string', required: true },
          configErrors: { type: 'string', required: true },
          fatal: { type: 'string', required: true },
        },
      },
      render: (_args, value) => {
        const lines = [
          `Agent Switchboard · ${value.phase}`,
          `已挂载角色工具：${value.roleCount}`,
          `明细：${value.mounted}`,
          `preset roster：${value.presetRoster}`,
          `preset 异常行：${value.presetBroken}`,
          `settings 命名空间：${value.settingsNamespaces}`,
          `CLI provider：${value.providers}`,
          `CLI 可执行文件：${value.executables}`,
          `因开关未挂载：${value.blocked}`,
        ];
        if (value.configErrors) lines.push(`配置错误：\n${value.configErrors}`);
        if (value.fatal) lines.push(`致命错误：${value.fatal}`);
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    async execute() {
      // preset 诊断是异步的，且可能失败；失败不应让整个自检失败。
      const [presetRoster, presetBroken] = await Promise.all([
        presets.roster().catch((e) => `读取异常：${e?.message ?? e}`),
        presets.broken().catch((e) => `读取异常：${e?.message ?? e}`),
      ]);
      return {
        ok:
          diagnostics.fatal === undefined &&
          diagnostics.configErrors.length === 0 &&
          diagnostics.mounts.every((m) => m.ok),
        phase: 'phase-3',
        roleCount: diagnostics.mounts.filter((m) => m.ok).length,
        mounted:
          diagnostics.mounts.length === 0
            ? '（无）'
            : diagnostics.mounts.map((m) => `${m.id}=${m.ok ? 'OK' : `失败(${m.detail})`}`).join(' '),
        providers:
          diagnostics.providers.length === 0
            ? '（无 CLI 角色）'
            : diagnostics.providers
                .map((p) => `${p.id}->${p.name}${p.ok ? '' : ` 失败(${p.detail})`}`)
                .join(' '),
        executables:
          diagnostics.executables.length === 0
            ? '（无 CLI 角色）'
            : diagnostics.executables
                .map((e) => `${e.id}:${e.command}=${e.ok ? (e.resolved ?? 'OK') : `无法解析(${e.detail})`}`)
                .join(' '),
        blocked:
          diagnostics.blocked.length === 0
            ? '（无）'
            : diagnostics.blocked.map((b) => `${b.id}(${b.reason})`).join(' '),
        presetRoster,
        presetBroken,
        settingsNamespaces: settingsNamespacesText(ctx),
        configErrors: diagnostics.configErrors.join('\n'),
        fatal: diagnostics.fatal ?? '',
      };
    },
    presentCall: () => ({ card: 'generic', title: 'Agent Switchboard self-test', kind: 'other' }),
  });
}

/**
 * 挂载一个角色的委派工具。
 *
 * 用 `ctx.plugin(module, config)` 动态装载 `dsh-tool-subagent` 的**新实例**；
 * 每个实例有自己的 `toolName`，因此主代理会看到每个角色一个独立工具。
 *
 * @param {object} ctx - Cordis 上下文。
 * @param {object} role - 规范化后的角色。
 * @param {object} toolModule - 已 import 的 `dsh-tool-subagent` 模块命名空间。
 * @param {number} maxDepth - 嵌套派发深度上限。
 * @returns {{ ok: boolean, detail: string }}
 */
/**
 * 挂载一个角色的委派工具。
 *
 * ⚠️ **必须验证注册结果，不能只看 `ctx.plugin()` 是否抛错。**
 *
 * `ctx.plugin()` 只是**启动一个 fiber**，插件的 `apply` 在其后运行。所以插件在
 * `apply` 里抛出的错误（例如 `dsh-tool-subagent` 的配置断言）**不会**被这里的
 * try/catch 捕获 —— 它发生在另一个调用栈上。
 *
 * 实测后果：自检报 `codex-scout=OK`，但主代理调用时报
 * `unknown tool "delegate_to_codex_scout"`。这是「配置通过 ≠ 能力可用」的又一例，
 * 而且比缺工具更糟 —— 诊断在骗人。
 *
 * 因此这里注册后**核实工具名是否真的出现**在 `ctx.tools` 上。`undefined` 一律
 * 视为失败：宁可少一个工具并如实报告，也不要报 OK 而实际没有。
 *
 * @param {object} ctx - Cordis 上下文。
 * @param {object} role - 规范化后的角色。
 * @param {object} toolModule - 已 import 的 `dsh-tool-subagent` 模块。
 * @param {number} maxDepth - 允许嵌套时的额外层数。
 * @returns {Promise<{ok: boolean, detail: string}>} 挂载结果。
 */
async function mountRoleTool(ctx, role, toolModule, maxDepth) {
  if (typeof ctx.plugin !== 'function') {
    return { ok: false, detail: 'ctx.plugin 不可用' };
  }
  try {
    ctx.plugin(toolModule, toolConfigFor(role, { maxDepth }));
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }

  // 让 fiber 完成激活（`ctx.plugin` 之后插件在当前 tick 内运行），再核实注册结果。
  await Promise.resolve();
  await Promise.resolve();

  const tools = ctx.get('tools');
  if (tools === undefined) {
    return { ok: false, detail: '无法核实：ctx.get("tools") 不可用' };
  }
  if (typeof tools.get !== 'function') {
    return { ok: false, detail: '无法核实：tools.get 不可用' };
  }
  let registered;
  try {
    registered = tools.get(role.toolName);
  } catch (error) {
    return {
      ok: false,
      detail: `核实注册时抛错：${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (registered === undefined) {
    return {
      ok: false,
      detail: '工具未出现在工具注册表中（插件 fiber 内的装载很可能抛错了；见 Host 日志）',
    };
  }
  return { ok: true, detail: '已挂载并核实' };
}

/**
 * 插件入口。
 *
 * @param {object} ctx - Cordis 上下文。
 * @param {object} [config] - 已校验的配置。
 */
export function apply(ctx, config) {
  const resolved = config ?? {};

  // 每次激活一份独立记录。preset 机制下同一插件会被多次加载，共享模块级状态
  // 会让后一次激活清空前一次的记录（实测出现自相矛盾的自检输出）。
  const diagnostics = newDiagnostics();

  // 说明：这里刻意**不**报告「本插件处于哪个 preset 作用域」。
  // `agentPresets.composedPreset(ctx)` 是从传入的上下文向上找最近的 preset 挂载，
  // 而 apply 运行在根上下文，用它必然返回 undefined —— 那是假信号，与 preset 是否
  // 生效无关（详见 docs/architecture.md 3.1d 第 22 条）。
  // 「只在选中本插件 preset 的会话里生效」由 preset 机制本身保证，无需探测。
  console.error(`[${name}] 激活（配置字段：${Object.keys(resolved).join(', ') || '空'}）`);

  // 自检工具总是注册：即使角色配置全错，也要能用它看到错在哪。
  ctx.tools.register(selftestTool(ctx, diagnostics));

  // ⚠️ `roles` 在 Config 里标了 `.volatile()`，因此**必须**经 readVolatileField 取值：
  //    直接读 `resolved.roles` 得到的是引用对象，`Array.isArray` 为 false，
  //    于是报「roles 必须是数组」并导致所有角色都不挂载（实测踩过）。
  const { roles, errors } = normalizeRoles(
    readVolatileField(resolved, 'roles'),
    resolved.provider,
    resolved.cwd,
  );
  diagnostics.configErrors = errors;
  if (errors.length > 0) {
    // 配置有错时不挂载任何角色工具：半挂载会让主代理看到一批语义不明的工具。
    console.error(`[${name}] 角色配置有 ${errors.length} 处错误，未挂载任何角色工具：`);
    for (const line of errors) console.error(`[${name}]   - ${line}`);
    return;
  }
  if (roles.length === 0) return;

  // 注册角色路由指引。
  //
  // ⚠️ 这是必需的，不是锦上添花：`dsh-tool-subagent` 的工具描述由其内部
  // `providerWording()` 生成，Config 里**没有**任何字段能覆盖它，因此四个角色
  // 工具的描述逐字相同（已实测）。若不注册这段提示，主代理就只能靠工具名猜测
  // 「何时该派谁」，而这恰恰是本插件的核心价值。
  //
  // 作用域说明：`ctx.systemPrompt.section()` 注册在全局层，因此**子代理也会看到**
  // 这段文本。代价是每个子代理多占少量上下文；收益是确定性（不依赖调用时的 scope）。
  // 若日后要收窄，可改为通过 agent 作用域注册。
  ctx.systemPrompt.section({
    name: 'agent-switchboard:roles',
    // 10000 是 harness 身份段落所在的量级，放在其后以保证先读身份再读路由规则。
    order: 10500,
    text: roleGuidanceText(roles),
  });

  const maxDepth = typeof resolved.maxDepth === 'number' ? resolved.maxDepth : 3;

  // 跨 CLI 派发的总开关。**默认关闭**：CLI 后端会真的在本机执行本地命令，
  // 因此必须显式开启（`volatile.allowCrossCli`）。判定逻辑在纯函数
  // `planCliMounts()` 里，以便离线测试覆盖。
  //
  // ⚠️ 必须经 `readVolatile()` 取值，不能直接读 `resolved.volatile.xxx`
  //    （那恒为 undefined，曾导致本开关从未真正生效）。
  const volatile = readVolatile(resolved);
  const allowCrossCli = volatile.allowCrossCli === true;
  const cliTimeoutSec =
    typeof volatile.cliTimeoutSec === 'number' && volatile.cliTimeoutSec > 0
      ? volatile.cliTimeoutSec
      : 900;
  console.error(
    `[${name}] 跨 CLI 开关：allowCrossCli=${allowCrossCli}，cliTimeoutSec=${cliTimeoutSec}`,
  );
  const { active: activeCliRoles, blocked: blockedCliRoles } = planCliMounts(roles, allowCrossCli);

  // 注册 CLI 角色各自的 provider 实例。
  //
  // 为什么**每个角色一个实例**而不是一个共享 provider：provider 的 `start()`
  // 只能从 `request` 里看到提示词与父代理，无法知道是哪个角色发起的调用，
  // 而角色级命令/参数模板/模型/强度各不相同。注册名必须与
  // `toolConfigFor()` 写进工具配置的 provider 名一致（由 check-cli.mjs 的
  // 跨模块断言锁住）。
  if (blockedCliRoles.length > 0) {
    diagnostics.blocked = blockedCliRoles;
    console.error(
      `[${name}] ${blockedCliRoles.length} 个 CLI 角色未挂载（${blockedCliRoles[0].reason}）：` +
        blockedCliRoles.map((b) => b.id).join(', ') +
        '。CLI 后端会在本机执行外部命令，需显式开启后才挂载（设置面板可改）。',
    );
  }

  for (const role of activeCliRoles) {
    try {
      const provider = createCliProvider({
        role,
        spawn: (spec) => safeSpawn(ctx, spec),
        resolveExecutable: (command, env, signal) => ctx.subprocess.resolveExecutable(command, env, signal),
        timeoutMs: cliTimeoutSec * 1000,
      });
      ctx.subagents.registerProvider(provider);
      diagnostics.providers.push({ id: role.id, name: provider.name, ok: true, detail: '已注册' });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      diagnostics.providers.push({ id: role.id, name: cliProviderName(role.id), ok: false, detail });
      console.error(`[${name}] CLI provider "${role.id}" 注册失败：${detail}`);
    }
  }

  // CLI 角色的**装载期**校验：把「命令根本不存在」这类问题在启动时就报出来，
  // 而不是等第一次派发。解析失败不阻断装载（可能依赖运行期 PATH），只作为诊断。
  for (const role of activeCliRoles) {
    Promise.resolve()
      .then(() => ctx.subprocess.resolveExecutable(role.cli.command, role.cli.env))
      .then((path) => {
        diagnostics.executables.push({ id: role.id, command: role.cli.command, resolved: path, ok: true });
      })
      .catch((error) => {
        const detail = error instanceof Error ? error.message : String(error);
        diagnostics.executables.push({ id: role.id, command: role.cli.command, ok: false, detail });
        console.error(`[${name}] CLI 角色 "${role.id}" 的可执行文件无法解析：${detail}`);
      });
  }

  // 动态 import：把「工具包取不到」变成可上报的诊断，而不是整个插件激活失败。
  import('@deepseek-ai/dsh-tool-subagent')
    .then(async (toolModule) => {
      for (const role of roles) {
        // ⚠️ 必须**按角色**复用同一个判定，不能只 gate provider 注册。
        //
        // `dsh-tool-subagent` 装载时**不检查** provider 是否存在：它拿 provider 名
        // 去查，查不到也不会在装载期抛错。因此「provider 没注册但工具挂上了」会
        // 形成最糟的形态 —— 主代理看得见这个工具，一调用就失败。
        //
        // 这是 Phase 2 记录过的同类故障（`4/4 OK` 但只有 1 个能用），当时靠真实
        // 派发才发现；这里必须在挂载前就拦住。
        const blocked = blockedCliRoles.find((b) => b.id === role.id);
        if (blocked) {
          diagnostics.mounts.push({
            id: role.id,
            ok: false,
            detail: `${blocked.reason}，故未挂载（provider 也未注册）`,
          });
          continue;
        }
        // `mountRoleTool` 会核实工具是否真的注册成功（见其 JSDoc）。
        const outcome = await mountRoleTool(ctx, role, toolModule, maxDepth);
        diagnostics.mounts.push({ id: role.id, ok: outcome.ok, detail: outcome.detail });
        if (!outcome.ok) console.error(`[${name}] 角色 "${role.id}" 挂载失败：${outcome.detail}`);
      }
      const okCount = diagnostics.mounts.filter((m) => m.ok).length;
      console.error(
        `[${name}] 已挂载 ${okCount}/${roles.length} 个角色工具：` +
          diagnostics.mounts.filter((m) => m.ok).map((m) => m.id).join(', '),
      );
    })
    .catch((error) => {
      diagnostics.fatal = `无法 import @deepseek-ai/dsh-tool-subagent：${
        error instanceof Error ? error.message : String(error)
      }`;
      console.error(`[${name}] ${diagnostics.fatal}`);
    });
}
