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
import { join } from 'node:path';
import {
  CLI_BACKEND,
  EFFORT_VALUES,
  cliProviderName,
  normalizeRoles,
  planCliMounts,
  roleGuidanceText,
  routeSummaryFor,
  toolConfigFor,
} from './roles.js';
import { createCliProvider } from './cli/provider.js';
import { configPathFor, readConfigFile, writeConfigFile, initialConfig } from './config-file.js';

/**
 * 从插件自己的配置文件读取角色。
 *
 * 这是**装载期的内部读取**：返回可直接交给 `normalizeRoles` 的归一化结果与一句诊断。
 *
 * @param {string|undefined} path - 配置文件绝对路径；不可用时为 undefined。
 * @returns {{ok: boolean, value?: object, detail: string}} 读取结果。
 */
function readRoleConfigFile(path) {
  if (path === undefined) {
    return { ok: false, detail: '无法定位角色配置文件（ctx.profileContext 不可用）' };
  }
  const read = readConfigFile(path);
  if (!read.ok) {
    return { ok: false, detail: `角色配置文件无法读取（${path}）：${read.error}` };
  }
  if (read.missing) {
    // 「文件不存在」不是错误：用户还没配过角色。如实说明，不冒充成功。
    return { ok: true, value: { roles: [] }, detail: `尚未创建角色配置文件（${path}）` };
  }
  return { ok: true, value: read.value, detail: `已从 ${path} 读取 ${read.value.roles.length} 个角色` };
}

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
    /** 本作用域解析出的角色（`{id, toolName}`）。用于自检在「本作用域不挂载工具」时说清原因。 */
    configuredRoles: [],
    roleConfigPath: undefined,
    roleConfigRead: undefined,
    roleConfigSync: undefined,
    fatal: undefined,
  };
}

/**
 * 在**当前作用域**实时查询角色工具是否真的可用。
 *
 * 为什么不读 `diagnostics.mounts`：那是 `import(...).then(...)` 异步写入的快照，
 * `apply` 返回时往往还是空的；而且同一插件会被多次激活（根条目 + 各 preset 会话），
 * 在某个作用域读到的快照未必对应当前作用域。**「工具在不在」本来就能当场查到。**
 *
 * @param {object} ctx - Cordis 上下文。
 * @param {{id: string, toolName: string}[]} roles - 本作用域配置的角色。
 * @returns {{id: string, ok: boolean, detail: string}[]} 实时结果；查不到时返回空数组。
 */
