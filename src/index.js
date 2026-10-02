/**
 * Agent Switchboard 的 Host 半边。
 *
 * 职责：把「角色」变成主代理可用的委派工具。
 *
 * 设计要点（依据见 docs/decisions.md）：
 *   - 根 Config 经文件桥接给常驻 preset，写盘广播驱动代际重挂。
 *     增删角色无需重启；Host 源码改动仍需重启一次装载。
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
import { createScope, scopeOf } from '@deepseek-ai/dsh-scope';
import { join } from 'node:path';
import {
  CLI_BACKEND,
  EFFORT_VALUES,
  cliToolName,
  normalizeRoles,
  planCliMounts,
  roleGuidanceText,
  routeSummaryFor,
  toolConfigFor,
} from './roles.js';
import { createCliTool } from './cli/provider.js';
import { configPathFor, readConfigFile, writeConfigFile, initialConfig } from './config-file.js';

/**
 * 从插件自己的配置文件读取角色。
 *
 * 装载与事件热重载共用：返回可直接交给 `normalizeRoles` 的结果与一句诊断。
 *
 * @param {string|undefined} path - 配置文件绝对路径；不可用时为 undefined。
 * @returns {{ok: boolean, value?: object, missing?: boolean, detail: string}} 读取结果。
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
    return { ok: true, missing: true, value: { roles: [] }, detail: `尚未创建角色配置文件（${path}）` };
  }
  return { ok: true, value: read.value, detail: `已从 ${path} 读取 ${read.value.roles.length} 个角色` };
}

/** Loader 条目名，与 package.json 的 `name` 保持一致。 */
export const name = 'agent-switchboard';
const generationKey = Symbol.for('agent-switchboard.generation');
const publicContextKey = Symbol('agent-switchboard.public-context');

/**
 * 读取 `volatile` 子对象的实际取值。
 *
 * ⚠️ **这是一个踩过的真坑**：调用 `.volatile()` 后，schemastery 把该子对象变成
 * 一个**引用对象**（Volatile ref），其属性**不在对象自身上** ——
 *   - `JSON.stringify(resolved.volatile)` → `{}`
 *   - `resolved.volatile.someField`       → `undefined`（恒为 undefined，与配置里写没写无关）
 *   - `resolved.volatile.get()`           → 该引用对象的当前取值（普通对象）
 *
 * 因此 `resolved.volatile?.someField === true` 这种直接访问**永远**判定为不成立。
 * 实测后果：当时那个全局开关从未真正生效过，而自检一直显示「未开启」，看起来与
 * 「默认关闭」的表现完全相同，所以长期未被发现 —— 直到在 preset 里显式写入该字段
 * 仍不生效才暴露。
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
  if (raw === null || raw === undefined) return raw;
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

/** 弃用日志每次模块加载只发一次；各激活实例仍保留自己的诊断。 */
let warnedLegacyTimeout = false;
let warnedLegacyWrapper = false;

/** 旧角色包裹字段仍可加载，但不再参与路由；各实例都记录，模块只告警一次。 */
function noteLegacyWrapper(value, diagnostics) {
  const roles = readVolatileField(value, 'roles');
  if (!Array.isArray(roles) || !roles.some((role) => role &&
    ['agentProvider', 'agentModel'].some((key) => Object.hasOwn(role, key)))) return;
  const message = '角色 agentProvider / agentModel 已废弃并忽略；请使用插件级 volatile.wrapperProvider / wrapperModel / wrapperEffort';
  if (!diagnostics.deprecatedConfig.includes(message)) {
    diagnostics.deprecatedConfig = [diagnostics.deprecatedConfig, message].filter(Boolean).join('；');
  }
  if (!warnedLegacyWrapper) {
    warnedLegacyWrapper = true;
    console.error(`[${name}] ${message}`);
  }
}

/** 空白等同未设置；离线文件与直接 apply 路径也必须校验强度。 */
function wrapperRouteFrom(value) {
  const volatile = readVolatile(value);
  const route = {};
  const errors = [];
  for (const key of ['provider', 'model', 'effort']) {
    const field = `wrapper${key[0].toUpperCase()}${key.slice(1)}`;
    const raw = volatile[field];
    if (raw !== undefined && raw !== null && typeof raw !== 'string') {
      errors.push(`volatile.${field} 必须是字符串`);
    }
    if (typeof raw === 'string' && raw.trim()) route[key] = raw.trim();
  }
  if (route.effort && !EFFORT_VALUES.includes(route.effort)) {
    errors.push(`volatile.wrapperEffort "${route.effort}" 非法：只能是 ${EFFORT_VALUES.join(' / ')}`);
  }
  return { route, errors };
}

