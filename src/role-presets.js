/**
 * 按角色组装独立的 Agent Preset。
 *
 * ## 为什么需要这个模块
 *
 * DSH `0.2.1-rc.1` 把 `dsh-tool-subagent` 的 `persona` 与 `toolFilter` 两个 Config
 * 字段**删除**了，并且对仍然带这两个键的配置**在装载期直接抛错**：
 *
 * ```js
 * for (const field of ["persona", "toolFilter"])
 *   if (Object.hasOwn(config, field)) throw new Error(`tool-subagent: ${field} is no longer supported;
 *     configure persona and tool plugins in an Agent Preset and select it with agentPreset (spawn only)`);
 * ```
 *
 * 官方给的迁移路径只有一条：**把 persona 与工具构成写进 Agent Preset 的插件清单**，
 * 再用 `agentPreset: <id>` 选中它。也就是说，角色子代理不再「继承父 preset 再过滤」，
 * 而是挂载一个**自带完整工具清单**的独立 preset。
 *
 * 本模块就是那条路径的实现：把上游 standard 清单（由 `scripts/gen-preset.mjs` 导出的
 * `presets/standard-plugins.json` 行模板）按角色裁剪成一份 preset 定义。
 *
 * ## 关键设计
 *
 * - 行模板来自**上游 standard**，不是手抄：DSH 升级后 `check:preset` 会发现漂移。
 * - 裁剪按**行**而不是按工具名：新版机制要求「在 preset 插件清单里组合工具」，
 *   而工具名到插件行的映射在本插件里并不掌握，按行裁剪才是机制本身。
 * - `readOnly` 用行级裁剪 + `dsh-tool-fs` 的 `read/write/edit` 开关共同落地。
 * - CLI 角色的子代理只需要「角色指令 + 自己的专属 CLI 工具」，
 *   与旧 `toolFilter.allow` 的白名单语义对齐。
 *
 * @module @magicvr/dsh-agent-switchboard/role-presets
 */
import { readFileSync } from 'node:fs';
import {
  CLI_BACKEND,
  DELEGATION_PROVIDER,
  absoluteDepthLimit,
  dispatchPermissionsFor,
  rolePresetId,
} from './roles.js';

/** 角色 id 对应的 preset id；由 roles.js 定义并在此转发，保持单一真源。 */
export { rolePresetId };

/**
 * 任何角色的子代理都**不应**拿到的行：通用派发入口与 workflow 引擎。
 *
 * 与旧 `toolFilter` 的 `UNCONTROLLED_DISPATCH_TOOLS` 对齐——角色只能通过
 * Switchboard 自己的角色工具派发，不能绕过角色与深度预算。
 */
const ALWAYS_EXCLUDED_ROWS = Object.freeze([
  'tool-subagent',
  'tool-subagent-fork',
  'tool-ralph',
  'tool-workflow',
  'workflow-ptc',
]);

/**
 * 只读角色额外排除的行。
 *
 * 对齐旧 `WRITE_TOOLS`：shell 无法降级为只读，只能整行去掉；
 * goal / todo 属于状态写入，同样去掉。`dsh-tool-fs` 不整行去掉，
 * 而是把 `write`/`edit` 关掉——否则连 `read` 都没了。
 */
const READONLY_EXCLUDED_ROWS = Object.freeze([
  'tool-bash',
  'tool-pwsh',
  'command-goal',
  'tool-goal',
  'tool-todo',
  'tool-plugin-manager',
  'tool-plugin-market',
]);

/** 关闭写入能力的 fs 行 id。 */
const FS_ROW_ID = 'tool-fs';

/** 行模板缓存：文件在进程内不会变，读一次即可。 */
let cachedTemplate;

/**
 * 读取由生成器产出的行模板。
 *
 * 用 `fs` + `JSON.parse` 而不是 import attributes，是为了在 DSH 的双锚点解析下
 * 也只依赖本包内的相对路径，不依赖 JSON 模块加载语义。
 *
 * @returns {{rows: object[], generatedFrom: string}} 行模板。
 */
export function loadRowTemplate() {
  if (cachedTemplate === undefined) {
    const url = new URL('../presets/standard-plugins.json', import.meta.url);
    cachedTemplate = JSON.parse(readFileSync(url, 'utf8'));
  }
  return cachedTemplate;
}

/**
 * 把行模板的一行物化成 Loader 可用的条目，并解析平台条件。
 *
 * @param {object} row - 模板行。
 * @param {string} platform - `process.platform` 取值。
 * @param {object} options - 裁剪选项。
 * @param {boolean} options.readOnly - 是否只读角色。
 * @returns {object|undefined} 条目；被排除时返回 undefined。
 */
