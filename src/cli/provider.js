/**
 * CLI 子代理后端：把本地命令行代理（codex / claude / grok 等）包装成
 * DSH 的 `SubagentProvider`。
 *
 * 设计依据：
 *   - `SubagentProvider` / `SubagentRun` / `SubagentResult` 的契约见
 *     docs/architecture.md 第 3 节。
 *   - `SubagentStartRequest` **没有沙箱字段**，所以角色的「只读」只能靠
 *     `toolFilter`（builtin 后端）或 CLI 自己的沙箱参数（cli 后端）表达。
 *   - 每个 CLI 角色注册**自己的** provider 实例（名字含角色 id）：单一 provider
 *     无法区分是哪个角色发起的调用，而角色级命令/模型/强度必须各不相同。
 *
 * ⚠️ 本模块的 `capabilities` 刻意全部为 false —— 见 docs/decisions.md D7：
 *   受管外部进程无法强制递归上限、无法透传 DSH 的 AgentOptions、无法约束外部
 *   CLI 的工具集。谎报能力会让工具层按支持的方式调用而对端并不支持。
 *
 * ⚠️ 占位符 `{model}` / `{effort}` 取自**角色顶层的** `role.model` / `role.effort`，
 *   而不是 `role.cli.*`。理由是这两个值只应有一个来源：同一个字段在 builtin 后端
 *   下是 DSH 的 route model，在 cli 后端下是外部 CLI 的模型 id —— 两者都是
 *   「这个角色用哪个模型」，只是命名空间不同（D12）。若再引入 `cli.model`，
 *   同一个角色就会出现两个模型字段，必然产生「改了 A 没生效」的困惑。
 *
 * @module @magicvr/dsh-agent-switchboard/cli/provider
 */
import { runCli } from './runner.js';

/**
 * 一个 CLI 角色对应的 provider 实例名。
 *
 * ⚠️ 必须与 `roles.js` 的 `cliProviderName()` 保持一致：工具实例的 `provider`
 * 字段由那里生成，注册名由这里生成，两者不一致会导致工具装载期找不到 provider。
 * 该一致性由 `scripts/check-cli.mjs` 的断言锁住（两处实现都引用同一条格式）。
 *
 * @param {string} roleId - 角色 id。
 * @returns {string} provider 名。
 */
export function cliProviderNameFor(roleId) {
  return `switchboard-cli-${roleId}`;
}

/** 本 provider 声明的能力集：全部为 false，理由见模块文档与 D7。 */
export const CLI_CAPABILITIES = Object.freeze({
  agentOptions: false,
  outputSchema: false,
  depthLimit: false,
  toolFilter: false,
  persona: false,
});

/** 外部进程不继承父会话上下文。 */
export const CLI_INHERITS_PARENT_CONTEXT = false;

/**
 * 从 `SubagentStartRequest.prompt`（ContentBlock[]）里取出纯文本提示词。
 *
 * 只取 `text` 块：外部 CLI 无法接收 DSH 的 image/file 块，遇到时明确忽略而不是
 * 悄悄丢弃类型信息。
 *
 * @param {unknown} prompt - `prompt` 字段。
 * @returns {{ text: string, ignoredBlocks: string[] }} 文本与被忽略的块类型。
 */
export function promptText(prompt) {
  if (!Array.isArray(prompt)) return { text: '', ignoredBlocks: [] };
  const parts = [];
  const ignoredBlocks = [];
  for (const block of prompt) {
    if (block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    } else if (block && typeof block === 'object' && typeof block.type === 'string') {
      ignoredBlocks.push(block.type);
    }
  }
  return { text: parts.join('\n'), ignoredBlocks };
}

/**
 * 将可复用执行器包装成角色级 SubagentProvider；此处不拥有进程资源。
 * spec 可含 role / spawn / resolveExecutable / routeSummary / now / onOutput。
 */
export function createCliProvider(spec) {
  const { role } = spec;
  if (!role.cli) throw new Error(`角色 "${role.id}" 使用 cli 后端但缺少 cli 配置`);
  return {
    name: cliProviderNameFor(role.id),
    capabilities: { ...CLI_CAPABILITIES },
    inheritsParentContext: CLI_INHERITS_PARENT_CONTEXT,
    async start(request) {
      const { text, ignoredBlocks } = promptText(request.prompt);
      const result = await runCli({ ...spec, prompt: text, signal: request.signal });
      const notes = [];
      if (ignoredBlocks.length > 0) {
        notes.push(`忽略了 ${ignoredBlocks.length} 个非文本提示块（${[...new Set(ignoredBlocks)].join(', ')}）`);
      }
      if (result.ok && !result.stdout.trim()) notes.push('CLI 成功退出但没有输出内容');
      if (result.diagnostic) notes.push(result.diagnostic);
      return {
        id: request.parent?.id ?? `cli-${role.id}`,
        localAgent: undefined,
        result: Promise.resolve({
          output: [{ type: 'text', text: result.text }],
          structured: { cliRoute: result.route, exitCode: result.exitCode, status: result.status,
            stdoutTruncated: result.stdoutTruncated ?? false, stderrTruncated: result.stderrTruncated ?? false },
          diagnostic: notes.length ? notes.join('；') : undefined,
          stopReason: result.status === 'cancelled' ? 'aborted' : result.ok ? 'completed' : 'error',
        }),
        // start 前台等待执行器完成；返回时所有进程资源已经收尾。
        dispose: async () => {},
      };
    },
  };
}
