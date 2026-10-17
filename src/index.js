/**
 * Agent Switchboard 的 Host 半边。
 *
 * 职责：把「角色」变成主代理可用的委派工具。
 *
 * 设计要点（依据见 docs/decisions.md）：
 *   - 根 Config 经 loader/volatile-update 持久化到文件；工具骨架只注册一次，执行期现读角色配置。
 *     增删角色仍需改变工具集；Host 源码改动仍需重启一次装载。
 *   - 角色级固定 model / effort（D12），主代理无权覆盖。
 *   - `readOnly` 通过**角色自己的 Agent Preset** 落地：preset 插件清单里直接不给
 *     写入类行，并把 `dsh-tool-fs` 的 write/edit 关掉。这是**工具级**约束而非沙箱级，
 *     因为 `SubagentStartRequest` 没有沙箱字段（已核实），且旧版的 `toolFilter`
 *     已被 DSH 0.2.1-rc.1 删除（见 src/role-presets.js）。
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
import { scopeOf } from '@deepseek-ai/dsh-scope';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  CLI_BACKEND,
  EFFORT_VALUES,
  cliToolName,
  mergeRoleLayers,
  normalizeRoles,
  planCliMounts,
  roleGuidanceText,
  routeSummaryFor,
  toolConfigFor,
} from './roles.js';
import { createCliTool } from './cli/provider.js';
import { buildRolePresets } from './role-presets.js';
import { CONFIG_FORMAT_VERSION, configPathFor, readConfigFileDetailed, createConfigFileResolver, writeConfigFile, initialConfig } from './config-file.js';

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
  const detailed = readConfigFileDetailed(path);
  const read = { ...detailed, value: detailed.config };
  if (!read.ok) {
    return { ok: false, format: read.format, detail: `角色配置文件无法读取（${path}）：${read.error}` };
  }
  if (read.missing) {
    // 「文件不存在」不是错误：用户还没配过角色。如实说明，不冒充成功。
    return { ok: true, missing: true, value: { roles: [] }, detail: `尚未创建角色配置文件（${path}）` };
  }
  return { ok: true, format: read.format, value: read.value, detail: `已从 ${path} 读取 ${read.value.roles.length} 个角色${read.format.reason ? `；${read.format.reason}` : ''}` };
}

let pluginPackage;
let packageWarning = '';
try {
  pluginPackage = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
} catch (error) {
  packageWarning = `插件包元数据读取失败，版本未知（manifest=0 表示未知）：${error.message ?? error}`;
  console.error(`[agent-switchboard] ${packageWarning}`);
}
const pluginVersion = typeof pluginPackage?.version === 'string' ? pluginPackage.version : '未知';
// 保持自检 number 契约；0 是未知哨兵，告警明确说明缺失。
const manifestVersion = Number.isSafeInteger(pluginPackage?.dsh?.manifestVersion)
  ? pluginPackage.dsh.manifestVersion : 0;
if (!packageWarning && (pluginVersion === '未知' || manifestVersion === 0)) {
  packageWarning = '插件包元数据不完整，插件版本或 manifestVersion 未知（manifest=0 表示未知）';
  console.error(`[agent-switchboard] ${packageWarning}`);
}
// 未核实公开宿主版本 accessor；不能以组件版本推测宿主版本。
const dshRuntimeVersionReason = '未核实可靠的宿主版本接口或可解析的宿主包版本；不以 DSH 组件版本推测运行时版本';

/** Loader 条目名，与 package.json 的 `name` 保持一致。 */
export const name = 'agent-switchboard';

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
    fail(`拒绝写入包裹路由配置；${current.detail}`);
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
    /** 已注册的角色 preset（`{id, rows, ok}`）；角色 persona 与工具构成的承载点。 */
    presets: [],
    executables: [],
    blocked: [],
    /** 本作用域解析出的角色（`{id, toolName}`）。用于自检在「本作用域不挂载工具」时说清原因。 */
    configuredRoles: [],
    /** normalization 前的角色数量；非法配置也不能被误报为零角色。 */
    configuredRoleCount: 0,
    /** 本实例是否负责挂载；配置角色数与工具挂载状态分别记录。 */
    mountHere: false,
    /**
     * 现读角色配置是否已偏离已注册的组合。
     *
     * 0.2.1-rc.1 起 `instructions` / `readOnly` / `allowNestedDispatch` 属**组合期**事实；
     * 热同步会在下次派发前重建，因此这里描述的是「还没重建」这一瞬态。
     */
    compositionStale: false,
    /** 最近一次组合热同步成功的时间（ISO 字符串）；从未同步则为 undefined。 */
    compositionRefreshedAt: undefined,
    /** 组合热同步失败的原因；此时派发沿用上一版组合。 */
    compositionRefreshError: undefined,
    /** 由挂载作用域注入：当场计算组合是否偏离（自检用它，而不是读快照）。 */
    compositionDrift: undefined,
    roleConfigPath: undefined,
    roleConfigRead: undefined,
    roleConfigSync: undefined,
    deprecatedConfig: '',
    fatal: undefined,
  };
}

