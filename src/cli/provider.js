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
import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

/**
 * 删掉 `promptFile` 模式用的临时提示词文件。
 *
 * 刻意**吞掉失败**：清理失败不该覆盖真正的运行结果（用户更关心退出码与输出）。
 * 文件名带随机 UUID，因此即使残留也不会与别的派发相撞。
 *
 * @param {string|undefined} path - 临时文件路径；undefined 时什么都不做。
 */
function cleanupPromptFile(path) {
  if (typeof path !== 'string' || path.length === 0) return;
  try {
    rmSync(path, { force: true });
  } catch {
    /* 清理失败不影响结果 */
  }
}

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
 * @param {number} [spec.timeoutMs] - 单次 CLI 派发的超时（毫秒）。缺省或非正数表示不设超时。
 * @param {Function} [spec.now] - 取当前时间的函数，便于测试注入。
 * @returns {object} SubagentProvider
 */
export function createCliProvider({
  role,
  spawn,
  resolveExecutable,
  timeoutMs,
  /**
   * 线路摘要，形如 `backend=cli(codex) model=… effort=…`，会出现在回传日志里。
   *
   * ⚠️ **由调用方传入，不在本模块里算**：`routeSummaryFor` 住在 `roles.js`，
   * 而 `roles.js` 已经 import 了本模块（它要用 `createCliProvider`）—— 在这里再
   * import 回去就成环。交给调用方（它本来就有 role 与那个函数）是最省事且无环的做法。
   */
  routeSummary,
  now = () => Date.now(),
}) {
  const cli = role.cli;
  if (!cli) throw new Error(`角色 "${role.id}" 使用 cli 后端但缺少 cli 配置`);

  const timeout = typeof timeoutMs === 'number' && timeoutMs > 0 ? timeoutMs : undefined;

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
      // ⚠️ **`argv` 模式例外**：该模式下提示词作为**命令行参数**传入，而参数值不得含换行
      // （见 cli/argv.js 的安全约束），角色指令几乎必然是多行的，塞进去只会让整次派发
      // 以「占位符值含换行」失败。因此在 `argv` 模式下不前置角色指令 ——
      // 这是命令行传参的固有限制。**要用带角色的 CLI 派发，就别用 `argv` 模式**
      // （用 `stdin`，或 CLI 支持从文件读时的 `promptFile`）。
      const canCarryRole = cli.promptDelivery === 'stdin' || cli.promptDelivery === 'promptFile';
      const withRole =
        canCarryRole && role.instructions && role.instructions.trim().length > 0
          ? `${role.instructions.trim()}\n\n---\n\n${taskText}`
          : taskText;

      // `promptFile`：把提示词写进临时文件，模板里的 `{prompt}` 取值为**该文件路径**。
      //
      // 为什么需要这个模式：`argv` 模式的提示词不能含换行，而绝大多数真实提示词是多行的
      // —— 实测 grok 用 `-p <多行提示词>` 直接报
      // 「占位符 {prompt} 的值含换行或 NUL」。grok 支持 `--prompt-file <PATH>`，
      // 于是把提示词落到文件、只把路径放进 argv，限制就绕开了。
      let promptFilePath;
      if (cli.promptDelivery === 'promptFile') {
        try {
          promptFilePath = join(tmpdir(), `switchboard-prompt-${randomUUID()}.txt`);
          writeFileSync(promptFilePath, withRole, 'utf8');
        } catch (error) {
          return failedRun(
            `无法写入提示词临时文件：${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

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
            // `argv` 传提示词本身；`promptFile` 传的是**文件路径**（不含换行，天然安全）。
            prompt:
              cli.promptDelivery === 'argv'
                ? withRole
                : cli.promptDelivery === 'promptFile'
                  ? promptFilePath
                  : undefined,
            cwd: cli.cwd,
            // 模型与强度取自角色顶层，与 builtin 后端共用同一组字段（见模块文档）。
            model: role.model,
            effort: role.effort,
          },
        });
      } catch (error) {
        cleanupPromptFile(promptFilePath);
        return failedRun(`参数模板错误：${error.message}`);
      }

      // 组装 stdio：提示词走 stdin 时用 `{ data }` 形式，一次性写入后关闭；
      // 否则 ignore，避免外部 CLI 误等输入。
      const stdinMode =
        cli.promptDelivery === 'stdin' ? { data: withRole } : 'ignore';

      let handle;
      // 单次派发的超时。
      //
      // ⚠️ 为什么必须自己做：`ctx.subprocess.spawn` 的 spec **没有** `timeoutMs`
      //    字段（实测 dsh-bash-local 传给 spawn 的是 `{argv, cwd, stdio, graceMs,
      //    signal, env}`，它是用自带的 deadline 辅助融合超时与中止信号的）。
      //    在本实现之前，`cliTimeoutSec` 声明了却从未被读取，`timedOut` 只反映
      //    调用方是否中止 —— 一个不响应的 CLI 会一直挂到调用方放弃为止。
      //
      // 用 `AbortSignal.any` 把「调用方中止」与「我们自己的超时」融合成一个信号；
      // 再用 `timedOutByUs` 区分二者，避免把调用方主动取消误报成超时。
      const controller = typeof AbortController === 'function' ? new AbortController() : undefined;
      let timer;
      let timedOutByUs = false;
      if (timeout !== undefined && controller !== undefined) {
        timer = setTimeout(() => {
          timedOutByUs = true;
          controller.abort(new Error(`CLI 派发超过 ${timeout}ms 未结束`));
        }, timeout);
      }
      const callerSignal = request.signal;
      const combinedSignal =
        controller === undefined
          ? callerSignal
          : callerSignal === undefined
            ? controller.signal
            : typeof AbortSignal.any === 'function'
              ? AbortSignal.any([callerSignal, controller.signal])
              : // 无 AbortSignal.any 时退化为「谁先中止用谁」，功能上等价。
                controller.signal;

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
          signal: combinedSignal,
          env: cli.env,
        });
      } catch (error) {
        if (timer !== undefined) clearTimeout(timer);
        cleanupPromptFile(promptFilePath);
        return failedRun(`无法启动 CLI：${error instanceof Error ? error.message : String(error)}`);
      }

      const outcome = await handle.done;
      if (timer !== undefined) clearTimeout(timer);
      // 提示词临时文件已经用不上了（进程已结束），尽早删掉。
      cleanupPromptFile(promptFilePath);
      const durationMs = now() - startedAt;
      const stdout = readCollected(handle.collected?.stdout);
      const stderr = readCollected(handle.collected?.stderr);

      const formatted = formatRunResult({
        roleId: role.id,
        command: invocation.argv[0],
        argv: invocation.argv,
        // 与系统提示词里的路由指引**同一套措辞**，这样主代理能把
        // 「本该走哪条线路」与「实际走了哪条」直接对上。由调用方传入，以免 provider 依赖角色配置。
        routeSummary,
        exitCode: outcome.exitCode,
        signal: outcome.signal,
        timedOut: timedOutByUs || request.signal?.aborted === true,
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
