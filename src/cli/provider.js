/**
 * 角色专属 CLI 工具的**直派**形式：把外部 CLI 起成后台任务，受理即返回。
 *
 * 历史说明：这里曾有一个阻塞式 `createCliTool`（「仅供子代理转交」的中继工具）。
 * CLI 角色改为直派后它不再被生产路径挂载，**其行为契约已降级为测试夹具**
 * （见 `scripts/check-cli-provider.mjs` 顶部的同名局部工厂）—— 那 36 条断言测的是
 * `runCli` 的执行语义（argv 构造、提示投递、流式、取消、限额），与挂载形态无关。
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { routeSummaryFor } from '../roles.js';
import { validateTemplate } from './argv.js';
import { validateCliPreset } from './drivers.js';
import { runCli } from './runner.js';

/**
 * 角色的**直派**工具：把外部 CLI 当作正常后台任务发起，**不包裹中继子代理**。
 *
 * ## 为什么不再包一层
 *
 * 旧路径是「主代理 → `delegate_to_<role>`（官方 spawn）→ **子代理** → `switchboard_cli_run_<role>`
 * → CLI」。包这层子代理（转交代理）的唯一目的是**让 CLI 输出可见**，而它自己是个真 LLM
 * agent —— 于是才需要 `wrapperProvider/Model/Effort` 去回答「它用哪个模型」。现在
 * `dsh-tool-jobs` 已能把外部进程输出显示成后台任务，并**对 owner 投递完成通知**
 * （忙的 agent 下一步注入、闲的 agent 唤醒一轮），那层壳与那三个配置项就都没有理由了。
 *
 * ## 契约
 *
 * **立即返回受理**（`{status:'accepted', jobId}`），不等 CLI 结束；结果由完成通知送达，
 * 模型用 `job_output` 读输出。因此它与 `switchboard_cli_run_<role>`（阻塞式）是两种工具，
 * 不要合并。
 *
 * ## 安装方式决定嵌套权限
 *
 * 本工具**按 agent 安装**（与官方 standing 组合一致，见 `mountCliDispatchTools`），
 * 而不是注册在 preset 作用域里。这一点是硬要求：`restrict` 只遮蔽**继承来的**工具，
 * 不隐藏同作用域注册的；若注册在 preset 作用域，嵌套子代理会继承它，
 * `allowNestedDispatch: false` 就被绕过了。
 *
 * @param {object} options - 选项。
 * @param {object} options.role - 角色（已规范化）。
 * @param {Function} options.getRole - 执行期现读该角色。
 * @param {object} options.ctx - Cordis 上下文（取 `jobs`）。
 * @param {Function} options.spawn - 受管 spawn。
 * @param {Function} options.resolveExecutable - 可执行文件解析器。
 * @returns {object} 已定义的工具。
 */
export function createCliDispatchTool({ role, getRole, ctx, spawn, resolveExecutable }) {
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
  return defineTool({
    name: initialRole.toolName ?? `delegate_to_${initialRole.id}`,
    description: `把任务作为**后台任务**直接交给 ${initialRole.id} 角色的外部 CLI：受理即返回，`
      + '完成后由后台任务完成通知送达，用 job_output 读取输出。',
    parameters: {
      prompt: { type: 'string', required: true, description: '完整任务正文；不要改写角色规则或命令。' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          status: { type: 'string', required: true },
          jobId: { type: 'string', required: true },
          role: { type: 'string', required: true },
          summary: { type: 'string', required: true },
          diagnostic: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      if (typeof args?.prompt !== 'string') throw new Error('prompt 必须是字符串');
      const boundRole = currentRole();
      const jobs = ctx.get('jobs');
      if (!jobs || typeof jobs.start !== 'function') {
        throw new Error('jobs 服务不可用：无法把外部 CLI 作为后台任务派发（缺少 @deepseek-ai/dsh-tool-jobs）');
      }
      const controller = new AbortController();
      // 调用方停止、Jobs 面板取消与 owner 销毁共用同一取消入口。
      const cancel = reason => { if (!controller.signal.aborted) controller.abort(reason); };
      const onAbort = () => cancel(exec.signal.reason);
      if (exec.signal?.aborted) onAbort();
      else exec.signal?.addEventListener('abort', onAbort, { once: true });
      let jobId = '';
      try {
        jobs.start({
          kind: 'cli', label: boundRole.title || boundRole.id, owner: exec.agent?.id,
          outputLimitBytes: 4096,
          run(job) {
            // handle 上就有 id，因此不依赖 `start` 的返回值形态。
            jobId = job.id;
            const execution = runCli({ role: boundRole, prompt: args.prompt, spawn, resolveExecutable,
              signal: controller.signal,
              onOutput: ({ stream, text, lossy }) => job.append(text,
                { channel: stream, ...(lossy ? { gapBefore: true } : {}) }) })
              .finally(() => exec.signal?.removeEventListener('abort', onAbort));
            return {
              cancel,
              done: execution.then(value => ({
                status: value.cleanupFailed ? 'failed' : value.status === 'cancelled' ? 'killed'
                  : value.status === 'completed' ? 'completed' : 'failed',
                detail: value.diagnostic || (value.exitCode == null ? value.status : `exit code: ${value.exitCode}`),
              }), () => ({ status: 'failed', detail: 'CLI 执行器失败；未能确认受管进程范围已清空' })),
            };
          },
        });
      } catch (error) {
        exec.signal?.removeEventListener('abort', onAbort);
        throw new Error(`后台任务发起失败：${error instanceof Error ? error.message : String(error)}`);
      }
      return {
        status: 'accepted', jobId, role: boundRole.id, summary: routeSummaryFor(boundRole),
        diagnostic: '已作为后台任务受理；完成后会收到完成通知，用 job_output 读取输出',
      };
    },
  });
}
