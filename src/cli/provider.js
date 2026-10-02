/**
 * 角色专属 CLI 工具。保留历史文件名，旧 SubagentProvider 路径已移除。
 * 注册时绑定角色配置；模型只能提供任务正文，不能改命令、模板或权限。
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { StringDecoder } from 'node:string_decoder';
import { cliToolName, routeSummaryFor } from '../roles.js';
import { validateTemplate } from './argv.js';
import { validateCliPreset } from './drivers.js';
import { runCli } from './runner.js';

/** 按 UTF-8 字节截断，不返回半个字符；tail 用于错误尾部。 */
function bounded(text, limit, tail = false) {
  const bytes = Buffer.from(text ?? '');
  if (bytes.length <= limit) return { text: bytes.toString('utf8'), truncated: false };
  let start = tail ? bytes.length - limit : 0;
  // 尾部从完整字符开始，头部通过 StringDecoder 丢弃末尾不完整字符。
  while (tail && start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
  return { text: new StringDecoder('utf8').write(bytes.subarray(start, tail ? bytes.length : limit)),
    truncated: true };
}

/** 构造工具，不注册 provider；spawn 与解析器由同一 preset 实例注入。 */
export function createCliTool({ role, getRole, spawn, resolveExecutable, ctx = { get: () => undefined } }) {
  const initialRole = role;
  if (!initialRole?.cli) throw new Error(`角色 "${initialRole?.id}" 使用 cli 后端但缺少 cli 配置`);
  const currentRole = () => {
    const value = typeof getRole === 'function' ? getRole() : initialRole;
    if (!value?.cli) throw new Error(`角色 "${initialRole.id}" 使用 cli 后端但缺少 cli 配置`);
    const preset = value.cliDriver === undefined
      ? { errors: validateTemplate(value.cli.args, { promptDelivery: value.cli.promptDelivery }) }
      : validateCliPreset({
        cliDriver: value.cliDriver, readOnly: value.readOnly,
        cliCommand: value.cli.command, cliPrefixArgs: value.cli.prefixArgs,
        cliArgs: value.cli.args, cliPromptDelivery: value.cli.promptDelivery,
      });
    if (preset.errors.length > 0) throw new Error(`CLI 角色 "${value.id}" 配置无效：${preset.errors.join('；')}`);
    return structuredClone(value);
  };
  const cli = initialRole.cli;
  return defineTool({
    name: cliToolName(initialRole.id),
    description: `仅供子代理转交 ${initialRole.id} 角色的完整 CLI 任务；等待结束后返回有界结果。`,
    parameters: {
      prompt: { type: 'string', required: true, description: '完整任务正文；不要改写角色规则或命令。' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          status: { type: 'string', required: true },
          exitCode: { oneOf: [{ type: 'number' }, { type: 'null' }], required: true },
          signal: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
          cancelled: { type: 'boolean', required: true },
          outputFeedback: { type: 'string', required: true },
          routeSummary: { type: 'string', required: true },
          routeSummaryTruncated: { type: 'boolean', required: true },
          stdout: { type: 'string', required: true },
          stderr: { type: 'string', required: true },
          stdoutTruncated: { type: 'boolean', required: true },
          stderrTruncated: { type: 'boolean', required: true },
          diagnostic: { type: 'string', required: true },
          diagnosticTruncated: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      if (exec?.agent?.session?.header?.origin !== 'subagent') {
        throw new Error('专属 CLI 工具仅供子代理执行；请通过对应 delegate_to_* 工具派发任务');
      }
      if (typeof args?.prompt !== 'string') throw new Error('prompt 必须是字符串');
      const boundRole = currentRole();
      const currentCli = boundRole.cli;
      const controller = new AbortController();
      // 调用方停止、Jobs 面板取消及 owner 销毁共用同一取消入口。
      const cancel = reason => { if (!controller.signal.aborted) controller.abort(reason); };
      const onAbort = () => cancel(exec.signal.reason);
      if (exec.signal?.aborted) onAbort();
      else exec.signal?.addEventListener('abort', onAbort, { once: true });
      let execution;
      let outputFeedback = 'unavailable';
      let feedbackDiagnostic = '实时输出回流不可用：Jobs 服务未加载';
      let jobs;
      let result;
      // 三个独立完成点：执行器完成（进程结果确定、输出排空、必要清理完成）、
      // Jobs 结算、客户端读完。后两者不是工具返回的必要条件。
      // 共享执行完成 Promise 先清理调用方监听器，再供工具与 JobHooks.done 使用。
      const run = onOutput => runCli({ role: boundRole, prompt: args.prompt, spawn,
        resolveExecutable, signal: controller.signal, onOutput })
        .finally(() => exec.signal?.removeEventListener('abort', onAbort));
      try {
        // 可选服务不进 inject；每次调用读取，以支持运行时装卸。
        jobs = ctx.get('jobs');
        if (jobs) {
          try {
            jobs.start({
              kind: 'cli', label: boundRole.title || boundRole.id, owner: exec.agent.id,
              // 仅限制模型侧的 Jobs 读取/结算通知；观察者容量由 Jobs 输出环管理。
              outputLimitBytes: 4096,
              run(job) {
                execution = run(({ stream, text, lossy }) => job.append(text,
                  { channel: stream, ...(lossy ? { gapBefore: true } : {}) }));
                return { cancel, done: execution.then(value => ({
                  status: value.cleanupFailed ? 'failed' : value.status === 'cancelled' ? 'killed'
                    : value.status === 'completed' ? 'completed' : 'failed',
                  detail: value.diagnostic || (value.exitCode == null ? value.status : `exit code: ${value.exitCode}`),
                }), () => ({ status: 'failed', detail: 'CLI 执行器失败；未能确认受管进程范围已清空' })) };
              },
            });
            outputFeedback = 'jobs';
            feedbackDiagnostic = '';
          } catch {
            // 注册表预检拒绝（例如无可用 controller）也不能阻止 CLI 执行。
            feedbackDiagnostic = '实时输出回流不可用：Jobs 注册失败';
          }
        }
        execution ??= run();
        result = await execution;
      } finally {
        // ctx.get / 注册在执行前抛错时也释放监听器；正常路径已由共享 Promise 清理。
        exec.signal?.removeEventListener('abort', onAbort);
        // 所有终态都不主动 remove，留给客户端按偏移延后读取。
        // 记录交由 Jobs 的保留策略处理（未核实），不改 owner、不延时删除。
      }
      const stdout = bounded(result.stdout, currentCli.maxOutputBytes ?? 1_000_000);
      // 失败路径可能追加诊断，再次限额；返回 stderr 尾部，路由事实已由 runner 提取。
      const stderr = bounded(result.stderrTail ?? result.stderr, currentCli.maxErrorBytes ?? 100_000, true);
      const route = bounded(`${routeSummaryFor(boundRole)}；cli-route=${JSON.stringify(result.route)}`, 4096);
      const diagnostic = bounded([result.diagnostic ?? (result.ok && !result.stdout.trim()
        ? 'CLI 成功退出但没有输出内容' : ''), feedbackDiagnostic].filter(Boolean).join('\n'), 4096);
      return {
        status: result.status, exitCode: result.exitCode, signal: result.signal ?? null,
        cancelled: result.status === 'cancelled', outputFeedback,
        routeSummary: route.text, routeSummaryTruncated: route.truncated,
        stdout: stdout.text, stderr: stderr.text,
        stdoutTruncated: result.stdoutTruncated === true || stdout.truncated,
        stderrTruncated: result.stderrTruncated === true || stderr.truncated,
        diagnostic: diagnostic.text, diagnosticTruncated: result.diagnosticTruncated === true || diagnostic.truncated,
      };
    },
  });
}
