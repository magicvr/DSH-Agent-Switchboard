/**
 * 角色专属 CLI 工具。保留历史文件名，旧 SubagentProvider 路径已移除。
 * 注册时绑定角色配置；模型只能提供任务正文，不能改命令、模板或权限。
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { StringDecoder } from 'node:string_decoder';
import { cliToolName, routeSummaryFor } from '../roles.js';
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
export function createCliTool({ role, spawn, resolveExecutable, ctx = { get: () => undefined } }) {
  if (!role.cli) throw new Error(`角色 "${role.id}" 使用 cli 后端但缺少 cli 配置`);
  // 保存配置快照，调用参数和外部对象变更均不能改变已绑定的执行边界。
  const boundRole = structuredClone(role);
  const cli = boundRole.cli;
  const outputLimit = cli.maxOutputBytes ?? 1_000_000;
  const errorLimit = cli.maxErrorBytes ?? 100_000;
  return defineTool({
    name: cliToolName(boundRole.id),
    description: `仅供子代理转交 ${boundRole.id} 角色的完整 CLI 任务；等待结束后返回有界结果。`,
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
      const controller = new AbortController();
      // 调用方停止、Jobs 面板取消及 owner 销毁共用同一取消入口。
      const cancel = reason => { if (!controller.signal.aborted) controller.abort(reason); };
      const onAbort = () => cancel(exec.signal.reason);
      if (exec.signal?.aborted) onAbort();
      else exec.signal?.addEventListener('abort', onAbort, { once: true });
      let jobId;
      let execution;
      let unsubscribe;
      let settledJob;
      let outputFeedback = 'unavailable';
      let feedbackDiagnostic = '实时输出回流不可用：Jobs 服务未加载';
      let jobs;
      let result;
      const run = onOutput => runCli({ role: boundRole, prompt: args.prompt, spawn,
        resolveExecutable, signal: controller.signal, onOutput });
      try {
        // 可选服务不进 inject；每次调用读取，以支持运行时装卸。
        jobs = ctx.get('jobs');
        if (jobs) {
          try {
            // 不用有有限等待期限的 jobs.wait；监听结算避免 remove 与注册表结算竞态。
            settledJob = new Promise(resolve => {
              unsubscribe = jobs.events.subscribe({ owner: exec.agent.id }, event => {
                if (event.type === 'settled' && event.job.id === jobId) resolve();
              });
            });
            jobId = jobs.start({
              kind: 'cli', label: boundRole.title || boundRole.id, owner: exec.agent.id,
              // 仅限制模型侧的 Jobs 读取/结算通知；观察者容量由 Jobs 输出环管理。
              outputLimitBytes: 4096,
              run(job) {
                execution = run(({ stream, text, lossy }) => job.append(text,
                  { channel: stream, ...(lossy ? { gapBefore: true } : {}) }));
                return { cancel, done: execution.then(value => ({
                  status: value.status === 'cancelled' ? 'killed'
                    : value.status === 'completed' ? 'completed' : 'failed',
                  detail: value.exitCode == null ? value.status : `exit code: ${value.exitCode}`,
                }), () => ({ status: 'failed', detail: 'CLI 执行器失败' })) };
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
        exec.signal?.removeEventListener('abort', onAbort);
        if (jobId !== undefined) {
          await settledJob;
          try { jobs.remove(jobId, exec.agent.id); }
          catch { feedbackDiagnostic = '实时输出任务记录清理不可用（可能已随会话销毁）'; }
        }
        unsubscribe?.();
      }
      const stdout = bounded(result.stdout, outputLimit);
      // 失败路径可能追加诊断，再次限额；返回 stderr 尾部，路由事实已由 runner 提取。
      const stderr = bounded(result.stderrTail ?? result.stderr, errorLimit, true);
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
        diagnostic: diagnostic.text, diagnosticTruncated: diagnostic.truncated,
      };
    },
  });
}
