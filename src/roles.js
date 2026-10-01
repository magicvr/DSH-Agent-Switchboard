/**
 * 角色模型：解析、校验与工具定义生成。
 *
 * 本模块刻意**不含任何 DSH 运行时依赖**（不 import `@deepseek-ai/*`），
 * 因此它可以在 Node 里直接跑单测，不依赖重启 dsh。
 * 这是有意为之：Host 半边在 link 安装下不能热加载（见 docs/architecture.md 3.3），
 * 所以凡是能做成纯函数的逻辑都必须做成纯函数。
 *
 * @module @magicvr/dsh-agent-switchboard/roles
 */
import { validateTemplate } from './cli/argv.js';

/** 思考强度的统一枚举。与 DSH 的 `ReasoningEffortId` 取值一致。 */
export const EFFORT_VALUES = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);

/** 内置子代理后端名。两者都由 `dsh-base` 装载（已核实）。 */
export const BUILTIN_PROVIDERS = Object.freeze(['spawn', 'fork']);

/** CLI 后端的 backend 名。 */
export const CLI_BACKEND = 'cli';

/**
 * 一个 CLI 角色对应的 provider 实例名。
 *
 * 每个 CLI 角色注册**自己的** provider 实例，因为单一 provider 无法区分是哪个
 * 角色发起的调用，而角色级命令/模型/强度必须各不相同。
 *
 * @param {string} roleId - 角色 id。
 * @returns {string} provider 名。
 */
export function cliProviderName(roleId) {
  return `switchboard-cli-${roleId}`;
}

/**
 * 写入类工具名。`readOnly` 角色通过 `toolFilter.deny` 从机制上挡住它们。
 *
 * ⚠️ 这是**工具级**约束，不是沙箱级。`SubagentStartRequest` 没有沙箱字段
 * （已核实），所以「只读」在本插件里只能这样落地，必须如实标注。
 */
export const WRITE_TOOLS = Object.freeze([
  'write',
  'edit',
  'pwsh',
  'workflow',
  'todo_write',
  'create_goal',
  'update_goal',
]);

/** 角色 id 允许的字符：小写字母、数字、连字符。用作工具名的后缀。 */
const ID_PATTERN = /^[a-z][a-z0-9-]*$/;

/**
 * 一个角色经校验后的规范化形态。
 *
 * @typedef {object} Role
 * @property {string} id           稳定标识，同时用于生成工具名与 preset id
 * @property {string} [title]      显示名
 * @property {string} description  给主代理看的“何时派发给我”
 * @property {string} [provider]   LLM route 的 provider；省略则用全局默认
 * @property {string} model        LLM route 的 model id
 * @property {string} [effort]     思考强度
 * @property {string} instructions 给子代理看的开发者指令（persona）
 * @property {boolean} readOnly    是否只读
 * @property {string} backend      子代理后端 provider 名
 * @property {boolean} allowNestedDispatch 是否允许该子代理继续派发
 * @property {string} toolName     主代理可见的委派工具名
 */

/**
 * 校验并规范化一条角色定义。
 *
 * 返回错误列表而不是抛异常：调用方需要一次性把**所有**角色的问题报出来，
 * 而不是让用户改一个、重启一次、再发现下一个。
 *
 * @param {unknown} raw - 来自插件配置的原始角色定义。
 * @param {number} index - 在 roles 数组中的下标，用于定位错误。
 * @param {string | undefined} defaultProvider - 全局默认 LLM provider。
 * @param {string | undefined} defaultCwd - 全局默认可执行工作目录。
 * @returns {{ role: Role | null, errors: string[] }}
 */
