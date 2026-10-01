// CLI provider 的离线验证：注入 fake spawn，不调用任何真实 CLI。
// 用法：node scripts/check-cli-provider.mjs
import {
  CLI_CAPABILITIES,
  CLI_INHERITS_PARENT_CONTEXT,
  createCliProvider,
  promptText,
} from '../src/cli/provider.js';
import { existsSync } from 'node:fs';

let pass = 0;
let fail = 0;
function check(label, condition, detail = '') {
  if (condition) {
    pass++;
    console.log(`  PASS  ${label}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}
function section(title) {
  console.log(`\n=== ${title} ===`);
}

/** 造一个只含 text 块的 prompt。 */
const textPrompt = (t) => [{ type: 'text', text: t }];

/**
 * 造一个可控的 fake spawn。返回句柄与「被调用记录」。
 *
 * @param {object} plan - 计划好的结果。
 * @returns {{ spawn: Function, calls: object[] }}
 */
function makeSpawn(plan = {}) {
  const calls = [];
  const spawn = (spec) => {
    calls.push(spec);
    const stdout = plan.stdout ?? '';
    const stderr = plan.stderr ?? '';
    return {
      stdin: undefined,
      stdout: undefined,
      stderr: undefined,
      control: undefined,
      collected: {
        stdout: {
          readFrom: (from) => ({
            text: from === 0 ? stdout : '',
            nextOffset: from === 0 ? stdout.length : from,
            lossy: false,
          }),
        },
        stderr: {
          readFrom: (from) => ({
            text: from === 0 ? stderr : '',
            nextOffset: from === 0 ? stderr.length : from,
            lossy: false,
          }),
        },
      },
      done: Promise.resolve({ exitCode: plan.exitCode ?? 0, signal: plan.signal ?? null }),
      terminate() {},
      waitForExit: async () => true,
    };
  };
  return { spawn, calls };
}

/** 一个合法的 cli 角色（默认 stdin 模式，codex 形态）。 */
function codexRole(overrides = {}) {
  return {
    id: 'scout',
    toolName: 'delegate_to_scout',
    backend: 'cli',
    model: 'gpt-6-luna',
    effort: 'medium',
    readOnly: true,
    cli: {
      promptDelivery: 'stdin',
      command: 'C:/node.exe',
      prefixArgs: ['C:/codex.js'],
      args: ['exec', '-s', 'read-only', '-m', '{model}', '-c', 'model_reasoning_effort={effort}', '-'],
      cwd: 'C:/work',
      graceMs: 3000,
      ...overrides,
    },
  };
}

section('promptText');
{
  const a = promptText(textPrompt('hello'));
  check('单文本块', a.text === 'hello' && a.ignoredBlocks.length === 0);

  const b = promptText([
    { type: 'text', text: 'a' },
    { type: 'text', text: 'b' },
  ]);
  check('多文本块以换行连接', b.text === 'a\nb', JSON.stringify(b.text));

  const c = promptText([
    { type: 'text', text: 'keep' },
    { type: 'image', attachment: {} },
    { type: 'file', attachment: {} },
  ]);
  check('忽略非文本块但如实记录类型', c.text === 'keep' && c.ignoredBlocks.join(',') === 'image,file', JSON.stringify(c));

  check('非数组输入 → 空', promptText(undefined).text === '' && promptText('nope').text === '');
  check('无 text 字段的块被忽略', promptText([{ type: 'text' }]).text === '');
}

section('provider 元信息');
{
  const { spawn } = makeSpawn();
  const p = createCliProvider({ role: codexRole(), spawn });
  check('provider 名含角色 id', p.name === 'switchboard-cli-scout', p.name);
  check('capabilities 全为 false', Object.values(p.capabilities).every((v) => v === false));
  check('capabilities 与导出常量一致', JSON.stringify(p.capabilities) === JSON.stringify(CLI_CAPABILITIES));
  check('不继承父上下文', p.inheritsParentContext === false && CLI_INHERITS_PARENT_CONTEXT === false);
  check('缺少 cli 配置时抛错', (() => {
    try {
      createCliProvider({ role: { id: 'x' }, spawn });
      return false;
    } catch {
      return true;
    }
  })());
}

section('argv 与 stdio：stdin 模式');
{
  const role = codexRole();
  const { spawn, calls } = makeSpawn({ stdout: 'ANSWER', exitCode: 0 });
  const p = createCliProvider({ role, spawn });
  const run = await p.start({ prompt: textPrompt('the task'), parent: { id: 'parent-1' } });

  check('spawn 被调用一次', calls.length === 1);
  const spec = calls[0];
  // argv[0] 是可执行文件，其后是 prefixArgs（node 形态下是脚本路径），再后是模板。
  check('argv[0] 是可执行文件', spec.argv[0] === 'C:/node.exe', JSON.stringify(spec.argv));
  check('prefixArgs 紧随其后', spec.argv[1] === 'C:/codex.js', JSON.stringify(spec.argv));
  // 占位符取自**角色顶层**的 model/effort（同一字段在 builtin 后端下是 DSH route，
  // 在 cli 后端下是外部 CLI 的模型 id —— 命名空间不同但只应有一个来源，见 D12）。
  check('role.model 占位符已替换', spec.argv.includes('gpt-6-luna'), JSON.stringify(spec.argv));
  check('role.effort 占位符已替换', spec.argv.includes('model_reasoning_effort=medium'), JSON.stringify(spec.argv));
  check('stdin 模式：提示词不进 argv', !spec.argv.includes('the task'), JSON.stringify(spec.argv));
  check('stdin 模式：提示词经 stdin 传入', JSON.stringify(spec.stdio.stdin) === JSON.stringify({ data: 'the task' }));
  check('cwd 来自配置', spec.cwd === 'C:/work');
  check('graceMs 来自配置', spec.graceMs === 3000);
  check('传入了 abort signal 字段', 'signal' in spec);

  const result = await run.result;
  check('run.localAgent 为 undefined', run.localAgent === undefined);
  check('成功 → stopReason completed', result.stopReason === 'completed', result.stopReason);
  check('正文回传', result.output[0].text.includes('ANSWER'));
  check('structured 含退出码', result.structured.exitCode === 0);
  check('dispose 可调用', typeof run.dispose === 'function');
}

section('argv 与 stdio：argv 模式');
{
  const role = codexRole({ promptDelivery: 'argv', args: ['-p', '{prompt}'] });
  const { spawn, calls } = makeSpawn({ stdout: 'OK' });
  const p = createCliProvider({ role, spawn });
  await (await p.start({ prompt: textPrompt('task text') })).result;

  check('argv 模式：提示词进入 argv', calls[0].argv.includes('task text'), JSON.stringify(calls[0].argv));
  check('argv 模式：stdin 为 ignore', calls[0].stdio.stdin === 'ignore');
}

section('argv 与 stdio：promptFile 模式');
{
  // 为什么需要这个模式：`argv` 模式把提示词当命令行参数，而**参数值不得含换行**
  // （见 cli/argv.js），真实提示词几乎都是多行的。`promptFile` 把提示词写进临时文件、
  // 只把**路径**放进 argv，从而绕开该限制。grok 就依赖它（`--prompt-file`）。
  const role = codexRole({ promptDelivery: 'promptFile', args: ['--prompt-file', '{prompt}'] });
  const { spawn, calls } = makeSpawn({ stdout: 'OK' });
  const p = createCliProvider({ role, spawn });
  // 刻意用**多行**提示词：这正是 argv 模式会失败的输入。
  await (await p.start({ prompt: textPrompt('第一行\n第二行') })).result;

  const argv = calls[0].argv;
  const fileIdx = argv.indexOf('--prompt-file');
  check('promptFile 模式：含 --prompt-file', fileIdx !== -1, JSON.stringify(argv));
  const path = fileIdx === -1 ? undefined : argv[fileIdx + 1];
  check('promptFile 模式：其后是一个文件路径', typeof path === 'string' && path.length > 0, String(path));
  check('promptFile 模式：提示词本体**不进** argv', !argv.some((a) => a.includes('第一行')), JSON.stringify(argv));
  check(
    'promptFile 模式：路径不含换行（这正是它能绕开限制的原因）',
    typeof path === 'string' && !/[\n\r]/.test(path),
    String(path),
  );
  check('promptFile 模式：stdin 为 ignore（提示词走文件，不走 stdin）', calls[0].stdio.stdin === 'ignore');
  check('promptFile 模式：运行结束后临时文件已清理', path !== undefined && !existsSync(path), String(path));
}

section('路由事实被抽入 structured 与正文');
{
  const stderr = [
    'OpenAI Codex v0.159.2',
    '--------',
    'workdir: C:/work',
    'model: gpt-6-astra',
    'provider: openai',
    'sandbox: read-only',
    'reasoning effort: high',
  ].join('\n');
  const { spawn } = makeSpawn({ stdout: 'BODY', stderr });
  const p = createCliProvider({ role: codexRole(), spawn });
  const result = await (await p.start({ prompt: textPrompt('t') })).result;

  check('structured.cliRoute.model 正确', result.structured.cliRoute.model === 'gpt-6-astra');
  check('structured.cliRoute 含 strength', result.structured.cliRoute['reasoning effort'] === 'high');
  check('正文含路由事实（可审计）', result.output[0].text.includes('gpt-6-astra'));
}

section('失败语义');
{
  const { spawn } = makeSpawn({ exitCode: 1, stdout: '', stderr: 'stream error: model not found' });
  const p = createCliProvider({ role: codexRole(), spawn });
  const result = await (await p.start({ prompt: textPrompt('t') })).result;

  check('非零退出 → stopReason error', result.stopReason === 'error', result.stopReason);
  check('正文含退出码', result.output[0].text.includes('exit=1'));
  check('正文保留 stderr', result.output[0].text.includes('model not found'));
  check('正文说明失败原因', result.output[0].text.includes('失败原因'));
}

section('参数模板错误：在启动前失败，不 spawn');
{
  const role = codexRole({ args: ['exec', '{modle}', '-'] });
  const { spawn, calls } = makeSpawn();
  const p = createCliProvider({ role, spawn });
  const result = await (await p.start({ prompt: textPrompt('t') })).result;

  check('未调用 spawn', calls.length === 0);
  check('stopReason error', result.stopReason === 'error');
  check('正文说明模板错误', result.output[0].text.includes('参数模板错误'), result.output[0].text);
}

section('spawn 抛错：转为可读失败而非抛出');
{
  const p = createCliProvider({
    role: codexRole(),
    spawn: () => {
      throw new Error('ENOENT: 找不到可执行文件');
    },
  });
  const result = await (await p.start({ prompt: textPrompt('t') })).result;
  check('stopReason error', result.stopReason === 'error');
  check('正文含原始错误', result.output[0].text.includes('ENOENT'));
}

section('resolveExecutable 的使用与回退');
{
  // 解析成功：应该用解析结果替换配置里的命令名。
  const { spawn, calls } = makeSpawn({ stdout: 'x' });
  const p = createCliProvider({
    role: codexRole({ command: 'codex' }),
    spawn,
    resolveExecutable: async (cmd) => `RESOLVED(${cmd})`,
  });
  await (await p.start({ prompt: textPrompt('t') })).result;
  check('使用解析后的路径', calls[0].argv[0] === 'RESOLVED(codex)', calls[0].argv[0]);

  // 解析失败：回退到配置的字面值，不应中断派发。
  const s2 = makeSpawn({ stdout: 'x' });
  const p2 = createCliProvider({
    role: codexRole({ command: 'codex' }),
    spawn: s2.spawn,
    resolveExecutable: async () => {
      throw new Error('lookup failed');
    },
  });
  const r2 = await (await p2.start({ prompt: textPrompt('t') })).result;
  check('解析失败时回退到字面命令', s2.calls[0].argv[0] === 'codex', s2.calls[0].argv[0]);
  check('回退后仍成功', r2.stopReason === 'completed');
}

section('非文本提示块被如实报告');
{
  const { spawn } = makeSpawn({ stdout: 'x' });
  const p = createCliProvider({ role: codexRole(), spawn });
  const result = await (
    await p.start({ prompt: [{ type: 'text', text: 'T' }, { type: 'image', attachment: {} }] })
  ).result;
  check('diagnostic 记录被忽略的块', typeof result.diagnostic === 'string' && result.diagnostic.includes('image'), String(result.diagnostic));
}

section('成功但无输出：如实标注');
{
  const { spawn } = makeSpawn({ exitCode: 0, stdout: '' });
  const p = createCliProvider({ role: codexRole(), spawn });
  const result = await (await p.start({ prompt: textPrompt('t') })).result;
  check('stopReason 仍为 completed', result.stopReason === 'completed');
  check('diagnostic 标注无输出', typeof result.diagnostic === 'string' && result.diagnostic.includes('没有输出内容'), String(result.diagnostic));
}

section('角色指令被前置进提示词');
{
  // CLI provider 的 persona 能力为 false，因此 provider 必须自己把角色指令
  // 拼进提示词；否则 CLI 子代理不知道自己是什么角色。
  const role = codexRole();
  role.instructions = 'ROLE-INSTRUCTIONS-SENTINEL';
  const { spawn, calls } = makeSpawn({ stdout: 'x' });
  const p = createCliProvider({ role, spawn });
  await (await p.start({ prompt: textPrompt('THE TASK') })).result;

  const stdin = calls[0].stdio.stdin;
  check('提示词经 stdin 传入', typeof stdin === 'object' && typeof stdin.data === 'string');
  check('含角色指令', stdin.data.includes('ROLE-INSTRUCTIONS-SENTINEL'), stdin.data.slice(0, 120));
  check('含任务正文', stdin.data.includes('THE TASK'));
  check('角色指令在任务之前', stdin.data.indexOf('ROLE-INSTRUCTIONS-SENTINEL') < stdin.data.indexOf('THE TASK'));

  // argv 模式：角色指令**不会**被前置（多行值不得进入 argv 元素）。
  // 这是命令行传参的固有限制，不是疏漏 —— 断言把它固定下来，避免日后误以为
  // 「argv 模式也能带角色指令」。
  const role2 = codexRole({ promptDelivery: 'argv', args: ['-p', '{prompt}'] });
  role2.instructions = 'ROLE-INSTRUCTIONS-SENTINEL';
  const s2 = makeSpawn({ stdout: 'x' });
  const p2 = createCliProvider({ role: role2, spawn: s2.spawn });
  await (await p2.start({ prompt: textPrompt('THE TASK') })).result;
  check('argv 模式确实调用了 spawn', s2.calls.length === 1);
  const promptArg = s2.calls[0].argv.find((a) => a.includes('THE TASK'));
  check('argv 模式的任务正文进入 argv', typeof promptArg === 'string', String(promptArg));
  check(
    'argv 模式不前置角色指令（多行值不得进 argv，属固有限制）',
    typeof promptArg === 'string' && !promptArg.includes('ROLE-INSTRUCTIONS-SENTINEL'),
    String(promptArg),
  );

  // 多行的提示词在 argv 模式下必须被明确拒绝，而不是悄悄截断或塞进去。
  const s4 = makeSpawn({ stdout: 'x' });
  const p4 = createCliProvider({ role: role2, spawn: s4.spawn });
  const multi = await (
    await p4.start({ prompt: [{ type: 'text', text: 'line1\nline2' }] })
  ).result;
  check('argv 模式下多行提示词被拒绝且不 spawn', s4.calls.length === 0 && multi.stopReason === 'error');
  check(
    '错误信息说明是换行导致',
    multi.output[0].text.includes('换行'),
    multi.output[0].text.slice(0, 160),
  );

  // 无角色指令时不应残留分隔线。
  const role3 = codexRole();
  role3.instructions = '   ';
  const s3 = makeSpawn({ stdout: 'x' });
  const p3 = createCliProvider({ role: role3, spawn: s3.spawn });
  await (await p3.start({ prompt: textPrompt('ONLY TASK') })).result;
  check('空角色指令时不加分隔线', s3.calls[0].stdio.stdin.data === 'ONLY TASK', s3.calls[0].stdio.stdin.data);
}

// ---------------------------------------------------------------------------
// 超时：Phase 3 新实现的路径，此前完全未测。
//
// 背景：`ctx.subprocess.spawn` 的 spec **没有** `timeoutMs` 字段（实测
// dsh-bash-local 传的是 `{argv, cwd, stdio, graceMs, signal, env}`），所以超时
// 必须由 provider 自己用 AbortController + setTimeout 实现。既然是自己实现的，
// 就绝不能让它是唯一没测的失败路径 —— 验收第 4 条明确要求「超时产生可读错误」。
// ---------------------------------------------------------------------------
section('超时：provider 自己的计时器真的会中止子进程');
{
  /**
   * 一个「永不自然结束」的假 spawn：只有收到 abort 才结算。
   *
   * @returns {{spawn: Function, calls: object[], aborted: () => boolean}} 测试句柄。
   */
  function makeHangingSpawn() {
    const calls = [];
    let aborted = false;
    const spawn = (spec) => {
      calls.push(spec);
      const done = new Promise((resolve) => {
        const finish = () => {
          aborted = true;
          resolve({ exitCode: null, signal: 'SIGTERM' });
        };
        if (spec.signal?.aborted) finish();
        else spec.signal?.addEventListener('abort', finish, { once: true });
      });
      return {
        collected: {
          stdout: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
          stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
        },
        done,
        terminate() {},
        waitForExit: async () => true,
      };
    };
    return { spawn, calls, aborted: () => aborted };
  }

  const h = makeHangingSpawn();
  const p = createCliProvider({ role: codexRole(), spawn: h.spawn, timeoutMs: 20 });
  const run = await p.start({ prompt: textPrompt('HANG') });
  const result = await run.result;
  check('超时后子进程被中止（signal 收到 abort）', h.aborted());
  check('超时 → stopReason error', result.stopReason === 'error', result.stopReason);
  check(
    '超时正文含 timedOut=true',
    result.output[0].text.includes('timedOut=true'),
    result.output[0].text.slice(0, 240),
  );
  check(
    '超时正文说明原因是 timeout',
    result.output[0].text.includes('超时') || result.output[0].text.includes('timeout'),
    result.output[0].text.slice(0, 240),
  );
  check('仍有 argv 审计行（诊断不因超时丢失）', result.output[0].text.includes('[switchboard] argv='));

  // 未设超时时，计时器必须**完全不存在**：否则「默认 900 秒」会形同虚设。
  //
  // 收尾方式：用一个**稍后才 abort** 的调用方信号让 hanging spawn 结算。
  // 必须在等待窗口之后才 abort —— 若一开始就 abort，就分不清「没有被超时中止」
  // 与「被我自己的收尾中止」了。
  const h2 = makeHangingSpawn();
  const p2 = createCliProvider({ role: codexRole(), spawn: h2.spawn });
  const ac2 = new AbortController();
  const started = p2.start({ prompt: textPrompt('HANG'), signal: ac2.signal });
  // 等足够久，任何 20ms 级别的超时都会在此期间触发。
  await new Promise((r) => setTimeout(r, 60));
  check('未设超时（timeoutMs 为空）→ 不会被中止', !h2.aborted());
  ac2.abort();
  await (await started).result;
}

// ---------------------------------------------------------------------------
// 取消：验收第 6 条要求「中断主代理时子进程被终止」。此前后者完全未测。
// ---------------------------------------------------------------------------
section('取消：调用方 abort 会传到子进程，且不被误报为超时');
{
  /** @returns {{spawn: Function, aborted: () => boolean}} 测试句柄。 */
  function makeAbortableSpawn() {
    let aborted = false;
    const spawn = (spec) => {
      const done = new Promise((resolve) => {
        const finish = () => {
          aborted = true;
          resolve({ exitCode: null, signal: 'SIGTERM' });
        };
        if (spec.signal?.aborted) finish();
        else spec.signal?.addEventListener('abort', finish, { once: true });
      });
      return {
        collected: {
          stdout: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
          stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
        },
        done,
        terminate() {},
        waitForExit: async () => true,
      };
    };
    return { spawn, aborted: () => aborted };
  }

  const ac = new AbortController();
  const h = makeAbortableSpawn();
  // 刻意**不设** timeoutMs：这样 timedOut 只可能来自调用方信号。
  const p = createCliProvider({ role: codexRole(), spawn: h.spawn });
  const started = p.start({ prompt: textPrompt('CANCEL ME'), signal: ac.signal });
  ac.abort();
  const result = await (await started).result;
  check('调用方 abort → 子进程被终止', h.aborted());
  check('取消后不当作成功', result.stopReason === 'error', result.stopReason);
  check(
    '取消被如实报为 timedOut=true（信令层无法区分取消与超时，故如实标注）',
    result.output[0].text.includes('timedOut=true'),
    result.output[0].text.slice(0, 240),
  );
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