function materializeRow(row, platform, { readOnly }) {
  if (ALWAYS_EXCLUDED_ROWS.includes(row.id)) return undefined;
  if (readOnly && READONLY_EXCLUDED_ROWS.includes(row.id)) return undefined;
  // 平台条件：模板只编码了「仅 win32」与「仅 posix」两种，其它表达式在生成期已失败。
  if (row.platform !== undefined && row.platform !== platform) return undefined;

  const entry = {};
  if (row.id !== undefined) entry.id = row.id;
  if (row.name !== undefined) entry.name = row.name;
  if (row.group === true) entry.group = true;
  if (row.isolate !== undefined) entry.isolate = row.isolate;
  if (Array.isArray(row.config)) {
    const children = row.config.map(child => materializeRow(child, platform, { readOnly })).filter(Boolean);
    // 空组没有意义，直接省略，避免留下一个什么都没有的 group 行。
    if (children.length === 0) return undefined;
    entry.config = children;
  } else if (row.config !== undefined) {
    entry.config = { ...row.config };
  }
  if (row.disabled === true) entry.disabled = true;

  // 只读角色的 fs：保留读取与读图，关掉写入与编辑。
  if (readOnly && row.id === FS_ROW_ID) {
    entry.config = { ...(entry.config ?? {}), read: true, readImage: true, write: false, edit: false };
  }
  return entry;
}

/**
 * 组装一个角色子代理的 Agent Preset 定义。
 *
 * @param {object} role - 规范化后的角色。
 * @param {object} options - 选项。
 * @param {string} [options.platform] - 目标平台，默认 `process.platform`。
 * @param {number} options.maxDepth - 第一层之外**额外**可用的层数。
 * @param {object[]} [options.roles] - 全部角色，用于生成嵌套派发入口。
 * @param {object[]} [options.rows] - 行模板；默认读取生成物。
 * @returns {{id: string, name: string, description: string, plugins: object[]}} preset 定义。
 */
export function buildRolePreset(role, options = {}) {
  const platform = options.platform ?? process.platform;
  const rows = options.rows ?? loadRowTemplate().rows;
  const isCli = role.backend === CLI_BACKEND;
  // ⚠️ CLI 角色**不再需要 preset**：顶层与嵌套都直接派发后台任务，没有任何东西会 spawn 它。
  //    中继子代理退役后，这份 preset（包裹 persona + 专属 CLI 工具行）整体失去意义。
  if (isCli) return undefined;

  // 该角色可以继续派发出去的角色（只有允许嵌套时才有）。
  const nested = role.allowNestedDispatch
    ? (options.roles ?? []).filter(item => item.id !== role.id)
    : [];
  const delegateToolNames = nested.map(item => item.toolName);

  const permissions = dispatchPermissionsFor(role, {
    delegateToolNames,
    availableToolNames: options.availableToolNames ?? [],
  });

  // CLI 角色不再需要 preset：顶层与嵌套都直接派发后台任务，**没有任何东西会 spawn 它**。
  // 这个分支保留为显式拒绝，避免将来有人误以为「CLI 角色也该有 preset」。
  const plugins = [];

  // ① persona：角色指令。
  //    ⚠️ 必须**替换**模板里那一行 persona，不能另加一行：同一个 preset 里两行
  //    `@deepseek-ai/dsh-persona` 会重复注册 `deployment:persona-prefix`，
  //    而该行是刻意「fails loud」的（见 dsh-persona README）。
  plugins.push({
    id: 'persona',
    name: '@deepseek-ai/dsh-persona',
    config: { prefix: role.instructions },
  });

  // ② 工具构成：复制裁剪后的 standard 清单（只读角色裁掉写入类行）。
  for (const row of rows) {
    if (row.id === 'persona') continue;
    const entry = materializeRow(row, platform, { readOnly: role.readOnly === true });
    if (entry) plugins.push(entry);
  }

  // ③ **已删除（D34）**：这里曾经还有一条 `switchboard-cli-dispatch-<role>` 宿主行，声明
  //    `config.cliDispatchFor: [CLI 目标 id…]`，让 spawn 子代理也能嵌套派发给 CLI 角色。
  //    设计上审计/评审属于**主代理**的职责，让实现者自己去叫审计违背设计直觉；CLI 角色
  //    因此是**叶子**。而且那条路从未在真机上工作过 —— 它调用的
  //    `mountCliDispatchInThisScope` 根本没有定义（悬空引用），整条 preset 条目会抛错。
  //
  // ④ 嵌套派发入口：**spawn** 目标各一行受控委派，指向对方的角色 preset。
  //    （CLI 目标不在其中：它们是叶子，由主代理直接派发。）
  for (const target of nested.filter(item => item.backend !== CLI_BACKEND)) {
    plugins.push({
      id: `switchboard-delegate-${target.id}`,
      name: '@deepseek-ai/dsh-tool-subagent',
      config: {
        provider: DELEGATION_PROVIDER,
        toolName: target.toolName,
        agentPreset: rolePresetId(target.id),
        maxDepth: absoluteDepthLimit(options.maxDepth ?? 0),
      },
    });
  }

  return {
    id: rolePresetId(role.id),
    name: `Switchboard · ${role.title ?? role.id}`,
    description: `角色 ${role.id} 的独立组合：${role.description}`,
    plugins,
  };
}

/**
 * 为一个作用域组装全部角色 preset。
 *
 * ⚠️ **CLI 角色不产出 preset**（`buildRolePreset` 对它们返回 undefined，这里过滤掉）：
 * 它们的派发不经过任何子代理，因此没有需要独立组合的 agent。
 *
 * @param {object[]} roles - 规范化后的角色列表。
 * @param {object} options - 选项，透传给 `buildRolePreset`。
 * @returns {object[]} preset 定义列表。
 */
export function buildRolePresets(roles, options = {}) {
  return roles.map(role => buildRolePreset(role, { ...options, roles })).filter(Boolean);
}
