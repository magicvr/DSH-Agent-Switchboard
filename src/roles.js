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

/** 思考强度的统一枚举。与 DSH 的 `ReasoningEffortId` 取值一致。 */
export const EFFORT_VALUES = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);

/** 内置子代理后端名。两者都由 `dsh-base` 装载（已核实）。 */
export const BUILTIN_PROVIDERS = Object.freeze(['spawn', 'fork']);

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
 * @returns {{ role: Role | null, errors: string[] }}
 */
export function normalizeRole(raw, index, defaultProvider) {
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

  const model = read('model');
  if (!model) errors.push(`${at}.model 必填`);

  const provider = read('provider') ?? defaultProvider;
  if (!provider) {
    errors.push(`${at}.provider 未设置，且插件级 provider 也未设置`);
  }

  const effort = read('effort');
  if (effort !== undefined && !EFFORT_VALUES.includes(effort)) {
    errors.push(
      `${at}.effort "${effort}" 非法：只能是 ${EFFORT_VALUES.join(' / ')}`,
    );
  }

  const backend = read('backend') ?? 'spawn';
  if (!BUILTIN_PROVIDERS.includes(backend)) {
    errors.push(
      `${at}.backend "${backend}" 非法：Phase 2 只支持 ${BUILTIN_PROVIDERS.join(' / ')}`,
    );
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
 * @returns {{ roles: Role[], errors: string[] }}
 */
export function normalizeRoles(rawRoles, defaultProvider) {
  if (rawRoles === undefined || rawRoles === null) return { roles: [], errors: [] };
  if (!Array.isArray(rawRoles)) {
    return { roles: [], errors: ['roles 必须是数组'] };
  }

  const roles = [];
  const errors = [];
  for (let index = 0; index < rawRoles.length; index++) {
    const { role, errors: roleErrors } = normalizeRole(rawRoles[index], index, defaultProvider);
    errors.push(...roleErrors);
    if (role) roles.push(role);
  }

  // 跨角色唯一性：重复的 id 会让工具名与 preset id 相撞，必须拦下。
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
 * @param {number} options.maxDepth - 该角色的派发深度上限。
 * @returns {object} `dsh-tool-subagent` 的 Config。
 */
export function toolConfigFor(role, { maxDepth }) {
  /** @type {Record<string, unknown>} */
  const config = {
    provider: role.backend,
    toolName: role.toolName,
    // 角色级固定模型与强度，主代理无权覆盖（decisions.md D12）。
    agentOptions: {
      provider: role.provider,
      model: role.model,
      ...(role.effort === undefined ? {} : { reasoningEffort: role.effort }),
    },
    persona: role.instructions,
    backgroundMode: 'one-shot',
  };

  // 深度策略：
  //  - 禁止嵌套 → maxDepth: 0（provider 会据此拒绝再派发）
  //  - 允许嵌套 → 交给插件的 maxDepth 设置
  // 注意：`dsh-tool-subagent` 要求 provider 具备 depthLimit 能力，spawn/fork 都有。
  config.maxDepth = role.allowNestedDispatch ? maxDepth : 0;

  if (role.readOnly) {
    config.toolFilter = { deny: [...WRITE_TOOLS] };
  }

  return config;
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
