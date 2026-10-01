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
import { buildInvocation } from './argv.js';
import { formatRunResult } from './output.js';

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
 * 构造一个角色的 CLI `SubagentProvider`。
 *
 * @param {object} spec - 构造规格。
 * @param {object} spec.role - 规范化后的角色，须含 `cli` 配置。
 * @param {Function} spec.spawn - 与 `ctx.subprocess.spawn` 同形的函数。
 * @param {Function} [spec.resolveExecutable] - 与 `ctx.subprocess.resolveExecutable` 同形。
 * @param {Function} [spec.now] - 取当前时间的函数，便于测试注入。
 * @returns {object} SubagentProvider
 */
export function createCliProvider({ role, spawn, resolveExecutable, now = () => Date.now() }) {
  const cli = role.cli;
  if (!cli) throw new Error(`角色 "${role.id}" 使用 cli 后端但缺少 cli 配置`);

  return {
    name: cliProviderNameFor(role.id),
    capabilities: { ...CLI_CAPABILITIES },
    inheritsParentContext: CLI_INHERITS_PARENT_CONTEXT,

    /**
     * 执行一次 CLI 派发。
     *
     * 返回的 `localAgent` 为 `undefined` —— 这正是 `SubagentRun` 类型允许
     * `Agent | undefined` 的用意：本 run 背后没有 DSH 子代理，只有外部进程。
     *
     * @param {object} request - `ResolvedSubagentStartRequest`。
     * @returns {Promise<object>} `SubagentRun`
     */
    async start(request) {
      const startedAt = now();
      const { text: taskText, ignoredBlocks } = promptText(request.prompt);

      // ⚠️ 角色指令必须由**本 provider 自己**前置进提示词。
      //
      // 原因：CLI provider 的 `capabilities.persona` 为 false（D7 —— 外部进程不由
      // DSH 的 persona 机制驱动），所以 dsh-tool-subagent 不会替我们注入 persona。
      // 若不在这里拼进去，CLI 子代理就完全不知道自己的角色 —— 而「带角色的子代理」
      // 正是本插件的核心。这与 builtin 后端机制不同但效果等价。
      //
      // ⚠️ **只在 stdin 模式前置**：argv 模式的值不得含换行（见 cli/argv.js 的安全
      // 约束），而角色指令几乎必然是多行的。因此在 argv 模式下，多行提示词**无法**
      // 经命令行传递 —— 这是命令行传参的固有限制，不是可以绕过的实现细节。
      // 需要多行角色的 CLI 必须支持从 stdin 读取提示词（codex 支持）。
      const withRole =
        cli.promptDelivery === 'stdin' && role.instructions && role.instructions.trim().length > 0
          ? `${role.instructions.trim()}\n\n---\n\n${taskText}`
          : taskText;

      // 可执行文件解析：优先交给调用方提供的解析器（它了解 DSH 的执行世界），
      // 失败则退回配置里的字面命令。
      let command = cli.command;
      if (typeof resolveExecutable === 'function') {
        try {
          command = await resolveExecutable(cli.command, cli.env, request.signal);
        } catch {
          // 解析失败不致命：可能是绝对路径或本就在 PATH 中，交给 spawn 去报错。
          command = cli.command;
        }
      }

      let invocation;
      try {
        invocation = buildInvocation({
          command,
          prefixArgs: cli.prefixArgs ?? [],
          args: cli.args,
          values: {
            prompt: cli.promptDelivery === 'argv' ? withRole : undefined,
            cwd: cli.cwd,
            // 模型与强度取自角色顶层，与 builtin 后端共用同一组字段（见模块文档）。
            model: role.model,
            effort: role.effort,
          },
        });
      } catch (error) {
        return failedRun(`参数模板错误：${error.message}`);
      }

      // 组装 stdio：提示词走 stdin 时用 `{ data }` 形式，一次性写入后关闭；
      // 否则 ignore，避免外部 CLI 误等输入。
      const stdinMode =
        cli.promptDelivery === 'argv' ? 'ignore' : { data: withRole };

      let handle;
      try {
        // `invocation.argv` 的 [0] 就是可执行文件，因此整条命令可直接交给 spawn。
        handle = spawn({
          argv: invocation.argv,
          cwd: cli.cwd,
          stdio: {
            stdin: stdinMode,
            stdout: { maxBytes: cli.maxOutputBytes },
            stderr: { maxBytes: cli.maxErrorBytes },
          },
          graceMs: cli.graceMs,
          signal: request.signal,
          env: cli.env,
        });
      } catch (error) {
        return failedRun(`无法启动 CLI：${error instanceof Error ? error.message : String(error)}`);
      }

      const outcome = await handle.done;
      const durationMs = now() - startedAt;
      const stdout = readCollected(handle.collected?.stdout);
      const stderr = readCollected(handle.collected?.stderr);

      const formatted = formatRunResult({
        roleId: role.id,
        command: invocation.argv[0],
        argv: invocation.argv,
        exitCode: outcome.exitCode,
        signal: outcome.signal,
        timedOut: request.signal?.aborted === true,
        stdout,
        stderr,
        durationMs,
      });

      const notes = [];
      if (ignoredBlocks.length > 0) {
        notes.push(`忽略了 ${ignoredBlocks.length} 个非文本提示块（${[...new Set(ignoredBlocks)].join(', ')}）`);
      }
      if (formatted.ok && stdout.trim().length === 0) {
        notes.push('CLI 成功退出但没有输出内容');
      }
      const diagnostic = notes.length > 0 ? notes.join('；') : undefined;

      return {
        id: request.parent?.id ?? `cli-${role.id}`,
        localAgent: undefined,
        result: Promise.resolve({
          output: [{ type: 'text', text: formatted.text }],
          structured: { cliRoute: formatted.route, exitCode: outcome.exitCode },
          diagnostic,
          stopReason: formatted.ok ? 'completed' : 'error',
        }),
        dispose: async () => {},
      };
    },
  };
}

/**
 * 从一个「收集型」输出读取器里取出全部文本。
 *
 * `SubprocessOutputReader` 是**偏移式且非消费型**的：`readFrom(fromByte)` 返回
 * 自该偏移起的内容与下一偏移。这里从 0 读到末尾，因此得到完整输出。
 *
 * @param {{ readFrom: (from: number) => { text: string, nextOffset: number, lossy: boolean } } | undefined} reader
 *   输出读取器。
 * @returns {string} 收集到的文本。
 */
function readCollected(reader) {
  if (!reader || typeof reader.readFrom !== 'function') return '';
  let offset = 0;
  const chunks = [];
  // 有界循环：即使实现异常返回不前进的偏移也不会死循环。
  for (let guard = 0; guard < 10_000; guard++) {
    const read = reader.readFrom(offset);
    if (!read || typeof read.text !== 'string') break;
    chunks.push(read.text);
    if (typeof read.nextOffset !== 'number' || read.nextOffset <= offset) break;
    offset = read.nextOffset;
  }
  return chunks.join('');
}

/**
 * 构造一个「启动前就失败」的 run，使错误以 `stopReason: 'error'` 的正常结果回传，
 * 而不是抛出后让工具层去猜。
 *
 * @param {string} message - 失败说明。
 * @returns {object} SubagentRun
 */
function failedRun(message) {
  return {
    id: 'cli-provider-error',
    localAgent: undefined,
    result: Promise.resolve({
      output: [{ type: 'text', text: `[switchboard] CLI 派发未能启动：${message}` }],
      diagnostic: message,
      stopReason: 'error',
    }),
    dispose: async () => {},
  };
}