export function normalizeRole(raw, index, defaultProvider, defaultCwd) {
  const errors = [];
  const at = `roles[${index}]`;

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { role: null, errors: [`${at} 必须是一个对象`] };
  }

  const read = (key) => (typeof raw[key] === 'string' ? raw[key].trim() : undefined);

  const id = read('id');
  if (!id) errors.push(`${at}.id 必填`);
  else if (!ID_PATTERN.test(id)) {
    errors.push(`${at}.id "${id}" 非法：只允许小写字母、数字、连字符，且以字母开头`);
  }

  const description = read('description');
  if (!description) {
    errors.push(`${at}.description 必填（主代理据此判断何时派发给这个角色）`);
  }

  const instructions = read('instructions');
  if (!instructions) errors.push(`${at}.instructions 必填（子代理的开发者指令）`);

  // 先定 backend，因为「哪些字段必填」取决于它：
  //   - builtin 后端需要 DSH 的 provider/model route；
  //   - cli 后端需要可执行文件与参数模板，**不需要** DSH route。
  const backend = read('backend') ?? 'spawn';
  if (!BUILTIN_PROVIDERS.includes(backend) && backend !== CLI_BACKEND) {
    errors.push(
      `${at}.backend "${backend}" 非法：只能是 ${[...BUILTIN_PROVIDERS, CLI_BACKEND].join(' / ')}`,
    );
  }
  const isCli = backend === CLI_BACKEND;

  const model = read('model');
  const provider = read('provider') ?? defaultProvider;
  if (!isCli) {
    if (!model) errors.push(`${at}.model 必填（backend 为 ${backend} 时需要 DSH 的 LLM route）`);
    if (!provider) {
      errors.push(`${at}.provider 未设置，且插件级 provider 也未设置`);
    }
  }

  const effort = read('effort');
  if (effort !== undefined && !EFFORT_VALUES.includes(effort)) {
    errors.push(
      `${at}.effort "${effort}" 非法：只能是 ${EFFORT_VALUES.join(' / ')}`,
    );
  }

  // CLI 后端专属配置。放在角色**顶层**而非嵌套对象里，是为了让插件面板能把它
  // 当普通标量字段渲染；嵌套结构在设置表单里难编辑（见 decisions.md D9）。
  let cli;
  if (isCli) {
    const cliCommand = read('cliCommand');
    if (!cliCommand) {
      errors.push(`${at}.cliCommand 必填（backend 为 cli 时必须给出可执行文件）`);
    }

    const cliArgs = raw.cliArgs;
    if (!Array.isArray(cliArgs) || cliArgs.length === 0) {
      errors.push(`${at}.cliArgs 必填，且必须是字符串数组（给出该 CLI 的参数模板）`);
    }

    const cliPrefixArgs = raw.cliPrefixArgs;
    if (cliPrefixArgs !== undefined && !Array.isArray(cliPrefixArgs)) {
      errors.push(`${at}.cliPrefixArgs 必须是字符串数组`);
    }

    const cliPromptDelivery = read('cliPromptDelivery') ?? 'stdin';
    const cliCwd = read('cliCwd') ?? defaultCwd;

    if (Array.isArray(cliArgs) && cliCommand) {
      // 模板校验放到这里（而不是只在运行时）：配置错误应在装载期就报出来，
      // 而不是等第一次派发才失败。
      const templateErrors = validateTemplate(cliArgs, { promptDelivery: cliPromptDelivery });
      for (const line of templateErrors) errors.push(`${at}.cliArgs：${line}`);
    }

    cli = {
      command: cliCommand,
      prefixArgs: Array.isArray(cliPrefixArgs) ? [...cliPrefixArgs] : [],
      args: Array.isArray(cliArgs) ? [...cliArgs] : [],
      promptDelivery: cliPromptDelivery,
      cwd: cliCwd,
      graceMs: Number.isSafeInteger(raw.cliGraceMs) ? raw.cliGraceMs : 3000,
      maxOutputBytes: Number.isSafeInteger(raw.cliMaxOutputBytes) ? raw.cliMaxOutputBytes : 1_000_000,
      maxErrorBytes: Number.isSafeInteger(raw.cliMaxErrorBytes) ? raw.cliMaxErrorBytes : 100_000,
      timeoutMs: Number.isSafeInteger(raw.cliTimeoutMs) ? raw.cliTimeoutMs : undefined,
    };

    // CLI 后端不承载 DSH 的 provider/model route，因此上面没有强制它们。
    if (!cliCwd) errors.push(`${at}.cliCwd 未设置，且全局 cwd 也未设置`);
  }

  if (errors.length > 0) return { role: null, errors };

  return {
    role: {
      id,
      title: read('title'),
      description,
      provider,
      model,
      effort,
      instructions,
      readOnly: raw.readOnly === true,
      backend,
      allowNestedDispatch: raw.allowNestedDispatch === true,
      ...(cli ? { cli } : {}),
      toolName: `delegate_to_${id.replace(/-/g, '_')}`,
    },
    errors,
  };
}

/**
 * 校验整份角色列表，并检查跨角色的唯一性。
 *
 * @param {unknown} rawRoles - 配置里的 roles 数组。
 * @param {string | undefined} defaultProvider - 全局默认 LLM provider。
 * @param {string | undefined} [defaultCwd] - 全局默认可执行工作目录。
 * @returns {{ roles: Role[], errors: string[] }}
 */
