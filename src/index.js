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
import { EFFORT_VALUES, normalizeRoles, toolConfigFor } from './roles.js';

/** Loader 条目名，与 package.json 的 `name` 保持一致。 */
export const name = 'agent-switchboard';

/**
 * 声明式依赖。Cordis 会等到这些 Service 就绪后再调用 `apply`。
 * `subagents` 用于解析内置后端；`agents` 用于取发起本次调用的父代理。
 */
export const inject = ['tools', 'subagents', 'agents'];

/**
 * 装载诊断。供自检工具读取；每次 `apply` 重算。
 * @type {{ configErrors: string[], mounts: { id: string, ok: boolean, detail: string }[], fatal: string | undefined }}
 */
const diagnostics = { configErrors: [], mounts: [], fatal: undefined };

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
  /** 角色列表。 */
  roles: z
    .array(
      z.object({
        id: z.string().required(),
        title: z.string(),
        description: z.string().required(),
        provider: z.string(),
        model: z.string().required(),
        // ⚠️ schemastery **没有** `z.enum`（沿 zod 的直觉会踩坑）：枚举用 `z.union`。
        effort: z.union(EFFORT_VALUES),
        instructions: z.string().required(),
        readOnly: z.boolean().default(false),
        backend: z.union(['spawn', 'fork']).default('spawn'),
        allowNestedDispatch: z.boolean().default(false),
      }),
    )
    .default([]),
});

/**
 * 自检工具：一次调用即可看清装载结果，避免为每个问题重启一次 dsh。
 *
 * @returns {object} ToolDefinition
 */
function selftestTool() {
  return defineTool({
    name: 'switchboard_selftest',
    description:
      'Report whether the DSH Agent Switchboard plugin is loaded, which role delegation tools it ' +
      'registered, and any configuration errors. Takes no arguments and has no side effects.',
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
          configErrors: { type: 'string', required: true },
          fatal: { type: 'string', required: true },
        },
      },
      render: (_args, value) => {
        const lines = [
          `Agent Switchboard · ${value.phase}`,
          `已挂载角色工具：${value.roleCount}`,
          `明细：${value.mounted}`,
        ];
        if (value.configErrors) lines.push(`配置错误：\n${value.configErrors}`);
        if (value.fatal) lines.push(`致命错误：${value.fatal}`);
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    execute() {
      return Promise.resolve({
        ok: diagnostics.fatal === undefined && diagnostics.configErrors.length === 0,
        phase: 'phase-2',
        roleCount: diagnostics.mounts.filter((m) => m.ok).length,
        mounted:
          diagnostics.mounts.length === 0
            ? '（无）'
            : diagnostics.mounts.map((m) => `${m.id}=${m.ok ? 'OK' : `失败(${m.detail})`}`).join(' '),
        configErrors: diagnostics.configErrors.join('\n'),
        fatal: diagnostics.fatal ?? '',
      });
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
function mountRoleTool(ctx, role, toolModule, maxDepth) {
  if (typeof ctx.plugin !== 'function') {
    return { ok: false, detail: 'ctx.plugin 不可用' };
  }
  try {
    ctx.plugin(toolModule, toolConfigFor(role, { maxDepth }));
    return { ok: true, detail: '已挂载' };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * 插件入口。
 *
 * @param {object} ctx - Cordis 上下文。
 * @param {object} [config] - 已校验的配置。
 */
export function apply(ctx, config) {
  const resolved = config ?? {};
  diagnostics.configErrors = [];
  diagnostics.mounts = [];
  diagnostics.fatal = undefined;

  // 自检工具总是注册：即使角色配置全错，也要能用它看到错在哪。
  ctx.tools.register(selftestTool());

  const { roles, errors } = normalizeRoles(resolved.roles, resolved.provider);
  diagnostics.configErrors = errors;
  if (errors.length > 0) {
    // 配置有错时不挂载任何角色工具：半挂载会让主代理看到一批语义不明的工具。
    console.error(`[${name}] 角色配置有 ${errors.length} 处错误，未挂载任何角色工具：`);
    for (const line of errors) console.error(`[${name}]   - ${line}`);
    return;
  }
  if (roles.length === 0) return;

  const maxDepth = typeof resolved.maxDepth === 'number' ? resolved.maxDepth : 3;

  // 动态 import：把「工具包取不到」变成可上报的诊断，而不是整个插件激活失败。
  import('@deepseek-ai/dsh-tool-subagent')
    .then((toolModule) => {
      for (const role of roles) {
        const outcome = mountRoleTool(ctx, role, toolModule, maxDepth);
        diagnostics.mounts.push({ id: role.id, ok: outcome.ok, detail: outcome.detail });
        if (!outcome.ok) console.error(`[${name}] 角色 "${role.id}" 挂载失败：${outcome.detail}`);
      }
      const okCount = diagnostics.mounts.filter((m) => m.ok).length;
      console.error(
        `[${name}] 已挂载 ${okCount}/${roles.length} 个角色工具：${roles.map((r) => r.toolName).join(', ')}`,
      );
    })
    .catch((error) => {
      diagnostics.fatal = `无法 import @deepseek-ai/dsh-tool-subagent：${
        error instanceof Error ? error.message : String(error)
      }`;
      console.error(`[${name}] ${diagnostics.fatal}`);
    });
}