/**
 * 在**调用方作用域**实时查询角色工具是否真的可用。
 *
 * 为什么不读 `diagnostics.mounts`：那是 `import(...).then(...)` 异步写入的快照，
 * `apply` 返回时往往还是空的；而且同一插件会被多次激活（根条目 + 各 preset 会话），
 * 在某个作用域读到的快照未必对应当前作用域。**「工具在不在」本来就能当场查到。**
 *
 * ⚠️ **必须按调用它的 agent 查询，不能按注册自检的那个作用域查询。**
 *    0.2.1-rc.1 起委派工具由官方插件在**每个 agent 自己的作用域**里装载
 *    （`agentPresets` 站立组合按 `agent/created` 逐个安装），而自检注册在 preset 作用域。
 *    拿 preset 作用域去查会一律查不到，于是报告「0 个角色 / 工具未注册 / 不健康」——
 *    而派发其实是好的。这正是本项目反复踩到的「诊断在骗人」，必须避免。
 *
 * ⚠️ 专属 CLI 工具**不再**由调用方作用域承载：它现在挂在**角色自己的 preset 作用域**里
 *    （工具按作用域可见、不跨 preset 继承）。因此这里不再把它当作本作用域的失败条件，
 *    只在已挂载时如实标注它的承载位置。
 *
 * @param {object} ctx - Cordis 上下文。
 * @param {{id: string, toolName: string}[]} roles - 本作用域配置的角色。
 * @param {object} [viewer] - 查询视角（通常是调用自检的 agent）；省略时退回本作用域。
 * @returns {{id: string, ok: boolean, detail: string, unverified?: boolean}[]} 实时结果；零角色返回空数组，不可查询逐角色标记未核实。
 */