export function normalizeRoles(rawRoles, defaultProvider, defaultCwd) {
  if (rawRoles === undefined || rawRoles === null) return { roles: [], errors: [] };
  if (!Array.isArray(rawRoles)) {
    return { roles: [], errors: ['roles 必须是数组'] };
  }

  const roles = [];
  const errors = [];
  for (let index = 0; index < rawRoles.length; index++) {
    const { role, errors: roleErrors } = normalizeRole(rawRoles[index], index, defaultProvider, defaultCwd);
    errors.push(...roleErrors);
    if (role) roles.push(role);
  }

  // 跨角色唯一性：重复的 id 会让工具名与 provider 名相撞，必须拦下。
  const seenIds = new Map();
  const seenTools = new Map();
  for (const role of roles) {
    if (seenIds.has(role.id)) errors.push(`角色 id "${role.id}" 重复`);
    else seenIds.set(role.id, role);
    if (seenTools.has(role.toolName)) errors.push(`角色工具名 "${role.toolName}" 重复`);
    else seenTools.set(role.toolName, role);
  }

  return { roles: errors.length > 0 ? [] : roles, errors };
}

/**
 * 为一个角色生成 `dsh-tool-subagent` 实例的配置。
 *
 * ⚠️ 用普通 JSON 对象而不是 schemastery：这份配置是我们**自己**喂给
 * `ctx.plugin()` 的，不走 Loader 的配置校验，因此不需要 schema 实例。
 *
 * @param {Role} role - 规范化后的角色。
 * @param {object} options - 全局选项。
 * @param {number} options.maxDepth - 允许嵌套时，**额外**可用的层数。
 * @returns {object} `dsh-tool-subagent` 的 Config。
 */
export function toolConfigFor(role, { maxDepth }) {
  const isCli = role.backend === CLI_BACKEND;

  /** @type {Record<string, unknown>} */
  const config = {
    // cli 后端指向**该角色自己的** provider 实例：单一 provider 无法区分是哪个
    // 角色发起的调用，而每个角色的命令/模型/强度都不同。
    provider: isCli ? cliProviderName(role.id) : role.backend,
    toolName: role.toolName,
    backgroundMode: 'one-shot',
  };

  if (!isCli) {
    // 角色级固定模型与强度，主代理无权覆盖（decisions.md D12）。
    // CLI 后端不需要这两项：模型与强度由 argv 模板里的 {model}/{effort} 承载。
    config.agentOptions = {
      provider: role.provider,
      model: role.model,
      ...(role.effort === undefined ? {} : { reasoningEffort: role.effort }),
    };
    // persona 只有 builtin provider 支持（CLI provider 的 capabilities.persona 为 false）。
    // CLI 后端的角色指令需要由 argv 模板或 CLI 自身配置承载。
    config.persona = role.instructions;
  }

  // 深度上限是**绝对深度**，不是「相对嵌套层数」。
  //
  // 依据 dsh-subagent 的 resolveChildDepth：
  //     const childDepth = delegationDepthOf(parent) + 1;
  //     if (maxDepth !== void 0 && childDepth > maxDepth) throw new SubagentDepthError(childDepth, maxDepth);
  // 顶层代理的 delegationDepthOf 为 0，因此**它派出的第一个子代理深度就是 1**。
  // 这意味着 maxDepth: 0 会连第一层派发都拒绝（实测报错
  // `subagent depth 1 exceeds maxDepth 0`），而不是「禁止子代理再往下派」。
  //
  // 因此：
  //   - 禁止嵌套 → 1（本层可派发，但子代理不能再派）
  //   - 允许嵌套 → 1 + maxDepth（额外给出 maxDepth 层）
  //
  // ⚠️ **只对 builtin 后端设置**：`dsh-tool-subagent` 要求 provider 具备
  // `depthLimit` 能力，而 CLI provider 声明为 false（D7）。对 CLI 角色设置
  // maxDepth 会让工具装载期直接抛错 —— 我们已经实测过同类约束的报错路径。
  if (!isCli) {
    config.maxDepth = role.allowNestedDispatch ? 1 + maxDepth : 1;
  }

  // ⚠️ `toolFilter` 同样只有 builtin provider 支持。
  // CLI 角色的「只读」只能由 CLI 自身的沙箱参数实现（例如 codex 的
  // `-s read-only`，写在 cliArgs 模板里）。角色的 readOnly 字段对 CLI 后端
  // 因此是**声明性的**，必须如实标注而不是假装有硬约束（D7、cli-backends.md）。
  if (role.readOnly && !isCli) {
    config.toolFilter = { deny: [...WRITE_TOOLS] };
  }

  return config;
}

