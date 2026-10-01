/**
 * Agent Switchboard 的 Host 半边。
 *
 * Phase 1 的唯一目标：**证明这个包能被 DSH 装载**。
 * 因此这里刻意不实现任何派发逻辑，只做可被外部观测到的事：
 * 注册一个自检工具，让 `cordis_inspect_query`(Tool) 能读到工具注册面。
 *
 * 至此已实测确认的两条装载期事实（都写进 docs/decisions.md）：
 *   1. `@deepseek-ai/*`（schemastery / dsh-tools 等）**可以被外部插件 import**——
 *      它们由 dsh 安装处以「双锚点解析」供给，尽管它们在磁盘上不存在于 profile。
 *   2. `dsh-tools` 对 schema 只接受**受限 JSON Schema 子集**：`required` 必须是
 *      **属性名字符串数组**，不能写成 `{ required: true }` 这种字段级布尔标记。
 *
 * @module @magicvr/dsh-agent-switchboard
 */
import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';

/** Loader 条目名，与 package.json 的 `name` 保持一致。 */
export const name = 'agent-switchboard';

/**
 * 声明式依赖。Cordis 会等到这些 Service 就绪后再调用 `apply`。
 * Phase 1 只依赖 `tools`；Phase 2 会加入 `subagents`、`agents`。
 */
export const inject = ['tools'];

/**
 * 插件配置。
 *
 * ⚠️ 关键约定：**要能在 GUI 设置页里实时编辑的字段必须标 `.volatile()`**，
 * 因为 `dsh-settings` 只暴露 volatile 字段（见 docs/decisions.md D9）。
 * 本插件把这一类运行时旋钮集中放在 `volatile` 子对象里，与声明式的角色列表区分开。
 */
export const Config = z.object({
  volatile: z
    .object({
      /** 跨 CLI 派发的总开关。默认关闭：开启后插件会真的在本机执行外部命令。 */
      allowCrossCli: z.boolean().default(false).description('允许把角色派发给本机外部 CLI（会执行本地命令）'),
      /** 单次 CLI 派发的超时（秒）。Phase 3 使用。 */
      cliTimeoutSec: z.number().step(1).min(1).default(900).description('单次 CLI 派发的超时（秒）'),
    })
    .default({}),
});

/**
 * 自检工具：把「插件确实被装载且工具注册面可用」变成可被外部查询到的事实。
 *
 * 形状严格遵循 `dsh-tools` 的受限 JSON Schema 子集：
 * `required` 是属性名数组，而不是字段上的 `required: true`。
 *
 * @param {object} config - 已通过 `Config` 校验的配置。
 * @returns {object} ToolDefinition
 */
function selftestTool(config) {
  const volatile = config?.volatile ?? {};
  return defineTool({
    name: 'switchboard_selftest',
    description:
      'Report whether the DSH Agent Switchboard plugin is loaded and answering. ' +
      'Takes no arguments and has no side effects. Used to verify plugin activation.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          plugin: { type: 'string' },
          phase: { type: 'string' },
          marker: { type: 'string' },
          allowCrossCli: { type: 'boolean' },
        },
        required: ['ok', 'plugin', 'phase', 'marker', 'allowCrossCli'],
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: `Agent Switchboard ${value.plugin} · ${value.phase} · allowCrossCli=${value.allowCrossCli} · marker=${value.marker}`,
        },
      ],
    },
    execute() {
      return Promise.resolve({
        ok: true,
        plugin: name,
        phase: 'phase-1',
        marker: 'switchboard-online',
        allowCrossCli: volatile.allowCrossCli === true,
      });
    },
    presentCall: () => ({
      card: 'generic',
      title: 'Agent Switchboard self-test',
      kind: 'other',
    }),
  });
}

/**
 * 插件入口。
 *
 * 所有资源都在这里注册；Cordis 负责在插件卸载/HMR 时回收。
 *
 * @param {object} ctx - Cordis 上下文。
 * @param {object} config - 已校验的配置。
 */
export function apply(ctx, config) {
  ctx.tools.register(selftestTool(config));
}