/** 用既有文件桥接根配置与 preset；显式空值确保清除后不回落 preset 的旧值。 */
function syncWrapperRouteToFile(resolved, roleConfigPath, diagnostics) {
  // 独立维护当前同步失败；恢复后不锁存旧错误。
  const previous = diagnostics.wrapperSyncError;
  diagnostics.configErrors = diagnostics.configErrors.filter((error) => error !== previous);
  diagnostics.wrapperSyncError = undefined;
  diagnostics.wrapperSyncPending = false;
  const fail = (detail) => {
    const message = `包裹路由同步失败：${detail}`;
    diagnostics.wrapperSyncError = message;
    if (!diagnostics.configErrors.includes(message)) diagnostics.configErrors.push(message);
    if (message !== previous) console.error(`[${name}] ${message}`);
  };
  const current = readRoleConfigFile(roleConfigPath);
  const fields = ['wrapperProvider', 'wrapperModel', 'wrapperEffort'];
  const root = readVolatile(resolved);
  const existing = current.ok ? current.value : {};
  if (!fields.some((key) => Object.hasOwn(root, key) || Object.hasOwn(existing.volatile ?? {}, key))) return;
  if (!current.ok) {
    fail(current.detail);
    return;
  }
  // 仅包裹设置也必须建立桥接文件；空 roles 仍可由迁移脚本后续播种。
  // 创建失败时 preset 无法得知根设置，可能回落自身路由；pending 必须判为不健康。
  diagnostics.wrapperSyncPending = current.missing === true;
  const volatile = { ...existing.volatile };
  for (const key of fields) volatile[key] = typeof root[key] === 'string' ? root[key].trim() : '';
  if (JSON.stringify(volatile) === JSON.stringify(existing.volatile)) return;
  const written = writeConfigFile(roleConfigPath, current.missing
    ? initialConfig([], { volatile })
    : { ...existing, volatile });
  if (!written.ok) fail(written.error);
  else {
    diagnostics.wrapperSyncPending = false;
    if (current.missing) diagnostics.roleConfigSync = '已创建空角色文件以桥接根包裹路由（角色待播种）';
  }
}

/** 每激活实例保留诊断；弃用日志每次模块加载最多打印一次。 */
function noteLegacyTimeout(value, diagnostics) {
  if (!Object.hasOwn(readVolatile(value), 'cliTimeoutSec') && !Object.hasOwn(value ?? {}, 'cliTimeoutSec')) return;
  const message = 'cliTimeoutSec 已废弃并忽略；CLI 无运行期限，可通过会话停止取消';
  if (!diagnostics.deprecatedConfig.includes(message)) {
    diagnostics.deprecatedConfig = [diagnostics.deprecatedConfig, message].filter(Boolean).join('；');
  }
  if (!warnedLegacyTimeout) {
    warnedLegacyTimeout = true;
    console.error(`[${name}] ${message}`);
  }
}

/**
 * 新建一份装载诊断记录。
 *
 * ⚠️ 必须是**每次 `apply` 新建一份**，不能放在模块级共享。
 * 原因：同一插件分别在根条目和常驻 preset 激活；会话只继承 preset，不重新 apply。
 * 模块级可变状态会让后一次 `apply` 把前一次的记录清空，
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
    /** normalization 前的角色数量；非法配置也不能被误报为零角色。 */
    configuredRoleCount: 0,
    /** 本实例是否负责挂载；配置角色数与工具挂载状态分别记录。 */
    mountHere: false,
    roleConfigPath: undefined,
    roleConfigRead: undefined,
    roleConfigSync: undefined,
    deprecatedConfig: '',
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
 * @returns {{id: string, ok: boolean, detail: string, unverified?: boolean}[]} 实时结果；零角色返回空数组，不可查询逐角色标记未核实。
 */