export function liveRoleTools(ctx, roles) {
  const tools = typeof ctx.get === 'function' ? ctx.get('tools') : undefined;
  if (tools === undefined || typeof tools.get !== 'function') return [];
  return roles.map((role) => {
    let found;
    try {
      found = tools.get(role.toolName);
    } catch (error) {
      return { id: role.id, ok: false, detail: `查询抛错：${error instanceof Error ? error.message : String(error)}` };
    }
    return {
      id: role.id,
      ok: found !== undefined && found !== null,
      detail: found === undefined || found === null ? '工具未注册' : '已注册',
    };
  });
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
      // ⚠️ 这里曾经有一个 `allowCrossCli: z.boolean().default(false)` 作为「跨 CLI 派发总开关」。
      //    **已移除**，原因两条：
      //
      //    1. 它是**在 UI 上无法打开、却能让角色静默不挂载**的开关。面板上的那个开关后来
      //       被移除（角色工具改由 `mount` 控制作用域），但这个执行期的门禁留着，于是
      //       CLI 角色永远挂不上，而界面上只看到「工具不存在」。实测踩到：
      //           scout=失败(allowCrossCli 未开启，故未挂载（provider 也未注册）)
      //       这正是本项目一路在消灭的「静默不存在」。
      //    2. **它是冗余的**。「要不要走外部 CLI」已经由每个角色自己的 `backend: 'cli'`
      //       显式表达，而角色只在声明了 `mount: true` 的 Switchboard preset 会话里挂载。
      //       再加一道隐藏的全局闸门，只增加了状态与失败面，没有增加判断力。
      //
      //    取舍说明：「会执行本机命令」这件事的可控性现在依赖两点 —— 角色的 `backend`
      //    必须被显式设为 `cli`，且该角色只在 Switchboard preset 会话里存在。这比一个
      //    看不见的全局开关更容易理解和审计。
      /** 单次 CLI 派发的超时（秒）。 */
      cliTimeoutSec: z.number().step(1).min(1).default(900).description('单次 CLI 派发的超时（秒）'),
    })
    .default({})
    .volatile(),
  /** 角色默认使用的 LLM route provider；角色自身可用 provider 覆盖。 */
  provider: z.string().description('角色默认 LLM provider'),
  /** 允许嵌套派发时，子代理可用的深度上限。 */
  maxDepth: z.number().step(1).min(0).default(3).description('允许嵌套派发时的深度上限'),
  /**
   * 是否在**本作用域**挂载角色工具。
   *
   * 这是「配置随处可编辑，但工具不外溢」的实现机制（见 D13）：
   *   - 根条目（bundle 的 insert）**不带**这个标记 → 只提供 `roleConfig` 配置服务，
   *     不注册任何角色工具，因此不会污染其他 preset 的会话；
   *   - preset 声明里写 `mount: true` → 只有选中该 preset 的会话才挂载角色工具。
   *
   * 默认 `false` 是刻意的：漏配的后果是「工具没出现」（显式、可发现），
   * 而默认为 true 的后果是「工具出现在所有会话里」（隐性、且无提示）。
   */
  mount: z.boolean().default(false).description('是否在本作用域挂载角色工具（仅 preset 声明应为 true）'),
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
        //
        // `cliDriver` 只是「用户选了哪个 CLI 预设」的**记录**，不参与执行：真正生效的是
        // 下面四个字段。这样既不引入「预设 vs 手工覆盖」两套真相，又能在界面上把选中的
        // 预设显示出来（反推失败时显示为 custom）。取值不设 enum，允许用户自定义。
        cliDriver: z.string().description('所选 CLI 预设的标识（仅记录用；执行以 cliCommand / cliArgs 为准）'),
        cliCommand: z.string(),
        cliPrefixArgs: z.array(z.string()),
        cliArgs: z.array(z.string()),
        // 取值必须与 `src/cli/argv.js` 的 `PROMPT_DELIVERY` 一致（有离线断言锁定）。
        // `promptFile` 把提示词写进临时文件、只把**路径**放进 argv，因此不受
        // 「argv 的值不得含换行」这条限制 —— 支持从文件读提示词的 CLI 应当用它。
        cliPromptDelivery: z.union(['stdin', 'argv', 'promptFile']),
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
          liveTools: { type: 'string', required: true },
          providers: { type: 'string', required: true },
          executables: { type: 'string', required: true },
          blocked: { type: 'string', required: true },
          presetRoster: { type: 'string', required: true },
          presetBroken: { type: 'string', required: true },
          settingsNamespaces: { type: 'string', required: true },
          roleConfigStatus: { type: 'string', required: true },
          configErrors: { type: 'string', required: true },
          fatal: { type: 'string', required: true },
        },
      },
      render: (_args, value) => {
        const lines = [
          `Agent Switchboard · ${value.phase}`,
          `已挂载角色工具：${value.roleCount}`,
          `明细：${value.mounted}`,
          // 实时查询结果与异步快照分开显示：两者不一致本身就是有价值的诊断信息
          // （快照空、实时有 = 挂载还没跑完，或者你正在别的作用域里查）。
          `实时工具查询：${value.liveTools}`,
          `preset roster：${value.presetRoster}`,
          `preset 异常行：${value.presetBroken}`,
          `settings 命名空间：${value.settingsNamespaces}`,
          `roleConfig 状态：${value.roleConfigStatus}`,
          `CLI provider：${value.providers}`,
          `CLI 可执行文件：${value.executables}`,
          // 「跨 CLI 总开关」已移除，因此这里不再是「因开关未挂载」，而是
          // 「因**别的原因**被拦下」（目前该列表恒为空，保留以便将来有新的前置条件）。
          `未挂载的角色：${value.blocked}`,
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

      // ⚠️ **实时查询工具注册表**，而不是只读 `diagnostics.mounts` 那个快照。
      //
      // 两个原因（都实测踩到）：
      //   1. 挂载走 `import(...).then(...)`，是**异步**的。`apply` 返回时它往往还没跑完，
      //      而自检可以被更早调用 —— 于是快照是空的，报告「已挂载 0 个」，
      //      **尽管工具确实都在**（实测：报告 0，但 4 个 `delegate_to_*` 全部可调用）。
      //   2. 同一个插件会被**多次激活**（根条目 + 每个 preset 会话）。在别的作用域调用
      //      自检时，读到的是**那个作用域**的快照，因此报「工具未出现在工具注册表中」。
      //
      // 「工具到底在不在」本来就可以当场查到（`ctx.get('tools').get(name)`），
      // 因此不要再依赖快照 —— 快照只用于解释「为什么没挂上」。
      const live = liveRoleTools(ctx, diagnostics.configuredRoles);
      const mounted = live.length > 0 ? live : diagnostics.mounts;
      const okCount = mounted.filter((m) => m.ok).length;

      return {
        ok:
          diagnostics.fatal === undefined &&
          diagnostics.configErrors.length === 0 &&
          // 只把**明确失败**的记入 ok：异步挂载可能尚未完成，或者某个作用域本来就不挂载
          // 角色工具（根条目），把这些当成失败会产生误导性的「不 ok」。
          !diagnostics.mounts.some((m) => m.ok === false) &&
          !live.some((m) => m.ok === false),
        phase: 'phase-3',
        roleCount: okCount,
        mounted:
          mounted.length === 0
            ? diagnostics.configuredRoles.length === 0
              ? '（本插件尚未配置任何角色）'
              : `（本作用域不挂载角色工具；已配置 ${diagnostics.configuredRoles.length} 个角色：${diagnostics.configuredRoles
                  .map((r) => r.id)
                  .join(', ')}）`
            : mounted.map((m) => `${m.id}=${m.ok ? 'OK' : `失败(${m.detail})`}`).join(' '),
        liveTools:
          live.length === 0
            ? '（本作用域查不到角色工具）'
            : live.map((m) => `${m.id}=${m.ok ? 'OK' : '缺失'}`).join(' '),
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
        roleConfigStatus: [
          `路径=${diagnostics.roleConfigPath ?? '未解析'}`,
          `读取=${diagnostics.roleConfigRead ?? '（本作用域未读取）'}`,
          `同步=${diagnostics.roleConfigSync ?? '（本作用域未同步）'}`,
        ].join(' | '),
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
 * 在 `ctx.profileContext` 不可用时推断 `$DSH_HOME`。
 *
 * 依据 `dsh-home-paths` 的语义：优先 `$DSH_HOME` 环境变量，否则 `~/.dsh`。
 * 这一层兜底是为了让 headless / sdk / acp 启动形态下角色配置仍可用 ——
 * 那些形态下 `dsh-base` 会把依赖 `profileContext` 的行整行禁用。
 *
 * @returns {string} 推断出的 `$DSH_HOME`。
 */
function resolveFallbackDshHome() {
  const fromEnv = process.env.DSH_HOME;
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) return fromEnv.trim();
  const home = process.env.USERPROFILE ?? process.env.HOME ?? '.';
  return join(home, '.dsh');
}

/**
 * 插件入口。
 *
 * ⚠️ **整个函数体被一层兜底 try/catch 包住**，这是硬要求，不是保险起见。
 *
 * 实测教训：本插件曾因自身缺陷导致应用**无法启动**，用户只能禁用插件才进得来。
 * 一个插件的失败绝不能升级成「应用不可用」—— 让应用起来、把问题写进诊断，永远优于
 * 让用户进不去。因此这里保证：无论 `apply` 内部发生什么，都只记录一行诊断并返回。
 *
 * @param {object} ctx - Cordis 上下文。
 * @param {object} [config] - 已校验的配置。
 */
export function apply(ctx, config) {
  try {
    applyInner(ctx, config);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    // 不用 console.error 之外的手段：此刻上下文可能已经不可用，能吐出一行日志就够。
    console.error(
      `[${name}] 装载失败，已降级（应用不受影响，本插件本次不生效）：${detail}`,
      error instanceof Error ? error.stack : undefined,
    );
  }
}

/**
 * `apply` 的实际实现。
 *
 * @param {object} ctx - Cordis 上下文。
 * @param {object} [config] - 已校验的配置。
 */
function applyInner(ctx, config) {
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

  // --- 角色配置的来源：插件自己的文件（见 src/config-file.js 顶部的架构说明）------
  //
  // 不再从 Cordis 配置读 `roles`，原因有两条互相冲突的约束：
  //   1. `settings.describe()` 按 ns 去重、只报告根条目，因此设置页读不到 preset 那份；
  //   2. 把 roles 移到根条目会让角色工具全局可见，污染其他 preset 的会话。
  // 换成插件自己的文件后，两条同时解开：配置随处可编辑，而工具是否可见只取决于
  // 本插件在哪个会话作用域被激活。
  const profileContext = typeof ctx.get === 'function' ? ctx.get('profileContext') : undefined;
  // `$DSH_HOME` 来自 profileContext。它在 profile 启动路径下一定存在；headless/sdk/acp
  // 下 profileContext 本身不存在（dsh-base 里相关行都写成 `disabled: !!js "!ctx.get('profileContext')"`），
  // 那种情况下退化为 `$DSH_HOME` 环境变量或默认 `~/.dsh`，保证角色配置仍然可用。
  const dshHome =
    typeof profileContext?.home === 'string' && profileContext.home.length > 0
      ? profileContext.home
      : resolveFallbackDshHome();
  const roleConfigPath = configPathFor(dshHome);
  diagnostics.roleConfigPath = roleConfigPath;

  // --- 是否在本作用域挂载角色工具（同时也是「是不是根条目」的判据）----------------
  //
  // 只有显式声明 `mount: true` 的作用域才挂载。根条目（bundle 的 insert）不带这个标记，
  // preset 声明带上 —— 于是：
  //   - 配置服务在根作用域常驻 → 设置页随时可用，且**不注册任何角色工具**；
  //   - 角色工具只在 preset 会话里出现 → 其他 preset 的会话不受污染。
  //
  // 「子代理也会继承 preset、因而可能重复挂载」这一点不必额外防护：`mountRoleTool`
  // 在挂载后用 `ctx.get('tools').get(name)` **核实**工具是否可见，而子代理的 agent
  // 作用域查不到父作用域注册的工具（这正是角色工具不重复出现的实测机制）。
  const mountHere = readVolatileField(resolved, 'mount') === true;

  // --- 根条目：做「配置 → 文件」的同步，不挂载角色工具 -----------------------------
  //
  // 为什么是根条目来做同步：客户端唯一可写通道是 `settings.mutate(ns, …)`，而 `ns`
  // 只能是根条目 id（`configEditor.entries()` 只取 `parent.tree.ctx.fiber.entry?.id
  // === "include"` 的条目，preset 内的插件声明没有 settings 行）。因此 UI 写的必然是
  // **根条目的配置**；而真正挂载角色工具的是 preset 实例。文件就是两者之间的桥。
  //
  // ⚠️ 本插件**不再注册任何 Cordis 服务**。曾经注册过一个 `roleConfig` 远程服务想给
  //    客户端设置页用，但实测证明外部插件**无法新增客户端可调用的远程命名空间**
  //    （客户端只装载构建期生成的静态贡献清单，且没有 Proxy），那个服务客户端根本
  //    调不到；留着它只会平添「注册失败拖垮启动」的风险。现在客户端走 `settings`。
  if (!mountHere) {
    syncRolesToFile({ resolved, roleConfigPath, diagnostics });
    return;
  }

  mountRolesInThisScope(ctx, { roleConfigPath, resolved, diagnostics });
}

/**
 * 把根条目 Cordis 配置里的角色同步到文件。
 *
 * 这是「UI 改配置」到「preset 会话读文件」之间的桥。只在根条目执行，且**任何失败都
 * 只记诊断**：同步失败不该影响应用，最坏情况是 preset 会话用到上一版角色。
 *
 * @param {object} options - 选项。
 * @param {object} options.resolved - 根条目的已校验配置。
 * @param {string} options.roleConfigPath - 配置文件绝对路径。
 * @param {object} options.diagnostics - 诊断记录。
 */
function syncRolesToFile({ resolved, roleConfigPath, diagnostics }) {
  const cordisRoles = readVolatileField(resolved, 'roles');
  if (!Array.isArray(cordisRoles) || cordisRoles.length === 0) {
    const current = readRoleConfigFile(roleConfigPath);
    diagnostics.roleConfigSync =
      current.ok && current.missing !== true
        ? `根条目无角色；文件已有 ${current.value.roles.length} 个，保持不变`
        : '根条目无角色，文件也没有 —— 等待 UI 写入';
    console.error(`[${name}] ${diagnostics.roleConfigSync}`);
    return;
  }

  // 与文件比对后再写，避免每次启动都做一次无意义写盘。
  const current = readRoleConfigFile(roleConfigPath);
  if (current.ok && current.missing !== true) {
    const same = JSON.stringify(current.value.roles) === JSON.stringify(cordisRoles);
    if (same) {
      diagnostics.roleConfigSync = `文件已与配置一致（${cordisRoles.length} 个），未重写`;
      return;
    }
  }

  const existing = current.ok && current.missing !== true ? current.value : {};
  const written = writeConfigFile(
    roleConfigPath,
    initialConfig(cordisRoles, {
      provider: existing.provider ?? resolved.provider,
      cwd: existing.cwd ?? resolved.cwd,
      maxDepth: existing.maxDepth ?? resolved.maxDepth,
    }),
  );
  diagnostics.roleConfigSync = written.ok
    ? `已把 ${cordisRoles.length} 个角色从配置同步到文件`
    : `同步失败：${written.error}`;
  console.error(`[${name}] ${diagnostics.roleConfigSync}`);
}

/**
 * 在**本作用域**挂载角色工具（只有 `mount: true` 的 preset 作用域会走到这里）。
 *
 * @param {object} ctx - Cordis 上下文。
 * @param {object} options - 选项。
 * @param {string} options.roleConfigPath - 配置文件绝对路径。
 * @param {object} options.resolved - 已校验的配置。
 * @param {object} options.diagnostics - 诊断记录。
 */
function mountRolesInThisScope(ctx, { roleConfigPath, resolved, diagnostics }) {

  // 角色来源有两个候选，**先记下各自看到什么**，再决定用哪个。
  //
  // 为什么要两条路（实测约束决定的）：
  //   - 客户端唯一可写通道是 `settings.mutate(ns, …)`，而 `ns` 只能是**根条目** id
  //     （`configEditor.entries()` 只取 `parent.tree.ctx.fiber.entry?.id === "include"`
  //     的条目，preset 内的插件声明没有 settings 行）。所以「UI 可编辑」要求角色落在
  //     **根条目的 Cordis 配置**里。
  //   - 而真正挂载角色工具的是 **preset 实例**，它读的是自己那份配置。
  // 因此必须确认 preset 实例能否看到根条目的配置；两条都记进诊断，一次重启即可判明。
  const fromFile = readRoleConfigFile(roleConfigPath);
  const fromCordis = readVolatileField(resolved, 'roles');
  const cordisRoles = Array.isArray(fromCordis) ? fromCordis : [];
  diagnostics.roleConfigRead =
    `${fromFile.detail}；本作用域 Cordis 配置里 roles=${cordisRoles.length} 个`;

  // 优先用 Cordis 配置（那是 UI 能写的地方）；为空时回落到文件。
  // 这样「UI 改了但文件还没同步」与「文件是权威」两种时序都不会丢角色。
  let rawRoles = cordisRoles.length > 0 ? cordisRoles : fromFile.ok ? fromFile.value.roles : [];
  const defaults = {
    provider: (fromFile.ok && fromFile.value.provider) || resolved.provider,
    cwd: (fromFile.ok && fromFile.value.cwd) || resolved.cwd,
  };
  if (rawRoles.length === 0) {
    if (!fromFile.ok) {
      diagnostics.configErrors = [fromFile.detail];
      console.error(`[${name}] ${fromFile.detail}`);
      return;
    }
    console.error(`[${name}] 本作用域没有角色（Cordis 配置与文件都为空）`);
    return;
  }

  const { roles, errors } = normalizeRoles(rawRoles, defaults.provider, defaults.cwd);
  diagnostics.configErrors = errors;
  // 记录「本作用域配置了哪些角色」——自检在解析不出工具时据此说明原因，
  // 而不是含糊地报「工具未出现在工具注册表中」。
  diagnostics.configuredRoles = roles.map((r) => ({ id: r.id, toolName: r.toolName }));
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

  // CLI 派发的超时。
  //
  // ⚠️ 必须经 `readVolatile()` 取值，不能直接读 `resolved.volatile.cliTimeoutSec`
  //    （那恒为 undefined —— volatile 字段是**引用对象**，直接读属性拿不到真值）。
  //
  // 这里**没有** `allowCrossCli` 门禁了：曾经有一个全局开关挡在 CLI 角色挂载之前，
  // 但它后来在面板上被移除、却仍在执行期拦截，于是 CLI 角色永远挂不上且界面上只看到
  // 「工具不存在」。现在「要不要走外部 CLI」由角色自己的 `backend: 'cli'` 表达，
  // 而角色只在声明了 `mount: true` 的 Switchboard preset 会话里挂载。
  const volatile = readVolatile(resolved);
  const cliTimeoutSec =
    typeof volatile.cliTimeoutSec === 'number' && volatile.cliTimeoutSec > 0
      ? volatile.cliTimeoutSec
      : 900;
  console.error(`[${name}] cliTimeoutSec=${cliTimeoutSec}`);
  const { active: activeCliRoles, blocked: blockedCliRoles } = planCliMounts(roles);

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
      `[${name}] ${blockedCliRoles.length} 个 CLI 角色未挂载：` +
        blockedCliRoles.map((b) => `${b.id}(${b.reason})`).join(', '),
    );
  }

  for (const role of activeCliRoles) {
    try {
      const provider = createCliProvider({
        role,
        spawn: (spec) => safeSpawn(ctx, spec),
        resolveExecutable: (command, env, signal) => ctx.subprocess.resolveExecutable(command, env, signal),
        timeoutMs: cliTimeoutSec * 1000,
        // 与系统提示词里的路由指引同一套措辞，让主代理能对照「本该走哪条」与「实际走哪条」。
        routeSummary: routeSummaryFor(role),
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