/**
 * 决定哪些 CLI 角色应该被实际挂载。
 *
 * ⚠️ 抽成纯函数是刻意的：`apply()` 里的分支在 link 安装下**无法热加载验证**
 * （docs/architecture.md 3.3），因此凡是能做成纯逻辑的判断都必须做成纯函数，
 * 才能在 Node 里离线测到。这个总开关关系到「会不会在本机执行外部命令」，
 * 更不能没有测试覆盖。
 *
 * `allowCrossCli` **默认关闭**：CLI 后端会真的执行本地命令，必须显式开启。
 * 关闭时 CLI 角色既不注册 provider 也不挂载工具 —— 主代理看不到它们，
 * 而不是看到一个一调用就报错的工具。
 *
 * @param {Role[]} roles - 规范化后的角色列表。
 * @param {boolean} allowCrossCli - 跨 CLI 派发总开关。
 * @returns {{ active: Role[], blocked: { id: string, reason: string }[] }} 挂载计划。
 */
export function planCliMounts(roles, allowCrossCli) {
  const cliRoles = roles.filter((role) => role.backend === CLI_BACKEND);
  if (allowCrossCli === true) return { active: cliRoles, blocked: [] };
  return {
    active: [],
    blocked: cliRoles.map((role) => ({ id: role.id, reason: 'allowCrossCli 未开启' })),
  };
}

/**
 * 生成给主代理看的工具描述。
 *
 * 主代理只需要知道「什么时候用这个角色」，不需要看到角色的完整指令
 * （那是 persona 的事，由子代理自己看）。这样能显著节省主代理的上下文。
 *
 * @param {Role} role - 规范化后的角色。
 * @returns {string} 工具描述。
 */
export function toolDescriptionFor(role) {
  const parts = [role.description.trim()];
  const facts = [`角色：${role.title ?? role.id}`];
  if (role.readOnly) facts.push('只读（不能改文件）');
  facts.push(`后端：${role.backend}`);
  // 嵌套派发状态必须显式告知：主代理据此判断能否把整块工作交给它自组织。
  facts.push(role.allowNestedDispatch ? '可继续派发子代理' : '不可继续派发子代理');
  parts.push(`（${facts.join('；')}）`);
  return parts.join(' ');
}

// ---------------------------------------------------------------------------
// 路由指引
//
// ⚠️ 为什么需要它：`dsh-tool-subagent` 的工具描述由它自己的 `providerWording()`
// 生成，**Config 里没有任何字段可以覆盖**（Config 仅 provider / toolName /
// modelSelectionSettings / enableRunInBackground / backgroundMode / agentOptions /
// persona / toolFilter / maxDepth）。实测结果是四个角色工具的描述**逐字相同**，
// 主代理只能靠工具名猜「该派谁」——「何时用哪个角色」这套核心决策规则丢失了。
//
// 因此改成注册一段系统提示（ctx.systemPrompt.section）。这也更贴合设计意图：
// 主代理需要的是**路由规则**，而不是四段互不相干的工具描述。
// ---------------------------------------------------------------------------

/**
 * 生成给主代理看的角色路由指引。
 *
 * 只描述「何时派给谁」与只读/嵌套约束，不复述各角色完整指令（那是 persona 的事），
 * 以控制主代理的上下文成本。
 *
 * @param {Role[]} roles - 规范化后的角色列表。
 * @returns {string} 系统提示片段；无角色时返回空串。
 */
export function roleGuidanceText(roles) {
  if (roles.length === 0) return '';
  const lines = [
    '## Subagent roles (Agent Switchboard)',
    '',
    'You are the switchboard: you integrate information and delegate the work. Do not perform',
    'role work yourself when a role below fits. Pick one role per task and delegate through its',
    '`delegate_to_<role>` tool. Each role already has its own model, reasoning effort and',
    'instructions fixed by configuration, so never attempt to choose or override them.',
    '',
    'Route by asking what kind of question you have:',
    '',
  ];
  for (const role of roles) {
    const flags = [];
    if (role.readOnly) flags.push('read-only');
    flags.push(role.allowNestedDispatch ? 'may delegate further' : 'cannot delegate further');
    lines.push(`- **${role.id}**${role.title ? ` (${role.title})` : ''} — ${role.description.trim()}`);
    lines.push(`  \`${role.toolName}\` · ${flags.join(' · ')}`);
  }
  lines.push('');
  lines.push('Report what the results establish, not the raw process.');
  return lines.join('\n');
}