export function liveRoleTools(ctx, roles, viewer) {
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
  const scope = viewer ?? scopeOf(ctx);
  return roles.map((role) => {
    let found;
    let cliFound = true;
    try {
      found = tools.get(role.toolName, scope);
      // 专属 CLI 工具在**本 preset 作用域**注册（角色 preset 里另有一份给子代理用），
      // 因此从主代理视角仍可核实；查不到就是真的没注册上。
      if (role.cliToolName) cliFound = tools.get(role.cliToolName, scope) != null;
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
  // 仅 preset 条目承载，不设默认值、不标 volatile、不开放设置页编辑。
  supervisorRules: z.string().description('主代理调度规则（由 preset 生成）'),
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
  /**
   * 角色子代理作用域专用：在本作用域注册这些角色的专属 CLI 工具。
   *
   * 由插件自动生成的角色 preset 写入（见 src/role-presets.js）。工具按作用域可见，
   * 而角色子代理挂载的是**自己的** preset，所以专属 CLI 工具必须挂在它自己的作用域里，
   * 否则子代理看不见它。设了这个字段的作用域**只**注册这些 CLI 工具。
   */
  cliToolFor: z.array(z.string()).description('仅内部使用：本作用域需要注册专属 CLI 工具的角色 id'),
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
        backend: z.union(['spawn', 'cli']),
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
  /**
   * **旋钮层**：每角色的 `id` + 设置字段（backend / model / effort / provider /
   * readOnly / allowNestedDispatch）。split 模式下这是设置页唯一承载的东西。
   *
   * ⚠️ 为什么需要它：DSH 的设置页只能读写**根条目 config 的 volatile 字段**，而设置变更
   *    会被 DSH 持久化进系统配置文件。角色**定义**（persona、工具构成、CLI argv 契约）
   *    是长篇、少改、且安全敏感的内容，不该住在 DSH 的系统配置里 —— 定义归插件自己的
   *    `roles.json`，系统配置里只留这几个旋钮。
   *
   * 判据是**显式**的：本字段一旦出现即为 split 模式，与 legacy 的 `roles`（完整列表，
   * 显式即替换）语义不同。起因是一次实测教训：靠「设置里有没有定义字段」推断模式，
   * 会把 `{ id, model }` 这类最小合法定义误判成旋钮。
   *
   * `readOnly` / `allowNestedDispatch` 属**组合期**事实（写进角色 preset 的插件清单），
   * 改动后由派发前热同步重建 preset；面板提示「不确定时完全重启 DSH」。
   */
  roleSettings: z
    .array(
      z.object({
        id: z.string().required(),
        backend: z.union(['spawn', 'cli']),
        model: z.string(),
        effort: z.union(EFFORT_VALUES),
        provider: z.string(),
        readOnly: z.boolean(),
        allowNestedDispatch: z.boolean(),
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
  // ⚠️ 服务一律走 `get()`：扩展 ctx **没有声明 inject**，
  //    在它们上面做 `ctx.subprocess` 直接属性访问会抛
  //    `cannot get property "subprocess" without inject`（本族缺陷的真机表现）。
  const subprocess = typeof ctx.get === 'function' ? ctx.get('subprocess') : ctx.subprocess;
  if (!subprocess || typeof subprocess.spawn !== 'function') {
    throw new Error('subprocess.spawn 不可用：没有挂载 subprocess 服务实现');
  }
  return subprocess.spawn({ ...spec, shell: false });
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
          pluginVersion: { type: 'string', required: true },
          manifestVersion: { type: 'number', required: true },
          configFormatVersion: { type: 'number', required: true },
          configFormatStatus: { type: 'string', required: true },
          dshRuntimeVersion: { type: 'null', required: true },
          dshRuntimeVersionReason: { type: 'string', required: true },
          ok: { type: 'boolean', required: true },
          phase: { type: 'string', required: true },
          roleCount: { type: 'number', required: true },
          mounted: { type: 'string', required: true },
          liveTools: { type: 'string', required: true },
          roleRoutes: { type: 'string', required: true },
          providers: { type: 'string', required: true },
          executables: { type: 'string', required: true },
          blocked: { type: 'string', required: true },
          presetRoster: { type: 'string', required: true },
          presetBroken: { type: 'string', required: true },
          rolePresets: { type: 'string', required: true },
          settingsNamespaces: { type: 'string', required: true },
          roleConfigStatus: { type: 'string', required: true },
          configErrors: { type: 'string', required: true },
          fatal: { type: 'string', required: true },
          scheduling: { type: 'string', required: true },
          warnings: { type: 'string', required: true },
          health: { type: 'string', required: true },
        },
      },
      render: (_args, value) => {
        const lines = [
          `Agent Switchboard · ${value.phase}`,
          `版本：插件=${value.pluginVersion} manifest=${value.manifestVersion} 配置=${value.configFormatVersion} (${value.configFormatStatus}) DSH=${value.dshRuntimeVersion ?? value.dshRuntimeVersionReason}`,
          `健康：${value.health}`,
          `调度规则：${value.scheduling}`,
          `已挂载角色工具：${value.roleCount}`,
          `明细（当前挂载状态）：${value.mounted}`,
          // 明细保留首次核验失败的信息；实时恢复后标注「曾延迟注册」，不再判为失败。
          `实时工具查询：${value.liveTools}`,
          `当前生效路由：${value.roleRoutes}`,
          `preset roster：${value.presetRoster}`,
          `preset 异常行：${value.presetBroken}`,
          `角色 preset（persona 与工具构成的承载点）：${value.rolePresets}`,
          `settings 命名空间：${value.settingsNamespaces}`,
          `roleConfig 状态：${value.roleConfigStatus}`,
          `CLI 专属工具：${value.providers}`,
          `CLI 可执行文件：${value.executables}`,
          // 「跨 CLI 总开关」已移除，因此这里不再是「因开关未挂载」，而是
          // 「因预设兼容性或执行一致性校验被拦下」。
          `未挂载的角色：${value.blocked}`,
        ];
        if (value.warnings) lines.push(`告警：${value.warnings}`);
        if (value.configErrors) lines.push(`配置错误：\n${value.configErrors}`);
        if (value.fatal) lines.push(`致命错误：${value.fatal}`);
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    async execute(_args, exec) {
      diagnostics.refresh?.();
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
      // ⚠️ 用**调用方 agent** 作为查询视角：委派工具装载在每个 agent 自己的作用域里。
      const live = diagnostics.mountHere ? liveRoleTools(ctx, diagnostics.configuredRoles, exec?.agent) : [];
      // 快照仅解释历史，当前健康与挂载数量只能由实时查询证明。
      const mounted = live;
      const okCount = mounted.filter((m) => m.ok).length;

      const scheduling = !diagnostics.mountHere ? '（根实例不注入；请在 Switchboard preset 中自检）'
        : diagnostics.readSupervisorRules?.() ? '已配置（仅注入主代理）'
          : '未配置（profile 可能未同步 preset：需 gen:preset → inject:preset → 重启）';
      const format = diagnostics.roleConfigPath ? readConfigFileDetailed(diagnostics.roleConfigPath).format : null;
      const warnings = [packageWarning, diagnostics.mountHere && !diagnostics.readSupervisorRules?.() ? `调度规则：${scheduling}` : '',
        format?.status === 'migrated' ? format.reason : '',
        // 组合期字段改了但组合还没跟上：提示词与自检都按**已注册的**快照如实描述，
        // 但子代理实际拿到的仍是那一版。热同步会在下次派发前重建；若重建失败，
        // 下面那条错误会顶上来，必须让用户看见。
        diagnostics.compositionRefreshError
          ?? (diagnostics.compositionDrift?.()
            ? '角色配置已修改但尚未重建组合：下次派发前会热同步；若持续出现请检查 agentPresets 服务'
            : '')].filter(Boolean).join('；');
      const ok = diagnostics.fatal === undefined && diagnostics.configErrors.length === 0
        && format?.status !== 'future' && format?.status !== 'unsupported'
        && !diagnostics.wrapperSyncPending && !mounted.some(m => m.ok === false);
      return {
        pluginVersion,
        manifestVersion,
        configFormatVersion: CONFIG_FORMAT_VERSION,
        configFormatStatus: format?.status ?? 'unavailable',
        dshRuntimeVersion: null,
        dshRuntimeVersionReason,
        scheduling, warnings, health: !ok ? '不健康' : warnings ? '可用但告警' : '健康',
        ok,
        phase: 'phase-3',
        roleRoutes: diagnostics.mountHere
          ? (diagnostics.roleRoutes ?? []).map(route => `${route.id} (${live.find(item => item.id === route.id)?.ok ? '已挂载' : '未挂载'}): ${route.summary}`).join('\n') || '（无生效角色）'
          : '（根实例只同步配置；请在 Switchboard preset 中查看生效路由）',
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
        rolePresets:
          !diagnostics.mountHere
            ? '（本作用域不注册角色 preset）'
            : diagnostics.presets.length === 0
              ? diagnostics.fatal ?? '（未注册；角色子代理将没有自己的 persona 与工具构成）'
              : diagnostics.presets
                  .map((p) => `${p.id}(${p.rows} 行${p.ok ? '' : '，注册失败'}）`)
                  .join(' ')
                // 热同步后附上时间，便于确认「改了设置但没重启」时组合确实重建过。
                + (diagnostics.compositionRefreshedAt === undefined
                  ? ''
                  : `；最近热同步 ${diagnostics.compositionRefreshedAt.slice(11, 19)}`),
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
          ...(format?.reason ? [`格式=${format.reason}`] : []),
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
async function mountRoleTool(ctx, role, toolModule, resolver, roles, maxDepth, wrapperRoute, dispatch) {
  if (typeof ctx.plugin !== 'function') return { ok: false, detail: 'ctx.plugin 不可用' };
  try {
    const liveRole = () => {
      const current = (dispatch.storage.getStore() ?? resolver()).roles.find(item => item.id === role.id);
      if (current?.cliBlockReason) throw new Error(current.cliBlockReason);
      return current;
    };
    const liveConfig = toolConfigFor(role, {
      getRole: liveRole,
      getMaxDepth: () => (dispatch.storage.getStore() ?? resolver()).maxDepth,
      getWrapperRoute: () => (dispatch.storage.getStore() ?? resolver()).wrapperRoute,
      maxDepth, wrapperRoute,
    });
    const fiber = ctx.plugin({ ...toolModule, apply: (toolCtx) => {
      // Cordis Config 校验产物会物化 getter；官方 apply 必须持有原 liveConfig 才能延迟解析。
      //
      // ⚠️ **必须 return**：0.2.1-rc.1 起官方 `apply` 是 async 的，抛错会变成**被丢弃的
      //    rejected promise** —— 既不会被 `fiber.await()` 看到，诊断里也只剩一句
      //    「工具尚未出现在工具注册表中」，而真正原因（例如旧字段被硬拒）就此丢失。
      // ⚠️ **必须显式转发这四个服务**：这里直接调用模块的 `apply`，绕过了 Cordis 的
      //    inject 装配；官方 `apply` 会直接读 `ctx.tools` / `ctx.subagents` /
      //    `ctx.systemPrompt` / `ctx.sessionProjections`（属性访问），缺一个就报
      //    `cannot get property "…" without inject`。
      return toolModule.apply(toolCtx.extend({ tools: toolCtx.get('tools'), subagents: toolCtx.subagents,
        systemPrompt: toolCtx.systemPrompt, sessionProjections: toolCtx.sessionProjections }), liveConfig);
    } }, liveConfig);
    if (typeof fiber?.await === 'function') await fiber.await();
  } catch (error) { return { ok: false, detail: error instanceof Error ? error.message : String(error) }; }
  await Promise.resolve(); await Promise.resolve();
  const registered = ctx.get('tools')?.get(role.toolName, scopeOf(ctx));
  // ⚠️ 0.2.1-rc.1 起，配了 `agentPreset` 的委派工具由**站立组合按 agent 安装**
  //    （官方 `install()` 在 `agent/created` 时注册到该 agent 自己的作用域），
  //    因此装载期它**不会**出现在本 preset 作用域。这里仍如实记录「此刻未出现」，
  //    因为可用性本来就该由**实时查询**判定（自检会按调用方 agent 的作用域去查）；
  //    但把原因写清楚，避免读成「挂载失败了」。真正失败的场景（`apply` 抛错）
  //    已由包装层的 `return` + `fiber.await()` 单独捕获。
  return registered == null
    ? { ok: false, detail: '工具尚未出现在工具注册表中（0.2.1-rc.1 起委派工具按 agent 安装，装载期不在本 preset 作用域；可用性由自检实时核验）' }
    : { ok: true, detail: '已挂载并核实' };
}

/**
 * 在 `ctx.profileContext`'@+' [regex]::Escape(' 不可用时推断 `$DSH_HOME`。') + '@' 不可用时推断 `$DSH_HOME`。
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
 * 解析 `$DSH_HOME`：优先 `ctx.profileContext.home`，否则按 `dsh-home-paths` 的语义回退。
 *
 * @param {object} ctx - Cordis 上下文。
 * @returns {string} `$DSH_HOME`。
 */
function resolveDshHome(ctx) {
  const profileContext = typeof ctx.get === 'function' ? ctx.get('profileContext') : undefined;
  return typeof profileContext?.home === 'string' && profileContext.home.length > 0
    ? profileContext.home
    : resolveFallbackDshHome();
}

/**
 * 注册一个角色的专属 CLI 工具。
 *
 * 抽出来是因为它有**两个**挂载点：主代理 preset 作用域（旧路径，保留兼容）与
 * 角色自己的 preset 作用域（0.2.1-rc.1 起子代理能看见专属工具的唯一途径）。
 *
 * @param {object} ctx - Cordis 上下文。
 * @param {object} role - 规范化后的角色。
 * @param {Function} getRole - 执行期现读该角色。
 * @param {object} diagnostics - 诊断记录。
 * @returns {object} 已注册的工具。
 */
function registerCliTool(ctx, role, getRole, diagnostics) {
  const executable = { id: role.id, command: role.cli.command, ok: true, resolved: '待执行时解析（尚未验证）' };
  diagnostics.executables.push(executable);
  const tool = createCliTool({
    role,
    getRole,
    ctx,
    spawn: spec => safeSpawn(ctx, spec),
    resolveExecutable: async (command, env, signal) => {
      executable.command = command;
      try {
        const result = await ctx.get('subprocess').resolveExecutable(command, env, signal);
        Object.assign(executable, { ok: true, resolved: result, detail: undefined });
        return result;
      } catch (error) {
        Object.assign(executable, { ok: false, resolved: undefined,
          detail: `本次未解析可执行文件：${error.message ?? error}` });
        throw error;
      }
    },
  });
  ctx.get('tools').register(tool);
  if (!ctx.get('tools').get(tool.name, scopeOf(ctx))) throw new Error('专属 CLI 工具未注册');
  diagnostics.providers.push({ id: role.id, name: tool.name, ok: true, detail: '已注册专属工具' });
  return tool;
}

/**
 * 在角色子代理自己的作用域里注册该角色的专属 CLI 工具。
 *
 * 由角色 preset 里的本插件条目（`cliToolFor`）触发。**只做这一件事**：不注册自检、
 * 不挂角色工具、不做根配置同步 —— 这个作用域属于子代理，不该有主代理的东西。
 *
 * @param {object} ctx - Cordis 上下文。
 * @param {object} options - 选项。
 * @param {string} options.roleConfigPath - 角色配置文件路径。
 * @param {string[]} options.roleIds - 需要在此作用域注册 CLI 工具的角色 id。
 * @param {object} options.diagnostics - 诊断记录。
 */
function mountCliToolsInThisScope(ctx, { roleConfigPath, roleIds, diagnostics }) {
  const read = createRoleResolver(roleConfigPath, {});
  let current;
  try {
    current = read();
  } catch (error) {
    diagnostics.fatal = `角色配置不可读，专属 CLI 工具未注册：${error instanceof Error ? error.message : String(error)}`;
    return;
  }
  diagnostics.roleConfigRead = `（子代理作用域）${current.source ?? 'preset'} stale=${current.stale === true}`;
  for (const roleId of roleIds) {
    const role = current.roles.find(item => item.id === roleId);
    if (role === undefined) {
      diagnostics.blocked.push({ id: roleId, reason: '角色配置里找不到该角色，专属 CLI 工具未注册' });
      continue;
    }
    if (role.backend !== CLI_BACKEND) {
      diagnostics.blocked.push({ id: roleId, reason: `角色 ${roleId} 不是 cli 后端，无需注册专属工具` });
      continue;
    }
    try {
      registerCliTool(ctx, role, () => {
        const live = read().roles.find(item => item.id === roleId);
        if (live?.cliBlockReason) throw new Error(live.cliBlockReason);
        return live;
      }, diagnostics);
    } catch (error) {
      diagnostics.blocked.push({ id: roleId, reason: error instanceof Error ? error.message : String(error) });
    }
  }
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
  diagnostics.readSupervisorRules = () => {
    const value = readVolatileField(resolved, 'supervisorRules');
    return typeof value === 'string' && value.trim() ? value : '';
  };
  noteLegacyTimeout(resolved, diagnostics);
  noteLegacyWrapper(resolved, diagnostics);

  // 说明：这里刻意**不**报告「本插件处于哪个 preset 作用域」。
  // `agentPresets.composedPreset(ctx)` 是从传入的上下文向上找最近的 preset 挂载，
  // 而 apply 运行在根上下文，用它必然返回 undefined —— 那是假信号，与 preset 是否
  // 生效无关（详见 docs/architecture.md 3.1d 第 22 条）。
  // 「只在选中本插件 preset 的会话里生效」由 preset 机制本身保证，无需探测。
  console.error(`[${name}] 激活（配置字段：${Object.keys(resolved).join(', ') || '空'}）`);

  // `$DSH_HOME` 来自 profileContext。它在 profile 启动路径下一定存在；headless/sdk/acp
  // 下 profileContext 本身不存在（dsh-base 里相关行都写成 `disabled: !!js "!ctx.get('profileContext')"`），
  // 那种情况下退化为 `$DSH_HOME` 环境变量或默认 `~/.dsh`，保证角色配置仍然可用。
  const dshHome = resolveDshHome(ctx);
  const roleConfigPath = configPathFor(dshHome);
  diagnostics.roleConfigPath = roleConfigPath;

  // --- 角色子代理作用域：只注册该角色的专属 CLI 工具 -------------------------------
  //
  // DSH 0.2.1-rc.1 起，角色子代理挂载的是**自己的**独立 preset（见 src/role-presets.js），
  // 而工具按作用域可见、不跨 preset 继承。所以专属 CLI 工具必须由角色 preset 自己
  // 声明一行本插件条目、在**子代理的作用域里**注册，否则子代理看不见它。
  //
  // 这条路径刻意什么都不做别的：不注册自检、不挂角色工具、不做根配置同步。
  const cliToolFor = readVolatileField(resolved, 'cliToolFor');
  if (Array.isArray(cliToolFor) && cliToolFor.length > 0) {
    mountCliToolsInThisScope(ctx, { roleConfigPath, roleIds: cliToolFor, diagnostics });
    return;
  }

  // 自检工具总是注册：即使角色配置全错，也要能用它看到错在哪。
  const disposeSelftest = ctx.tools.register(selftestTool(ctx, diagnostics));

  // --- 角色配置的来源：插件自己的文件（见 src/config-file.js 顶部的架构说明）------
  //
  // 不再从 Cordis 配置读 `roles`，原因有两条互相冲突的约束：
  //   1. `settings.describe()` 按 ns 去重、只报告根条目，因此设置页读不到 preset 那份；
  //   2. 把 roles 移到根条目会让角色工具全局可见，污染其他 preset 的会话。
  // 换成插件自己的文件后，两条同时解开：配置随处可编辑，而工具是否可见只取决于
  // 本插件在哪个会话作用域被激活。

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
    const sync = (updated, syncDepth = false) => {
      const wrapper = wrapperRouteFrom(updated);
      diagnostics.configErrors = diagnostics.configErrors.filter((error) => !error.startsWith('volatile.wrapper'));
      if (wrapper.errors.length > 0) {
        diagnostics.configErrors.push(...wrapper.errors);
        for (const error of wrapper.errors) console.error(`[${name}] ${error}`);
        return;
      }
      if (syncRolesToFile({ resolved: updated, roleConfigPath, diagnostics, syncDepth }) !== false) {
        syncWrapperRouteToFile(updated, roleConfigPath, diagnostics);
      }
    };
    if (ctx.on) ctx.on('loader/volatile-update', paths => {
      if (!Array.isArray(paths)) return;
      const relevant = paths.some(path => Array.isArray(path) && (
        path.length === 1 && ['roles', 'maxDepth'].includes(path[0]) ||
        path.length === 2 && path[0] === 'volatile' && ['wrapperProvider', 'wrapperModel', 'wrapperEffort'].includes(path[1])
      ));
      if (!relevant) return;
      try { sync(resolved, true); }
      catch (error) {
        const detail = `根配置同步异常：${error instanceof Error ? error.message : String(error)}`;
        diagnostics.roleConfigSync = detail;
        diagnostics.configErrors = [detail];
        console.error(`[${name}] ${detail}`);
      }
    });
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
  const loaded = readRoleConfigFile(roleConfigPath);
  diagnostics.roleConfigRead = loaded.detail;
  if (loaded.ok) { noteLegacyTimeout(loaded.value, diagnostics); noteLegacyWrapper(loaded.value, diagnostics); }
  // 保留 preset 显式 roles（包括 []）及真实 Volatile 引用，文件只补缺省来源。
  const read = createRoleResolver(roleConfigPath, { ...resolved });
  const initial = read();
  const roles = initial.roles;
  const resolver = () => {
    const current = read();
    const changed = JSON.stringify(current.roles.map(item => [item.id, item.toolName, item.backend])) !==
      JSON.stringify(roles.map(item => [item.id, item.toolName, item.backend]));
    const errors = [...current.errors, ...(!current.ok && current.error ? [current.error] : []),
      ...(changed ? ['角色工具集已改变（增删角色/id/toolName/backend）；阶段 3 未实现，请重新挂载'] : [])];
    diagnostics.roleRoutes = current.routes;
    diagnostics.configErrors = errors;
    if (!current.ok || errors.length) throw new Error(errors.join('；') || '角色配置不可用');
    return current;
  };
  diagnostics.refresh = () => { try { resolver(); } catch {} };
  diagnostics.roleRoutes = initial.routes;
  diagnostics.configuredRoles = roles.map(role => ({ id: role.id, toolName: role.toolName,
    ...(role.backend === CLI_BACKEND ? { cliToolName: cliToolName(role.id) } : {}) }));
  diagnostics.configuredRoleCount = roles.length;
  diagnostics.mountHere = true;
  if (!initial.ok || initial.errors.length > 0) {
    diagnostics.configErrors = initial.errors.length ? initial.errors : [initial.error];
    diagnostics.fatal = diagnostics.configErrors.join('；');
    return;
  }
  const { active: activeCliRoles, blocked: blockedCliRoles } = planCliMounts(roles);
  // --- 组合期快照 ---------------------------------------------------------------
  //
  // ⚠️ 0.2.1-rc.1 起，`readOnly` / `allowNestedDispatch` / `instructions` 是**组合期**事实：
  //    它们写在角色 preset 的插件清单里，而 `agentPresets.register()` 对重复 id **硬抛**
  //    （`Duplicate agent preset`），所以更新组合只能先注销再重注册。
  //    这里维护「当前已注册的组合」快照：提示词与自检都用它，而不是现读配置——否则在用户
  //    改完设置、组合还没重建时会**谎报**能力（例如对主代理说「只读」，而运行中的 preset
  //    仍带着写工具）。热同步成功后这份快照一并刷新，告警随之消失。
  const mountedFacts = new Map();
  /** 用一组角色刷新组合期快照（挂载时与热同步后共用）。 */
  const recordFacts = (currentRoles) => {
    mountedFacts.clear();
    for (const role of currentRoles) {
      mountedFacts.set(role.id, {
        readOnly: role.readOnly === true,
        allowNestedDispatch: role.allowNestedDispatch === true,
        instructions: role.instructions,
      });
    }
  };
  recordFacts(roles);
  /** 现读配置是否已偏离**已注册的**组合；偏离则下次派发前会重建，自检也会告警。 */
  const compositionDrift = (currentRoles) => {
    if (currentRoles.length !== mountedFacts.size) return true;
    return currentRoles.some((role) => {
      const fact = mountedFacts.get(role.id);
      return fact === undefined || fact.readOnly !== (role.readOnly === true)
        || fact.allowNestedDispatch !== (role.allowNestedDispatch === true)
        || fact.instructions !== role.instructions;
    });
  };
  // 自检用它当场判断组合是否落后于配置，而不是读一个可能过时的布尔快照。
  diagnostics.compositionDrift = () => {
    try { return compositionDrift(resolver().roles); } catch { return false; }
  };
  const dispatch = { storage: new AsyncLocalStorage(), toolNames: new Set(roles.map(role => role.toolName)) };
  /**
   * 组合热同步入口；由下方 `import(...)` 成功注册 preset 后赋值。
   *
   * 默认是空实现：`agentPresets` 不可用时（例如 headless 形态）派发照旧，只是没有热同步。
   */
  let ensureCompositionCurrent = async () => {};
  // 冻结点是 tools/execute 入口（路由预检之前），不包含模型生成工具调用的时刻。
  // CLI 这里只保证包裹委派请求同快照；底层 CLI 工具在另一个生命周期另行现读角色。
  //
  // ⚠️ 按**工具名**识别而不是按定义对象身份：0.2.1-rc.1 起官方插件把委派工具
  //    按 agent 安装到各自的作用域，注册路径不再经过本插件包装的那层 `tools` 视图，
  //    对象身份比对会永远不命中（快照与入口门禁静默失效）。工具名由角色 id 派生且唯一。
  //
  // ⚠️ 这里是 `async` 的：官方 `dsh-session-checkpoint-policy` 等插件同样用
  //    `async (exec, next)` 监听该 waterfall，返回 `next()` 的结果即可。
  ctx.on?.('tools/execute', async (exec, next) => {
    if (!dispatch.toolNames.has(exec.name)) return next();
    // resolver 快照同步捕获，跨 await 与并发调用由 ALS 隔离。
    // 工具级权限清单已不再需要：0.2.1-rc.1 起角色 persona 与工具构成由角色 preset 决定。
    //
    // ⚠️ 识别只能按工具名（原因见上），因此理论上会命中「别的作用域注册的同名工具」。
    //    这里刻意**不让快照失败影响那次调用**：拿不到有效快照就照常放行，让工具自己按
    //    现读配置决定成败。否则一个配置问题会连带弄坏与本插件无关的同名工具。
    let current;
    try { current = resolver(); } catch { return next(); }
    // 组合变了就先重建角色 preset（改 persona / readOnly / 嵌套派发后无需重启）。
    await ensureCompositionCurrent();
    return dispatch.storage.run(current, next);
  });
  diagnostics.blocked = blockedCliRoles;
  for (const role of activeCliRoles) {
    try {
      registerCliTool(ctx, role, () => {
        const current = resolver().roles.find(item => item.id === role.id);
        if (current?.cliBlockReason) throw new Error(current.cliBlockReason);
        return current;
      }, diagnostics);
    } catch (error) {
      diagnostics.blocked.push({ id: role.id, reason: error instanceof Error ? error.message : String(error) });
    }
  }

  // --- 角色 preset 必须先注册，再挂委派工具 ---------------------------------------
  //
  // ⚠️ 顺序是硬要求：`dsh-tool-subagent` 在装载期就会校验 `agentPreset` 指向的
  //    preset **已被声明**（`SubagentPresetSelection.validate`），先挂工具必然失败。
  //
  // ⚠️ 这也是角色 persona / readOnly / 嵌套派发能力的**唯一**承载点：它们在
  //    0.2.1-rc.1 里已从工具 Config 移到 preset 插件清单，属于**组合期**事实。
  //    因此改这些字段需要重新注册 preset（当前实现只在本作用域挂载时注册一次），
  //    model / effort 仍走执行期 getter，保持热更新。
  import('@deepseek-ai/dsh-tool-subagent').then(async toolModule => {
    const presetService = typeof ctx.get === 'function' ? ctx.get('agentPresets') : undefined;
    if (presetService === undefined || typeof presetService.register !== 'function') {
      diagnostics.fatal = 'agentPresets 服务不可用：无法为角色注册独立 preset，角色 persona 与工具构成无处承载';
      return;
    }
    // --- 角色 preset：注册 + 热同步 ---------------------------------------------
    //
    // ⚠️ 顺序是硬要求：`dsh-tool-subagent` 在装载期就校验 `agentPreset` 指向的 preset
    //    **已被声明**（`SubagentPresetSelection.validate`），先挂工具必然失败。
    //
    // ⚠️ 真正的约束来自注册表：`agentPresets.register()` 对已存在的 id **硬抛**
    //    `Duplicate agent preset`，所以「组合变了」不能原地更新，只能**先 dispose 再
    //    重新 register**。这留下一个极短的「id 未注册」窗口；因此刷新只在本插件的派发
    //    钩子里同步进行（钩子 await 它），自己的派发不会撞上那个窗口。
    //
    // 触发方式：每次**本插件的派发**前，用现读角色重算定义并与已注册的逐字比对，
    //    只有真的变了才重建。这样改 `instructions` / `readOnly` / `allowNestedDispatch` /
    //    `maxDepth` 保存后**下次派发即生效**，不必重启；`model` / `effort` 本来就走
    //    执行期 getter。角色增删改 id 仍属结构变化（工具集要变），由既有逻辑拒绝。
    const registered = new Map(); // presetId → { definition, dispose }
    let refreshing;

    const disposeRegistered = async () => {
      for (const [id, entry] of [...registered]) {
        try { await entry.dispose?.(); } catch {}
        registered.delete(id);
      }
    };

    /**
     * 用**现读**角色重建角色 preset，只重建变化的部分。
     *
     * @returns {Promise<number>} 已注册的 preset 数量。
     * @throws 当角色配置不可读或注册被拒时（调用方决定是否降级）。
     */
    const publish = async () => {
      const current = resolver();
      const definitions = buildRolePresets(current.roles, {
        maxDepth: current.maxDepth ?? initial.maxDepth,
        wrapperRoute: current.wrapperRoute ?? initial.wrapperRoute,
      });
      const wanted = new Map(definitions.map((definition) => [definition.id, definition]));

      // 先收回已不再需要的（角色被删或改名）。
      for (const [id, entry] of [...registered]) {
        if (wanted.has(id)) continue;
        try { await entry.dispose?.(); } catch {}
        registered.delete(id);
      }
      for (const definition of definitions) {
        const existing = registered.get(definition.id);
        if (existing !== undefined && JSON.stringify(existing.definition) === JSON.stringify(definition)) continue;
        // 必须先注销：注册表对重复 id 硬抛。
        if (existing !== undefined) {
          try { await existing.dispose?.(); } catch {}
          registered.delete(definition.id);
        }
        const dispose = await presetService.register(definition);
        registered.set(definition.id, { definition, dispose });
      }

      diagnostics.presets = [...wanted.keys()].map((id) => ({
        id, rows: wanted.get(id).plugins.length, ok: true,
      }));
      // 组合已重建：快照跟上，`compositionDrift` 随之归零，自检的「需重启」告警消失。
      recordFacts(current.roles);
      diagnostics.compositionStale = false;
      diagnostics.compositionRefreshedAt = new Date().toISOString();
      return registered.size;
    };

    /** 保证组合与现读配置一致；并发调用合并成同一次刷新。 */
    ensureCompositionCurrent = async () => {
      try {
        refreshing ??= publish().finally(() => { refreshing = undefined; });
        await refreshing;
        diagnostics.compositionRefreshError = undefined;
      } catch (error) {
        // 刷新失败不能让派发本身失败：退回用上一版组合，并如实记录。
        const detail = error instanceof Error ? error.message : String(error);
        diagnostics.compositionRefreshError = `角色组合热同步失败（本次派发沿用上一版组合）：${detail}`;
        diagnostics.compositionStale = true;
      }
    };

    try {
      await publish();
    } catch (error) {
      const detail = `角色 preset 注册失败：${error instanceof Error ? error.message : String(error)}`;
      diagnostics.fatal = detail;
      console.error(`[${name}] ${detail}`);
      return;
    }
    ctx.effect?.(() => () => { void disposeRegistered(); });

    for (const role of roles) {
      const blocked = diagnostics.blocked.find(item => item.id === role.id);
      if (blocked) { diagnostics.mounts.push({ id: role.id, ok: false, detail: blocked.reason }); continue; }
      const outcome = await mountRoleTool(ctx, role, toolModule, resolver, roles, initial.maxDepth, initial.wrapperRoute, dispatch);
      diagnostics.mounts.push({ id: role.id, ok: outcome.ok, detail: outcome.detail });
    }
  }).catch(error => { diagnostics.fatal = `无法 import @deepseek-ai/dsh-tool-subagent：${error.message ?? error}`; });
  const disposeGuidance = ctx.get('systemPrompt').section({ name: 'agent-switchboard:roles', order: 10500,
    text: (context) => {
      if (!isMainAgentContext(context)) return '';
      let current; try { current = resolver(); } catch { return '角色配置不可派发；请检查 switchboard_selftest。'; }
      // ⚠️ 查询视角必须是**正在组装的这个 agent**：委派工具装载在它自己的作用域里，
      //    用注册作用域去查会一律为空，于是把「可继续派发」谎报成「不可派发」。
      const viewer = context?.agent ?? scopeOf(ctx);
      // 能力描述用**组合期快照**，不用现读配置：见 mountedFacts 的说明。
      const guidanceRoles = current.roles.map((role) => {
        const fact = mountedFacts.get(role.id);
        return fact === undefined ? role : { ...role, readOnly: fact.readOnly, allowNestedDispatch: fact.allowNestedDispatch };
      });
      diagnostics.compositionStale = compositionDrift(current.roles);
      return roleGuidanceText(guidanceRoles, {
        availableToolNames: ctx.get('tools').schemas(viewer).map(tool => tool.name),
        delegateToolNames: guidanceRoles.filter(role => ctx.get('tools').get(role.toolName, viewer)).map(role => role.toolName),
      }); } });
  const disposeScheduling = ctx.get('systemPrompt').section({ name: 'agent-switchboard:scheduling', order: 10510,
    text: context => isMainAgentContext(context) ? diagnostics.readSupervisorRules() : '' });
  ctx.effect?.(() => () => { disposeGuidance?.(); disposeScheduling?.(); disposeSelftest?.(); });
}

// DSH assembleContextFor 传入 agent 与 scope；未知上下文不猜测主代理身份。
function isMainAgentContext(context) {
  const agent = context?.agent ?? context?.scope;
  const header = agent?.session?.header;
  return !!header && typeof header === 'object' && !Array.isArray(header) &&
    header.origin !== 'subagent' && (header.delegationDepth ?? 0) === 0 &&
    (agent.options?.subagentDepth ?? 0) === 0;
}

function createRoleResolver(roleConfigPath, resolved) {
  const file = createConfigFileResolver(roleConfigPath);
  return () => {
    const fromFile = file.read();
    const value = fromFile.ok && fromFile.value ? fromFile.value : {};
    // ⚠️ 模式是**显式**的，不靠猜字段：
    //    - 设置层提供 `roleSettings`（旋钮层）→ split 模式：它是**覆盖层**，
    //      与文件里的定义/覆盖逐字段合并（定义归文件所有）；
    //    - 否则用 legacy 的 `roles`：它是**完整列表**，语义是「显式即替换」——
    //      `[]` 清空、`null` 报错，文件完全不参与（含非法的 `null`，必须原样交给
    //      字段级校验去报错，不能被文件内容静默顶掉）。
    const configuredRoleSettings = readVolatileField(resolved, 'roleSettings');
    const configuredRoles = readVolatileField(resolved, 'roles');
    const fileLayers = {
      definitions: Array.isArray(value.roles) ? value.roles : [],
      overrides: Array.isArray(value.overrides) ? value.overrides : [],
    };
    const raw = configuredRoleSettings === undefined
      ? configuredRoles !== undefined ? configuredRoles : Array.isArray(value.roles) ? value.roles : []
      : Array.isArray(configuredRoleSettings)
        ? mergeRoleLayers({ ...fileLayers, configured: configuredRoleSettings })
        : configuredRoleSettings;
    const defaults = { provider: value.provider || resolved.provider, cwd: value.cwd || resolved.cwd };
    const normalized = raw !== undefined && !Array.isArray(raw)
      ? { roles: [], errors: ['roles 必须是数组'] } : normalizeRoles(raw, defaults.provider, defaults.cwd);
    if (normalized.errors.length === 0 && Array.isArray(raw) && raw.some(item => item?.toolName !== undefined &&
      item.toolName !== normalized.roles.find(role => role.id === item.id)?.toolName)) {
      normalized.errors.push('toolName 改动会改变角色工具集；阶段 3 未实现，请使用由 id 派生的工具名');
    }
    const maxDepth = Number.isInteger(value.maxDepth) && value.maxDepth >= 0 ? value.maxDepth
      : typeof resolved.maxDepth === 'number' ? resolved.maxDepth : 3;
    const wrapperRoute = wrapperRouteFrom(fromFile.ok && value.volatile ? value : resolved);
    const routes = normalized.roles.map(role => ({ id: role.id,
      summary: `${routeSummaryFor(role)} source=${configuredRoles !== undefined ? 'preset' : 'file'} stale=${fromFile.stale === true}` }));
    return { ok: fromFile.ok && wrapperRoute.errors.length === 0, roles: normalized.roles,
      errors: [...normalized.errors, ...wrapperRoute.errors], error: fromFile.error,
      maxDepth, wrapperRoute: wrapperRoute.route, routes, source: fromFile.source ?? 'preset', stale: fromFile.stale === true };
  };
}