export function liveRoleTools(ctx, roles) {
  // 三态：零角色无需查询；服务可查询则逐角色核实；不可查询不能当作健康。
  if (roles.length === 0) return [];
  const unverified = (detail) => roles.map((role) => ({ id: role.id, ok: false, unverified: true, detail }));
  let tools;
  try {
    tools = typeof ctx.get === 'function' ? ctx.get('tools') : undefined;
  } catch (error) {
    return unverified(`无法核实：工具服务读取抛错：${error instanceof Error ? error.message : String(error)}`);
  }
  if (tools == null || typeof tools.get !== 'function') {
    return unverified('无法核实：工具服务不可查询');
  }
  return roles.map((role) => {
    let found;
    let cliFound = true;
    try {
      found = tools.get(role.toolName, scopeOf(ctx));
      if (role.cliToolName) cliFound = tools.get(role.cliToolName, scopeOf(ctx)) != null;
    } catch (error) {
      return { id: role.id, ok: false, detail: `查询抛错：${error instanceof Error ? error.message : String(error)}` };
    }
    return {
      id: role.id,
      ok: found !== undefined && found !== null && cliFound,
      detail: !cliFound ? `专属 CLI 工具未注册：${role.cliToolName}`
        : found === undefined || found === null ? '工具未注册' : '已注册',
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
      //           scout=失败(allowCrossCli 未开启，故未挂载（专属 CLI 工具不可用）)
      //       这正是本项目一路在消灭的「静默不存在」。
      //    2. **它是冗余的**。「要不要走外部 CLI」已经由每个角色自己的 `backend: 'cli'`
      //       显式表达，而角色只在声明了 `mount: true` 的 Switchboard preset 会话里挂载。
      //       再加一道隐藏的全局闸门，只增加了状态与失败面，没有增加判断力。
      //
      //    取舍说明：「会执行本机命令」这件事的可控性现在依赖两点 —— 角色的 `backend`
      //    必须被显式设为 `cli`，且该角色只在 Switchboard preset 会话里存在。这比一个
      //    看不见的全局开关更容易理解和审计。
      wrapperProvider: z.string().description('统一包裹外部 CLI 角色的 LLM route；留空继承父代理路由，仅对 CLI 角色生效'),
      wrapperModel: z.string().description('统一包裹外部 CLI 角色的模型（非外部 CLI 模型）；留空继承父代理模型，仅对 CLI 角色生效'),
      wrapperEffort: z.string().description(`统一包裹外部 CLI 角色的思考强度；留空时不指定思考强度：包裹子代理最终使用的 Provider 和模型均与父代理一致时，沿用父代理当前强度；否则按目标模型的默认设置处理。父代理未指定强度时，也按模型默认设置处理。可选 ${EFFORT_VALUES.join(' / ')}，仅对 CLI 角色生效`),
    })
    .default({})
    .volatile(),
  /** 角色默认使用的 LLM route provider；角色自身可用 provider 覆盖。 */
  provider: z.string().description('角色默认 LLM provider'),
  /** 第一层之外的额外深度预算；与目标角色的出站派发权限无关。 */
  maxDepth: z.number().step(1).min(0).default(3).description('第一层之外的额外深度预算：0 允许绝对深度 1，1 允许深度 1～2，3 允许深度 1～4；叶子角色同样可在预算内被调用'),
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
        // 保留字符串以读入旧 custom；执行前必须与下面四个字段及 readOnly 一致。
        cliDriver: z.string().description('所选 CLI 预设（codex / grok）；旧配置仅无损识别，否则该角色待迁移并阻止启动'),
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
    .default(undefined)
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
  // ⚠️ 服务一律走 `get()`：generation / private / extended ctx **没有声明 inject**，
  //    在它们上面做 `ctx.subprocess` 直接属性访问会抛
  //    `cannot get property "subprocess" without inject`（本族缺陷的真机表现）。
  const subprocess = typeof ctx.get === 'function' ? ctx.get('subprocess') : ctx.subprocess;
  if (!subprocess || typeof subprocess.spawn !== 'function') {
    throw new Error('subprocess.spawn 不可用：没有挂载 subprocess 服务实现');
  }
  return subprocess.spawn(spec);
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
export function selftestTool(ctx, diagnostics) {
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
          `明细（当前挂载状态）：${value.mounted}`,
          // 明细保留首次核验失败的信息；实时恢复后标注「曾延迟注册」，不再判为失败。
          `实时工具查询：${value.liveTools}`,
          `preset roster：${value.presetRoster}`,
          `preset 异常行：${value.presetBroken}`,
          `settings 命名空间：${value.settingsNamespaces}`,
          `roleConfig 状态：${value.roleConfigStatus}`,
          `CLI 专属工具：${value.providers}`,
          `CLI 可执行文件：${value.executables}`,
          // 「跨 CLI 总开关」已移除，因此这里不再是「因开关未挂载」，而是
          // 「因预设兼容性或执行一致性校验被拦下」。
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
      // 「工具到底在不在」本来就可以当场查到（`ctx.get('tools').get(name, scopeOf(ctx))`），
      // 因此实时结果决定当前健康；快照只解释仍缺失的角色或曾延迟注册的历史。
      // 根实例只报告配置数量，不负责挂载，也不把配置角色当作应当可见的工具。
      const live = diagnostics.mountHere ? liveRoleTools(ctx, diagnostics.configuredRoles) : [];
      // 快照仅解释历史，当前健康与挂载数量只能由实时查询证明。
      const mounted = live;
      const okCount = mounted.filter((m) => m.ok).length;

      return {
        ok:
          diagnostics.fatal === undefined &&
          diagnostics.configErrors.length === 0 &&
          !diagnostics.wrapperSyncPending &&
          // 不可查询也逐角色返回失败；零角色不要求工具服务可查询。
          !mounted.some((m) => m.ok === false),
        phase: 'phase-3',
        roleCount: okCount,
        mounted:
          !diagnostics.mountHere
            ? `（本作用域不挂载角色工具；配置中有 ${diagnostics.configuredRoleCount} 个角色）`
            : mounted.length === 0
              ? diagnostics.configuredRoleCount === 0
                ? '（本插件尚未配置任何角色）'
                : '（角色配置非法，未挂载任何角色工具）'
              : mounted.map((m) => {
                  const snapshot = diagnostics.mounts.find((entry) => entry.id === m.id);
                  const initial = snapshot?.ok === false ? snapshot : undefined;
                  if (m.ok) {
                    return `${m.id}=OK${live.length > 0 && initial ? `（曾延迟注册：${initial.detail}）` : ''}`;
                  }
                  const history = m.unverified && snapshot
                    ? `；历史快照：${snapshot.ok ? '成功' : '失败'}(${snapshot.detail})`
                    : initial ? `；首次核验：${initial.detail}` : '';
                  return `${m.id}=失败(${m.detail}${history})`;
                }).join(' '),
        liveTools:
          !diagnostics.mountHere
            ? '（本作用域不挂载角色工具）'
            : live.length === 0
              ? '（本作用域查不到角色工具）'
              : live.map((m) => `${m.id}=${m.unverified ? `未核实(${m.detail})` : m.ok ? 'OK' : '缺失'}`).join(' '),
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
          ...(diagnostics.wrapperSyncPending ? ['包裹路由=根设置尚未桥接（文件创建未成功，不能宣称已生效）'] : []),
          ...(diagnostics.deprecatedConfig ? [`弃用=${diagnostics.deprecatedConfig}`] : []),
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
 * @param {number} maxDepth - 第一层之外的额外层数。
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
 * 因此这里注册后通过 `ctx.get('tools')` 按注册时的 scope **核实工具名是否真的出现**。`undefined` 一律
 * 视为首次核验失败：宁可如实记录暂未出现，也不要报 OK 而实际没有；后续健康由自检实时查询判定。
 *
 * @param {object} ctx - Cordis 上下文。
 * @param {object} role - 规范化后的角色。
 * @param {object} toolModule - 已 import 的 `dsh-tool-subagent` 模块。
 * @param {number} maxDepth - 允许嵌套时的额外层数。
 * @returns {Promise<{ok: boolean, detail: string}>} 挂载结果。
 */
function mountedRoleOptions(ctx, roles, maxDepth) {
  ctx = ctx[publicContextKey] ?? ctx;
  const tools = ctx.get('tools');
  const scope = scopeOf(ctx);
  return {
    maxDepth,
    availableToolNames: tools.schemas(scope).map((tool) => tool.name),
    delegateToolNames: roles.filter((role) => tools.get(role.toolName, scope) != null).map((role) => role.toolName),
  };
}

async function mountRoleTool(ctx, role, toolModule, maxDepth, roles, wrapperRoute) {
  if (typeof ctx.plugin !== 'function') {
    return { ok: false, detail: 'ctx.plugin 不可用' };
  }
  try {
    // Cordis 的 Config 校验会物化 getter；在 apply 之后恢复运行时读取。
    // 派发时才枚举当前作用域：后挂载、注册失败或已卸载的工具不能靠配置名假定存在。
    const liveConfig = (base) => ({
      ...base,
      get persona() { return toolConfigFor(role, mountedRoleOptions(ctx, roles, maxDepth)).persona; },
      get toolFilter() { return toolConfigFor(role, mountedRoleOptions(ctx, roles, maxDepth)).toolFilter; },
    });
    const fiber = ctx.plugin({
      ...toolModule,
      apply: (toolCtx, config) => toolModule.apply(
        ctx[generationKey] ? ctx[generationKey].runtime(toolCtx, role) : toolCtx,
        liveConfig(config)),
    }, liveConfig(toolConfigFor(role, { maxDepth, wrapperRoute })));
    ctx[generationKey]?.fibers.push(fiber);
    if (typeof fiber?.await === 'function') await fiber.await();
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }

  // 给 fiber 两个微任务的激活机会，再记录首次核验快照；注入/provider 可能稍后才就绪。
  // 此处失败不代表永久失败，自检以调用时的实时注册表为准。
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
    registered = tools.get(role.toolName, scopeOf(ctx));
  } catch (error) {
    return {
      ok: false,
      detail: `核实注册时抛错：${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (registered === undefined || registered === null ||
    (ctx[generationKey] && !ctx[generationKey].definitions.has(role.toolName))) {
    return {
      ok: false,
      detail: '工具尚未出现在工具注册表中（可能等待注入/provider 就绪，或 fiber 装载失败；见 Host 日志）',
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

  // 每个根/preset 激活一份独立记录；preset 常驻，会话只继承它。共享模块级状态
  // 会让后一次激活清空前一次的记录（实测出现自相矛盾的自检输出）。
  const diagnostics = newDiagnostics();
  noteLegacyTimeout(resolved, diagnostics);
  noteLegacyWrapper(resolved, diagnostics);

  // 说明：这里刻意**不**报告「本插件处于哪个 preset 作用域」。
  // `agentPresets.composedPreset(ctx)` 是从传入的上下文向上找最近的 preset 挂载，
  // 而 apply 运行在根上下文，用它必然返回 undefined —— 那是假信号，与 preset 是否
  // 生效无关（详见 docs/architecture.md 3.1d 第 22 条）。
  // 「只在选中本插件 preset 的会话里生效」由 preset 机制本身保证，无需探测。
  console.error(`[${name}] 激活（配置字段：${Object.keys(resolved).join(', ') || '空'}）`);

  // 自检工具总是注册：即使角色配置全错，也要能用它看到错在哪。
  const disposeSelftest = ctx.tools.register(selftestTool(ctx, diagnostics));

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
  // scope 视图会继承祖先层的工具；无 scope 查询只看 global，不能用来判断子代理
  // 是否可见父作用域工具，也不能作为防止重复挂载的机制。`mountRoleTool` 只核实
  // 当前 scope 的可见性，是否挂载仍由 `mount` 决定。
  const mountHere = readVolatileField(resolved, 'mount') === true;
  diagnostics.mountHere = mountHere;

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
    // volatile 更新可能被 Loader 就地处理，不触发重新 apply；先注册保证非法初值可恢复。
    const sync = (updated, syncDepth = false) => {
      const wrapper = wrapperRouteFrom(updated);
      diagnostics.configErrors = diagnostics.configErrors.filter((error) => !error.startsWith('volatile.wrapper'));
      if (wrapper.errors.length > 0) {
        diagnostics.configErrors.push(...wrapper.errors);
        for (const error of wrapper.errors) console.error(`[${name}] ${error}`);
      } else {
        // 非数组 roles 是非法输入，整次同步不得写盘（包括包裹字段）。
        if (syncRolesToFile({ resolved: updated, roleConfigPath, diagnostics, syncDepth }) !== false) {
          syncWrapperRouteToFile(updated, roleConfigPath, diagnostics);
          const saved = readRoleConfigFile(roleConfigPath);
          if (saved.ok && !saved.missing && !diagnostics.wrapperSyncError) {
            ctx.emit?.('agent-switchboard/config-changed', { roleConfigPath });
          }
        }
      }
    };
    // internal/update 的特殊注册不自动进入 effect；显式归属本次激活的释放范围。
    if (ctx.on) ctx.effect(() => ctx.on('internal/update', (updated, _noSave, next) => {
      sync(updated, true);
      return next();
    }));
    sync(resolved);
    return;
  }

  mountRolesInThisScope(ctx, { roleConfigPath, resolved, diagnostics, disposeSelftest });
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
function syncRolesToFile({ resolved, roleConfigPath, diagnostics, syncDepth = false }) {
  const cordisRoles = readVolatileField(resolved, 'roles');
  const current = readRoleConfigFile(roleConfigPath);
  diagnostics.roleConfigRead = current.detail;
  if (current.ok) noteLegacyTimeout(current.value, diagnostics);
  if (current.ok) noteLegacyWrapper(current.value, diagnostics);
  // `undefined` 表示配置对象没有提供 roles，必须保留文件；数组（包括 []）表示
  // 显式提交，空数组也必须写回，不能把「未提供」误当成「清空」。
  const providedRoles = cordisRoles !== undefined;
  if (providedRoles && !Array.isArray(cordisRoles)) {
    diagnostics.configuredRoleCount = 0;
    diagnostics.configuredRoles = [];
    diagnostics.configErrors = ['roles 必须是数组（undefined 表示未提供）'];
    diagnostics.roleConfigSync = 'roles 非法，未同步';
    console.error(`[${name}] ${diagnostics.configErrors[0]}`);
    return false;
  }
  const rawRoles = providedRoles ? cordisRoles : current.ok ? current.value.roles : [];
  diagnostics.configuredRoleCount = rawRoles.length;
  const { roles, errors } = normalizeRoles(rawRoles,
    (current.ok && current.value.provider) || resolved.provider,
    (current.ok && current.value.cwd) || resolved.cwd);
  diagnostics.configuredRoles = roles.map((r) => ({ id: r.id, toolName: r.toolName,
    ...(r.backend === CLI_BACKEND ? { cliToolName: cliToolName(r.id) } : {}) }));
  diagnostics.configErrors = errors;
  const depth = syncDepth ? readVolatileField(resolved, 'maxDepth') : undefined;
  const depthChanged = depth !== undefined && current.ok && current.missing !== true && current.value.maxDepth !== depth;
  if (!providedRoles && !depthChanged) {
    // 未提供 roles 不改动文件；读取失败不能被缺省值覆盖。
    if (!current.ok) diagnostics.configErrors.push(current.detail);
    diagnostics.roleConfigSync =
      !current.ok
        ? `根条目无角色（未提供 roles）；文件读取失败，未同步：${current.detail}`
        : current.missing === true
          ? '根条目无角色（未提供 roles），文件尚未创建 —— 等待 UI 写入'
          : `根条目无角色（未提供 roles）；文件已有 ${current.value.roles.length} 个，保持不变`;
    console.error(`[${name}] ${diagnostics.roleConfigSync}`);
    return;
  }

  // 与文件比对后再写，避免每次启动都做一次无意义写盘。
  if (current.ok && current.missing !== true) {
    const same = JSON.stringify(current.value.roles) === JSON.stringify(cordisRoles);
    if (same && !depthChanged) {
      diagnostics.roleConfigSync = `文件已与配置一致（${cordisRoles.length} 个），未重写`;
      return;
    }
  }

  const existing = current.ok && current.missing !== true ? current.value : {};
  // 以现有文件为基底只替换 roles：未知顶层字段与 formatVersion 都必须原样保留；
  // volatile 也整体保留，继续沿用既有的包裹路由/兼容字段语义。
  const writtenValue = current.ok && current.missing !== true
    ? { ...existing, roles: rawRoles, ...(depth === undefined ? {} : { maxDepth: depth }) }
    : initialConfig(rawRoles, {
      provider: resolved.provider,
      cwd: resolved.cwd,
      maxDepth: resolved.maxDepth,
    });
  const written = writeConfigFile(roleConfigPath, writtenValue);
  diagnostics.roleConfigSync = written.ok
    ? `已把 ${rawRoles.length} 个角色从配置同步到文件`
    : `同步失败：${written.error}`;
  // 成功同步可修复本次的读取失败；只把当前写入失败加入健康门禁，不锁存历史。
  if (!written.ok) diagnostics.configErrors.push(diagnostics.roleConfigSync);
  console.error(`[${name}] ${diagnostics.roleConfigSync}`);
  return written.ok;
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
function mountRolesInThisScope(ctx, { roleConfigPath, resolved, diagnostics, disposeSelftest }) {
  let current;
  let committed = false;
  let revision = 0;
  let running = false;
  let closed = false;
  const generations = new Set();
  // 身份不来自模型参数；仅接受本实例为该角色启动并返回的真实 localAgent。
  const wrappers = new WeakMap();
  const cliEntries = new Map();
  const dispose = value => typeof value === 'function' ? value() : value?.dispose();
  const report = error => {
    const detail = error instanceof Error ? error.message : String(error);
    const initial = !committed;
    diagnostics.configErrors = [`${initial ? '初始挂载失败' : '热重载失败，保留上一代'}：${detail}`];
    if (initial) diagnostics.fatal = diagnostics.configErrors[0];
    console.error(`[${name}] ${diagnostics.configErrors[0]}`);
  };
  const release = generation => {
    if (!generation.retired || generation.active !== 0 || generation.released) return;
    generation.released = true;
    for (const entry of cliEntries.values()) {
      entry.generations.delete(generation);
      if (entry.generations.size === 0) {
        dispose(entry.dispose);
        cliEntries.delete(entry.name);
      }
    }
    generations.delete(generation);
    Promise.resolve(generation.scope.dispose()).catch(report);
  };
  const lease = generation => {
    generation.active++;
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      generation.active--;
      release(generation);
    };
  };
  const registerPublic = (generation, definition) => {
    if (definition.name.startsWith('switchboard_cli_run_')) {
      let entry = cliEntries.get(definition.name);
      if (!entry) {
        const publicTool = { ...definition, async execute(args, exec) {
          const bound = wrappers.get(exec?.agent);
          if (!bound?.tool || bound.tool.name !== definition.name || bound.generation.released) {
            throw new Error('CLI 包裹身份不匹配；请通过对应 delegate_to_* 工具重新派发');
          }
          const done = lease(bound.generation);
          try { return await bound.tool.execute(args, exec); } finally { done(); }
        } };
        entry = { name: definition.name, generations: new Set(), dispose: ctx.tools.register(publicTool) };
        cliEntries.set(definition.name, entry);
      }
      entry.generations.add(generation);
      return;
    }
    const publicTool = { ...definition, async execute(args, exec) {
      const done = lease(generation);
      try { return await definition.execute(args, exec); } finally { done(); }
    } };
    generation.publicDisposers.set(definition.name, ctx.tools.register(publicTool));
  };
  const prepare = async initial => {
    const generation = { active: 0, retired: false, released: false, initial,
      definitions: new Map(), privateDisposers: new Map(), publicDisposers: new Map(), fibers: [], roles: [], maxDepth: 3 };
    // 保留本作用域服务隔离与拦截，但私有 Fiber 归根所有，避免实例卸载隐式拆毁在途环境。
    // 实例 teardown 退休全部代际，release 在租约归零后显式释放；应用根卸载仍会整体拆毁。
    const ownerCtx = ctx.root?.fiber ? ctx.extend({ fiber: ctx.root.fiber }) : ctx;
    generation.scope = createScope(ownerCtx, {}, { parent: scopeOf(ctx) });
    generations.add(generation);
    const privateCtx = generation.scope.ctx;
    // ⚠️ 新建 scope 的 ctx **没有声明 inject**：在它上面做服务属性访问会抛
    //    `cannot get property "tools" without inject`（本项目在 jobs 上踩过同类坑）。
    //    服务会沿作用域向下继承，所以这里用免声明的 `get()` 解析。
    try {
      const privateTools = privateCtx.get('tools');
      if (!privateTools) throw new Error('私有 scope 解析不到 tools 服务；本代角色工具无法挂载');
      const tools = Object.create(privateTools);
      tools.register = definition => {
        const undo = privateTools.register(definition);
        generation.definitions.set(definition.name, definition);
        // 首次装载仍允许 provider 延迟就绪；替换代必须全部准备成功后才公开。
        if (generation === current && !generation.retired) registerPublic(generation, definition);
        const unregister = () => {
          dispose(undo);
          if (generation.definitions.get(definition.name) !== definition) return;
          generation.definitions.delete(definition.name);
          generation.privateDisposers.delete(definition.name);
          dispose(generation.publicDisposers.get(definition.name));
          generation.publicDisposers.delete(definition.name);
        };
        generation.privateDisposers.set(definition.name, unregister);
        return unregister;
      };
      generation.runtime = (toolCtx, role) => {
        // 影子对象只用于替换 `start` 这一个方法；**内层必须打到真实服务**，否则自我递归。
        // 沿用 :1084 的教训：在新建/扩展 ctx 上避免直接属性访问。
        const realSubagents = toolCtx.get('subagents');
        const subagents = Object.create(realSubagents);
        subagents.start = async (provider, request) => {
          const done = lease(generation);
          try {
            const run = await realSubagents.start(provider, request);
            if (role.backend === CLI_BACKEND && run.localAgent) {
              wrappers.set(run.localAgent, { generation, tool: generation.definitions.get(cliToolName(role.id)) });
            }
            // 保留启动及结果租约，不调用 run.dispose、不触碰 signal。
            Promise.resolve(run.result).then(done, done);
            return run;
          } catch (error) { done(); throw error; }
        };
        return toolCtx.extend({ tools, subagents, get(key) {
          if (key === 'tools') return tools;
          const service = toolCtx.get(key);
          if (key !== 'jobs' || !service) return service;
          const jobs = Object.create(service);
          jobs.start = spec => {
            // 从 Job 入队开始持有，覆盖延迟 run；不改变 owner/cancel/结算策略。
            const done = lease(generation);
            try {
              return service.start({ ...spec, run(job) {
                try {
                  const hooks = spec.run(job);
                  Promise.resolve(hooks.done).then(done, done);
                  return hooks;
                } catch (error) { done(); throw error; }
              } });
            } catch (error) { done(); throw error; }
          };
          return jobs;
        } });
      };
      const buildCtx = privateCtx.extend({ tools, [publicContextKey]: ctx, [generationKey]: generation,
        get(key) { return key === 'tools' ? tools : privateCtx.get(key); } });
      const nextDiagnostics = newDiagnostics();
      nextDiagnostics.mountHere = true;
      nextDiagnostics.roleConfigPath = roleConfigPath;
      if (initial) current = generation;
      await buildRoleGeneration(buildCtx, { roleConfigPath, resolved: { ...resolved },
        diagnostics: nextDiagnostics, generation });
      if (initial && nextDiagnostics.configErrors.length) {
        nextDiagnostics.fatal = `初始挂载失败：${nextDiagnostics.configErrors.join('；')}`;
      }
      if (!initial && (nextDiagnostics.configErrors.length || nextDiagnostics.blocked.length || nextDiagnostics.fatal ||
        nextDiagnostics.mounts.some(mount => !mount.ok))) {
        throw new Error([...nextDiagnostics.configErrors, ...nextDiagnostics.blocked.map(item => item.reason),
          nextDiagnostics.fatal, ...nextDiagnostics.mounts.filter(item => !item.ok).map(item => item.detail)].filter(Boolean).join('；'));
      }
      generation.diagnostics = nextDiagnostics;
      return generation;
    } catch (error) {
      generation.retired = true;
      release(generation);
      throw error;
    }
  };
  const replace = generation => {
    const previous = current;
    // 短同步提交段：旧 Fiber 不销毁，任何入口注册失败均恢复旧入口。
    for (const undo of previous?.publicDisposers.values() ?? []) dispose(undo);
    previous?.publicDisposers.clear();
    try {
      for (const definition of generation.definitions.values()) registerPublic(generation, definition);
    } catch (error) {
      for (const undo of generation.publicDisposers.values()) dispose(undo);
      generation.publicDisposers.clear();
      if (previous) for (const definition of previous.definitions.values()) {
        if (!definition.name.startsWith('switchboard_cli_run_')) registerPublic(previous, definition);
      }
      generation.retired = true;
      release(generation);
      throw error;
    }
    current = generation;
    Object.assign(diagnostics, generation.diagnostics);
    committed = true;
    if (previous && previous !== generation) { previous.retired = true; release(previous); }
  };
  const reload = async () => {
    if (running || closed) return;
    running = true;
    try {
      while (!closed) {
        const wanted = revision;
        let generation;
        try {
          generation = await prepare(current === undefined);
          if (closed || wanted !== revision) {
            generation.retired = true;
            if (current === generation) current = undefined;
            for (const undo of generation.publicDisposers.values()) dispose(undo);
            generation.publicDisposers.clear();
            release(generation);
          } else replace(generation);
        } catch (error) { report(error); }
        if (wanted === revision) break;
      }
    } finally { running = false; }
  };
  const disposeGuidance = ctx.systemPrompt.section({ name: 'agent-switchboard:roles', order: 10500,
    text: () => current ? roleGuidanceText(current.roles, mountedRoleOptions(ctx, current.roles, current.maxDepth)) : '' });
  const disposeListener = ctx.on?.('agent-switchboard/config-changed', payload => {
    if (payload?.roleConfigPath !== roleConfigPath || closed) return;
    revision++;
    void reload();
  });
  ctx.effect?.(() => () => {
    closed = true;
    dispose(disposeListener);
    dispose(disposeGuidance);
    dispose(disposeSelftest);
    for (const generation of generations) {
      for (const undo of generation.publicDisposers.values()) dispose(undo);
      generation.publicDisposers.clear();
      generation.retired = true;
      release(generation);
    }
  });
  void reload();
}

function buildRoleGeneration(ctx, { roleConfigPath, resolved, diagnostics, generation }) {

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
  if (fromFile.ok) noteLegacyTimeout(fromFile.value, diagnostics);
  if (fromFile.ok) noteLegacyWrapper(fromFile.value, diagnostics);
  // 只校验有效来源：文件有任一包裹字段即整个路由对象优先（含空值），不逐字段合并。
  // 被覆盖的 preset 路由不校验；角色仍保持本作用域优先。
  const hasRootRoute = fromFile.ok && ['wrapperProvider', 'wrapperModel', 'wrapperEffort']
    .some((key) => Object.hasOwn(fromFile.value.volatile ?? {}, key));
  const wrapper = wrapperRouteFrom(hasRootRoute ? fromFile.value : resolved);
  if (wrapper.errors.length > 0) {
    diagnostics.configErrors = wrapper.errors;
    for (const error of wrapper.errors) console.error(`[${name}] ${error}`);
    return;
  }
  const fromCordis = readVolatileField(resolved, 'roles');
  const cordisRoles = fromCordis;
  diagnostics.roleConfigRead =
    `${fromFile.detail}；本作用域 Cordis 配置里 roles=${Array.isArray(cordisRoles) ? cordisRoles.length : cordisRoles === undefined ? '未提供' : '非法'} 个`;

  // 非数组不得静默当空或回落文件；与根同步边界采用同一三分支判据。
  if (cordisRoles !== undefined && !Array.isArray(cordisRoles)) {
    diagnostics.configErrors = ['roles 必须是数组（undefined 表示未提供）'];
    console.error(`[${name}] ${diagnostics.configErrors[0]}`);
    return;
  }
  // `undefined` 表示本作用域未提供 roles，才允许回落文件；显式 [] 表示清空，不能复活旧角色。
  const rawRoles = cordisRoles === undefined
    ? fromFile.ok ? fromFile.value.roles : []
    : cordisRoles;
  diagnostics.configuredRoleCount = rawRoles.length;
  const defaults = {
    provider: (fromFile.ok && fromFile.value.provider) || resolved.provider,
    cwd: (fromFile.ok && fromFile.value.cwd) || resolved.cwd,
  };
  const fileDepth = fromFile.ok ? fromFile.value.maxDepth : undefined;
  const maxDepth = Number.isInteger(fileDepth) && fileDepth >= 0 ? fileDepth
    : typeof resolved.maxDepth === 'number' ? resolved.maxDepth : 3;
  generation.maxDepth = maxDepth;
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
  generation.roles = roles;
  diagnostics.configErrors = errors;
  // 记录「本作用域配置了哪些角色」——自检在解析不出工具时据此说明原因，
  // 而不是含糊地报「工具未出现在工具注册表中」。
  diagnostics.configuredRoles = roles.map((r) => ({ id: r.id, toolName: r.toolName,
    ...(r.backend === CLI_BACKEND ? { cliToolName: cliToolName(r.id) } : {}) }));
  if (errors.length > 0) {
    // 配置有错时不挂载任何角色工具：半挂载会让主代理看到一批语义不明的工具。
    console.error(`[${name}] 角色配置有 ${errors.length} 处错误，未挂载任何角色工具：`);
    for (const line of errors) console.error(`[${name}]   - ${line}`);
    return;
  }
  if (roles.length === 0) return;

  // 角色工具的宿主描述无法区分角色；路由指引由实例级动态 section 提供，
  // 这里只准备代际配置，不重复注册 guidance 或 tools/change 监听。

  const { active: activeCliRoles, blocked: blockedCliRoles } = planCliMounts(roles);

  // 专属工具先注册在 preset 层，子代理继承可见性；execute 仍拒绝主代理直调。
  // 两个工具使用同一挂载计划，任何注册失败都阻止该角色的委派工具挂载。
  const failedCliTools = [];
  if (blockedCliRoles.length > 0) {
    diagnostics.blocked = blockedCliRoles;
    console.error(
      `[${name}] ${blockedCliRoles.length} 个 CLI 角色未挂载：` +
        blockedCliRoles.map((b) => `${b.id}(${b.reason})`).join(', '),
    );
  }

  for (const role of activeCliRoles) {
    try {
      const tool = createCliTool({
        role,
        ctx,
        spawn: (spec) => safeSpawn(ctx, spec),
        resolveExecutable: async (command, env, signal) => {
          // 同 safeSpawn：generation ctx 未声明 inject，必须走 get()。
          try {
            const subprocess = ctx.get('subprocess');
            if (!subprocess || typeof subprocess.resolveExecutable !== 'function') {
              throw new Error('subprocess.resolveExecutable 不可用：没有挂载 subprocess 服务实现');
            }
            const path = await subprocess.resolveExecutable(command, env, signal);
            diagnostics.executables.splice(0, diagnostics.executables.length,
              ...diagnostics.executables.filter(item => item.id !== role.id));
            diagnostics.executables.push({ id: role.id, command, resolved: path, ok: true });
            return path;
          } catch (error) {
            const detail = `本次未解析可执行文件，执行器将尝试配置命令：${error instanceof Error ? error.message : String(error)}`;
            diagnostics.executables.splice(0, diagnostics.executables.length,
              ...diagnostics.executables.filter(item => item.id !== role.id));
            diagnostics.executables.push({ id: role.id, command, ok: false, detail });
            console.error(`[${name}] CLI 角色 "${role.id}"：${detail}`);
            throw error;
          }
        },
      });
      ctx.get('tools').register(tool);
      if (ctx.get('tools')?.get(tool.name, scopeOf(ctx)) == null || !generation.definitions.has(tool.name)) {
        throw new Error(`专属 CLI 工具未注册：${tool.name}`);
      }
      diagnostics.providers.push({ id: role.id, name: tool.name, ok: true, detail: '已注册专属工具' });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      failedCliTools.push({ id: role.id, reason: detail });
      diagnostics.providers.push({ id: role.id, name: cliToolName(role.id), ok: false, detail });
      console.error(`[${name}] CLI 工具 "${role.id}" 注册失败：${detail}`);
    }
  }
  diagnostics.blocked.push(...failedCliTools);

  // CLI 角色的**装载期**校验：把「命令根本不存在」这类问题在启动时就报出来，
  // 而不是等第一次派发。解析失败不阻断装载（可能依赖运行期 PATH），只作为诊断。
  for (const role of activeCliRoles) {
    Promise.resolve()
      .then(() => {
        // 同 safeSpawn：generation ctx 未声明 inject，必须走 get()。
        const subprocess = ctx.get('subprocess');
        if (!subprocess || typeof subprocess.resolveExecutable !== 'function') {
          throw new Error('subprocess.resolveExecutable 不可用：没有挂载 subprocess 服务实现');
        }
        return subprocess.resolveExecutable(role.cli.command, role.cli.env);
      })
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
  return import('@deepseek-ai/dsh-tool-subagent')
    .then(async (toolModule) => {
      for (const role of roles) {
        // 预设不合法或专属工具注册失败时，该角色不可派发。
        const blocked = [...blockedCliRoles, ...failedCliTools].find((b) => b.id === role.id);
        if (blocked) {
          diagnostics.mounts.push({
            id: role.id,
            ok: false,
            detail: `${blocked.reason}，故未挂载（专属 CLI 工具不可用）`,
          });
          continue;
        }
        // `mountRoleTool` 会核实工具是否真的注册成功（见其 JSDoc）。
        const outcome = await mountRoleTool(ctx, role, toolModule, maxDepth, roles, wrapper.route);
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
